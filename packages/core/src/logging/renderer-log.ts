/**
 * Shared, dependency-free helpers for capturing renderer/browser `console`
 * output into the on-disk pino logs. Consumed by both capture sites — the
 * modules that turn raw console text into a log record — so they agree on
 * credential scrubbing, level mapping, structured-message unwrapping, and
 * batch bounds:
 *   - Electron main `console-message` listener (`packages/desktop/src/main/renderer-console-capture.ts`)
 *   - web renderer forwarder (`packages/app/src/lib/install-client-log-forwarder.ts`)
 *
 * The server's `/api/client-logs` ingest handler
 * (`packages/server/src/api-extension.ts`) is downstream of the web forwarder,
 * not a capture site: it receives entries the forwarder already scrubbed and
 * schema-validated. `renderer-capture-scrub-coverage.test.ts` sweeps every
 * caller of these primitives and fails on one that skips the scrub.
 *
 * Browser+Node safe (no deps) — lives in core alongside `schemas/api/*`.
 */

import { scrubSecrets } from './secret-scrub.ts';

export type RendererLogLevel = 'info' | 'warn' | 'error';

/** Max console entries accepted per ingest batch (server Zod cap + client ring). */
export const RENDERER_LOG_MAX_ENTRIES = 100;

/**
 * Max length of a single console message; longer messages are truncated. This
 * is a code-unit (UTF-16 length) budget, not a strict UTF-8 byte count — the
 * generous batch margin below absorbs the difference for multibyte content.
 */
export const RENDERER_LOG_MAX_MESSAGE_BYTES = 8192;

/**
 * Soft cap on a single POST batch payload (code units), set at half the
 * browser's ~64 KB `keepalive` limit. Combined with the per-entry message +
 * fields caps (so no single entry is huge), this keeps batches well under the
 * limit for typical mostly-ASCII console output. A pathological all-multibyte
 * batch (3x UTF-8 expansion) could still exceed the limit and be dropped by the
 * browser on an unload flush — acceptable for this best-effort diagnostics path.
 */
export const RENDERER_LOG_MAX_BATCH_BYTES = 32_768;

/** Suffix appended by `truncateLogMessage`; reserved within the message cap. */
const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Map a console level token to the renderer pino level, or `null` to drop it.
 * Input is the Electron `console-message` level (`'info' | 'warning' | 'error'
 * | 'debug'`); `'warn'`/`'log'` are accepted defensively for forward-compat
 * with Chromium level names. `debug`/`verbose`/unknown return `null` so callers
 * drop them (keeps log volume bounded). The web forwarder maps its own console
 * method names separately and does not call this.
 */
export function mapConsoleLevel(level: string): RendererLogLevel | null {
  switch (level) {
    case 'error':
      return 'error';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'info':
    case 'log':
      return 'info';
    default:
      return null;
  }
}

/**
 * Field names the log record's own producer owns, stripped from a renderer
 * payload before it is lifted.
 *
 * Both capture sites already spread renderer fields first so their provenance
 * markers win. These are the names that defence cannot reach, because they are
 * not added by the capture site at all:
 *   - `level`, `time`, `pid`, `hostname`, `name`, `runtime` — pino writes the
 *     first two at serialize time and the rest as child bindings, all BEFORE
 *     the merge object. A collision reaches the file as a repeated key,
 *     harmless until something parses the line — and the bundle redactor
 *     round-trips every line through `JSON.parse`, which is last-key-wins, so
 *     the renderer's value silently becomes the permanent one. pino orders it
 *     this way deliberately, so that a logged object can take precedence.
 *   - `msg` — the mirror image, and the reason this list is not simply "pino's
 *     keys": pino appends it LAST, so last-key-wins keeps pino's message and
 *     the renderer's field is the one that vanishes. Stripped anyway, because a
 *     duplicate key that never wins is still a duplicate key, and a first-wins
 *     parser reading the same file would resolve it the other way.
 *   - `subsystem` — worse. The desktop logger merges as `{ subsystem, ...data }`,
 *     so a renderer field of that name wins in plain JS before pino runs: no
 *     duplicate key at all, just a record silently re-filed under another
 *     subsystem, which is the field triage greps on first.
 *
 * Stripped HERE, at the one chokepoint both transports call, rather than at each
 * emitter: a producer-side denylist has to be kept in sync by hand with two
 * logger configs it cannot see, and nothing would fail when one of them adds a
 * binding. Emitters may still filter for a clearer local contract, but this is
 * what makes the guarantee hold for a bare `console.info(JSON.stringify(...))`
 * written by someone who never finds the helper.
 *
 * Sources of truth for the list: `packages/desktop/src/main/desktop-logger.ts`
 * and `packages/server/src/logger.ts`.
 */
export const LOGGER_OWNED_FIELDS = [
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'name',
  'runtime',
  'subsystem',
  // The server logger's OTel mixin. Pino resolves a mixin key in the merge
  // object's favour, so these behave like `subsystem` rather than like `level`:
  // the renderer's value wins outright. Their whole job is to let a triager
  // jump from a log line to the trace that produced it, so a breadcrumb
  // carrying one would re-file the line against a trace that does not contain
  // it — a wrong pointer, which is worse than a missing one.
  'trace_id',
  'span_id',
  'trace_flags',
] as const;

/**
 * Best-effort unwrap of a structured console message. The renderer emits many
 * events as `console.warn(JSON.stringify({ event, ...fields }))` (e.g.
 * provider-pool's `ok-provider-*` events). Lifting those into pino object
 * fields makes them greppable and lets pino's path-based `redact` mask the
 * denylisted keys it covers (top-level + one level of nesting).
 *
 * Scrubs its own input, so a caller may pass the raw message. Truncate first if
 * the payload needs bounding; scrubbing twice is a no-op, every replacement
 * token being a fixed point.
 *
 * Returns `null` when the message is not a JSON object.
 */
export function parseStructuredConsoleMessage(
  message: string,
): { event: string | undefined; fields: Record<string, unknown> } | null {
  // Scrubbed over the SERIALIZED text, before the parse. That reaches strings at
  // every depth and object keys as well, and it is the only point at which the
  // patterns anchored on the JSON wire form can fire: `"authorization":"Bearer …"`
  // is recognizable only while the delimiters are still there, and once parsed
  // the key and the value are separate objects no pattern can relate.
  //
  // This order is safe on one condition, which `secret-scrub.ts` has to keep: NO
  // PATTERN BODY MAY CROSS A `"`. Every structural delimiter in
  // `JSON.stringify` output is separated from string content by a quote, so a
  // body that cannot cross one cannot leave the value it matched in. A body that
  // can is not a leaked credential but a mangled record — either a field
  // silently deleted from a line that still parses, or nothing parseable at all,
  // costing the event name and every field.
  const trimmed = scrubSecrets(message).trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  for (const key of LOGGER_OWNED_FIELDS) delete fields[key];
  return { event: typeof fields.event === 'string' ? fields.event : undefined, fields };
}

/**
 * Truncate a message so the result stays within `RENDERER_LOG_MAX_MESSAGE_BYTES`
 * code units INCLUDING the suffix — the server schema enforces the same cap, so
 * an over-long result would get the whole batch rejected (400) and dropped.
 */
export function truncateLogMessage(message: string): string {
  if (message.length <= RENDERER_LOG_MAX_MESSAGE_BYTES) return message;
  return `${message.slice(0, RENDERER_LOG_MAX_MESSAGE_BYTES - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/**
 * Turn a raw console message into the text a capture site may hand to a sink:
 * scrub credentials, then bound the length. Every capture site goes through
 * this (or `scrubSecrets` directly) — a verbatim console string reaches the log
 * file with no keyed-field redaction in front of it, so the scrub cannot be
 * left to a downstream layer.
 *
 * Scrub BEFORE truncating: a secret straddling the cap would otherwise be cut
 * mid-token, stop matching its pattern, and ship its surviving prefix.
 */
export function prepareCapturedConsoleMessage(message: string): string {
  return truncateLogMessage(scrubSecrets(message));
}
