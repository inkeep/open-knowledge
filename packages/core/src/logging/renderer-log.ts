/**
 * Shared, dependency-free helpers for capturing renderer/browser `console`
 * output into the on-disk pino logs. Consumed by all three capture sites so
 * they agree on level mapping, structured-message unwrapping, and batch bounds:
 *   - Electron main `console-message` listener (`packages/desktop/src/main/renderer-console-capture.ts`)
 *   - server `/api/client-logs` ingest handler (`packages/server/src/api-extension.ts`)
 *   - web renderer forwarder (`packages/app/src/lib/install-client-log-forwarder.ts`)
 *
 * Browser+Node safe (no deps) — lives in core alongside `schemas/api/*`.
 */

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
 * denylisted keys it covers (top-level + one level of nesting). NOTE: this is
 * NOT a full secret scrub — a raw (non-JSON) `console.*` string is logged
 * verbatim and never redacted, and lifted fields are only masked for the fixed
 * denylist at depth <= 1. Capturing all console output is a deliberate
 * local-diagnostics tradeoff; the ship-path backstop is `bug-report`'s
 * `redactContent` pass over every bundled file. Returns `null` when the message
 * is not a JSON object.
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
