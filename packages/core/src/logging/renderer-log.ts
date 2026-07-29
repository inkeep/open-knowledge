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
 * Best-effort unwrap of a structured console message. The renderer emits many
 * events as `console.warn(JSON.stringify({ event, ...fields }))` (e.g.
 * provider-pool's `ok-provider-*` events). Lifting those into pino object
 * fields makes them greppable and lets pino's path-based `redact` mask the
 * denylisted keys it covers (top-level + one level of nesting). Call this on a
 * message already run through {@link prepareCapturedConsoleMessage}: pino's
 * keyed `redact` only masks the fixed denylist at depth <= 1, so a credential
 * in any other field (or in a plain non-JSON string) is only removed by the
 * capture-time scrub. Returns `null` when the message is not a JSON object.
 */
export function parseStructuredConsoleMessage(
  message: string,
): { event: string | undefined; fields: Record<string, unknown> } | null {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
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
