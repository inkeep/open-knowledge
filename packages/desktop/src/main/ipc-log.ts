/**
 * Canonical structured-log shape for IPC failure paths.
 *
 * Mirrors the HTTP `errorResponse(...)` discipline (RFC 9457) at
 * the IPC transport. Every IPC handler that returns `{ ok: false; reason }`
 * (or `{ ok: false; error }`) emits a `logIpcError(...)` call on the same
 * code path, producing a JSON-shaped console.warn line that downstream
 * consumers (Sentry breadcrumbs, file tail, structured-pipeline) can index
 * by channel + reason + handler.
 *
 * Why not Pino: adding Pino to Electron main has build-graph
 * implications (electron-vite externalizeDeps + main bundle entry), and
 * the existing per-module Logger interfaces in `mcp-wiring.ts`
 * (`McpWiringLogger`) and `auto-updater.ts` (`Logger`) already use a
 * JSON-shaped `console.warn` + structured payload pattern. This module
 * is the canonical declaration so all 42 channels speak the same shape.
 *
 * Why structured + JSON-on-console: keeps the host-process bridge simple
 * (Electron's stderr/stdout pipe + standard log capture pattern) while
 * giving consumers a parseable shape. The `event: 'ipc.error'` discriminant
 * lets downstream filters separate IPC failures from arbitrary stdout noise.
 *
 * The meta-test at
 * `packages/app/tests/integration/ipc-log-coverage.test.ts` gates that
 * every IPC handler return of shape `{ ok: false; reason }` is preceded
 * by a `logIpcError(...)` call within `IPC_LOG_ADJACENCY_MAX_STATEMENTS`
 * statements above (block-local). New handlers fail the build until they
 * adopt the discipline.
 */

/**
 * Canonical IPC failure-event payload. Internal type — `logIpcError`
 * below is the public surface. Consumers infer the parameter shape from
 * the function signature; if a future site needs the type as a standalone
 * import, re-export then.
 *
 * Fields match HTTP-side conventions where possible:
 * - `event: 'ipc.error'` is the discriminant (parallel to HTTP's `event:'api.error.malformed-envelope'`).
 * - `channel` is the IPC channel name (e.g., `'ok:shell:spawn-cursor'`).
 * - `reason` is the discriminated-union token returned to the renderer
 *   (e.g., `'not-installed'`); for channels that return free-form
 *   `{ error: string }`, the error string is used as the reason field.
 * - `handler` is the function name in main process source (e.g.,
 *   `'spawnCursor'`) — provides grep-anchor when triaging.
 * - `cause` is optional structured context (Error object, additional
 *   metadata). Normalized at the boundary so Error instances preserve
 *   message + name + stack on the wire and circular references degrade
 *   safely instead of throwing — see `normalizeCause` below.
 */
interface IpcErrorLogPayload {
  readonly event: 'ipc.error';
  readonly channel: string;
  readonly reason: string;
  readonly handler: string;
  readonly cause?: unknown;
}

/**
 * Normalize a `cause` value to a JSON-serialization-safe shape.
 *
 * Three failure modes the canonical log shape must defend against:
 *
 *   1. **Error instances lose all content under `JSON.stringify`.** Error's
 *      `message`, `name`, and `stack` are non-enumerable, so
 *      `JSON.stringify(new Error('boom'))` returns `'{}'`. Sites in
 *      `mcp-wiring.ts` (and any future handler that catches an unknown and
 *      passes `cause: err`) would silently emit `{"cause":{}}` —
 *      losing the very triage context the observability discipline exists
 *      to preserve. Normalizing Errors to a plain object with the
 *      load-bearing fields keeps the wire shape useful.
 *
 *   2. **Circular references at the object level throw.**
 *      `JSON.stringify` on a cyclic structure throws `TypeError: cannot
 *      serialize cyclic structures`. The outer `logIpcError` try/catch
 *      around `JSON.stringify` catches plain-object cycles and emits a
 *      degraded-but-safe line (`_causeSerializationFailed: true`) so the
 *      structured shape (event/channel/reason/handler) still reaches the
 *      log surface.
 *
 *   3. **Circular references in chained Error.cause stack-overflow.**
 *      `cause.cause` (ES2022 chained errors) is recursed into for Error
 *      instances. A self-referential chain (`a.cause = b; b.cause = a`)
 *      would recurse infinitely and throw `RangeError: Maximum call stack
 *      size exceeded`. That throw fires SYNCHRONOUSLY from inside this
 *      function — BEFORE `logIpcError`'s try/catch wraps `JSON.stringify`
 *      — so without a per-call visited tracker the RangeError escapes the
 *      caller entirely. The `seen` WeakSet detects the cycle and emits
 *      `'<circular>'` as the chained `cause` value, keeping the wire shape
 *      useful and the function call total.
 */
function normalizeCause(cause: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (cause instanceof Error) {
    if (seen.has(cause)) {
      // Cycle detected — return the load-bearing fields without recursing
      // further. `cause: '<circular>'` marks the wire shape so a future
      // operator triaging the log line can recognize the truncation.
      return {
        name: cause.name,
        message: cause.message,
        stack: cause.stack,
        cause: '<circular>',
      };
    }
    seen.add(cause);
    // Preserve the load-bearing fields explicitly so they survive
    // JSON.stringify (which by default elides non-enumerable properties).
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      ...(cause.cause !== undefined ? { cause: normalizeCause(cause.cause, seen) } : {}),
    };
  }
  return cause;
}

/**
 * Emit an IPC failure to the structured-log surface.
 *
 * Uses `console.warn(JSON.stringify(...))` for compatibility with Electron's
 * stderr capture, Sentry's breadcrumb capture, and any file-tail-based
 * structured-pipeline consumer (`bunyan -P`, `vector`, etc.). The single
 * JSON line per call keeps multi-line stdio interleaving deterministic.
 *
 * `cause` is normalized at this boundary (Error instances → plain objects;
 * circular references → degraded-but-safe). Callers can pass any
 * `unknown` (typically a raw caught `err`) and the wire shape stays useful
 * regardless of the input class.
 *
 * `JSON.stringify` already elides `undefined` values from output, so the
 * absence/presence of the `cause` field on the wire matches the absence/
 * presence at the call site without further branching.
 */
export function logIpcError(payload: IpcErrorLogPayload): void {
  const normalized: IpcErrorLogPayload =
    payload.cause !== undefined ? { ...payload, cause: normalizeCause(payload.cause) } : payload;

  try {
    const { getLogger } = require('./desktop-logger.ts');
    getLogger('ipc').warn(
      { channel: payload.channel, handler: payload.handler, reason: payload.reason },
      `IPC error: ${payload.channel} — ${payload.reason}`,
    );
  } catch {}

  try {
    console.warn(JSON.stringify(normalized));
  } catch {
    // Circular reference (or other structuredClone-class hostility, e.g.
    // BigInt) escaped `normalizeCause` — emit a degraded-but-safe line
    // dropping the cause but preserving the structured event/channel/reason/
    // handler shape so the log still reaches the surface and the IPC
    // handler's catch block isn't bypassed.
    const { cause: _omit, ...safe } = payload;
    console.warn(JSON.stringify({ ...safe, _causeSerializationFailed: true }));
  }
}
