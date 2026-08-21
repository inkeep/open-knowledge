/**
 * Canonical structured-log shape for IPC failure paths.
 *
 * Mirrors the HTTP `errorResponse(...)` discipline (RFC 9457) at
 * the IPC transport. Every IPC handler that returns `{ ok: false; reason }`
 * (or `{ ok: false; error }`) emits a `logIpcError(...)` call on the same
 * code path, producing a payload that downstream consumers (file tail,
 * structured-pipeline) can index by channel + reason + handler.
 *
 * TWO legs, and which one a field reaches is the whole design:
 *
 *   - the PINO leg writes `~/.ok/logs/desktop.*.log`, the file collected into
 *     the diagnostic bundles reporters send us. This is the leg that has to
 *     answer "why did it fail" for someone whose machine we cannot read, and
 *     it is therefore the leg that must never carry a path, a credential, or
 *     free-form user text.
 *   - the CONSOLE leg emits one JSON line on main-process stdio. It carries
 *     the unbounded context (message, stack) because a developer tailing a
 *     terminal wants it — but nothing captures stdio in a packaged app
 *     launched from Finder, so anything that reaches ONLY this leg is, for
 *     support purposes, unrecorded.
 *
 * The single JSON line per console call keeps multi-line stdio interleaving
 * deterministic; the `event: 'ipc.error'` discriminant lets downstream filters
 * separate IPC failures from arbitrary stdout noise.
 *
 * The meta-test at
 * `packages/app/tests/integration/ipc-log-coverage.test.ts` gates that
 * every IPC handler return of shape `{ ok: false; reason }` is preceded
 * by a `logIpcError(...)` call within `IPC_LOG_ADJACENCY_MAX_STATEMENTS`
 * statements above (block-local). New handlers fail the build until they
 * adopt the discipline.
 */

import { getLogger } from './desktop-logger.ts';

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
 *   safely instead of throwing — see `normalizeCause` below. It reaches the
 *   console leg WHOLE; the pino leg gets only the bounded facts derived from
 *   it by `boundedCauseFacts` (the error's class and its errno), because the
 *   message and stack cannot be written into a bundle handed to support.
 * - `details` is optional BOUNDED context, and the two differ by destination
 *   rather than by taste. `cause` reaches the console only: it carries stacks
 *   and free-form text, which is exactly what you want when tailing a terminal
 *   and exactly what must not be indexed. `details` additionally reaches the
 *   pino file logger, which is collected into user-submitted diagnostic
 *   bundles — so it takes only primitives whose value set is bounded by
 *   construction (a step name, an errno, a status code, a host). Never put a
 *   path, a signed URL, a document body, or a raw error message here; the
 *   cardinality discipline that governs span attributes governs this field
 *   for the same reason.
 */
interface IpcErrorLogPayload {
  readonly event: 'ipc.error';
  readonly channel: string;
  readonly reason: string;
  readonly handler: string;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
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
 * Links of an `Error.cause` chain walked when looking for an errno. undici
 * hangs the real transport error one level below its opaque
 * `TypeError: fetch failed`; a handful of links is slack for a wrapper or two
 * above that without letting a long chain turn a log call into a traversal.
 */
const CAUSE_CHAIN_MAX_DEPTH = 5;

/**
 * The bounded half of a `cause` — the part that may reach the pino leg.
 *
 * A failed IPC call reached a diagnostic bundle as one line carrying a channel,
 * a handler, and a single reason token: enough to know that something failed,
 * never enough to know what. The cause was captured and normalized at the
 * boundary, then emitted only to stdio, which a packaged app records nowhere.
 * These two fields are the ones that can close that gap without breaking the
 * bounded-value contract the pino leg is held to:
 *
 * - `errName` — the error's CLASS. Bounded by the set of constructors in play.
 * - `errCode` — the errno, which is what separates "this machine cannot
 *   resolve the host" from "the host refused the connection" from "the
 *   certificate is not valid yet". Bounded by the platform's errno table.
 *
 * The errno needs the chain walk rather than a direct `code` read: undici
 * reports every transport failure as the same opaque `TypeError: fetch failed`
 * and hangs the real error one level down in `cause`, so reading `code` off the
 * caught value yields nothing on exactly the failures worth triaging.
 *
 * Deliberately omits `message` and `stack`. A stack carries absolute paths out
 * of the reporter's home directory, and an errno message carries the file that
 * could not be opened or the URL that could not be reached — both are exactly
 * what must not be written into a file a reporter hands to support. They stay
 * on the console leg, where the audience is a developer at a terminal.
 *
 * Cycle-safe and depth-bounded for the same reason `normalizeCause` is: the
 * caller passes a raw caught value of unknown shape, and a hostile one must not
 * be able to turn a log call into a hang or a stack overflow.
 */
function boundedCauseFacts(cause: unknown): Record<string, string> {
  const facts: Record<string, string> = {};
  if (cause instanceof Error) facts.errName = cause.name;

  const seen = new Set<unknown>();
  let cursor: unknown = cause;
  for (
    let depth = 0;
    depth < CAUSE_CHAIN_MAX_DEPTH && cursor !== null && cursor !== undefined;
    depth += 1
  ) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      facts.errCode = code;
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return facts;
}

/**
 * Emit an IPC failure to both structured-log surfaces.
 *
 * The console leg uses `console.warn(JSON.stringify(...))` for compatibility
 * with Electron's stderr capture and any file-tail-based structured-pipeline
 * consumer (`bunyan -P`, `vector`, etc.).
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

  // Derived BEFORE the emit below rather than inside its try/catch. A cause
  // hostile to inspection (a throwing getter, a cyclic chain) must cost its own
  // two fields and nothing else — swallowing the whole line would leave the
  // failure with no record at all, which is worse than the bare line this
  // derivation exists to improve on.
  let causeFacts: Record<string, string> = {};
  if (payload.cause !== undefined) {
    try {
      causeFacts = boundedCauseFacts(payload.cause);
    } catch {}
  }

  try {
    getLogger('ipc').warn(
      // Derived facts first, then `details`, then the canonical discriminants:
      // a handler that classified its own failure knows more than a generic
      // walk of the caught value, and a caller that passes `channel` in its
      // details cannot rewrite the field consumers index on.
      {
        ...causeFacts,
        ...payload.details,
        channel: payload.channel,
        handler: payload.handler,
        reason: payload.reason,
      },
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

/**
 * Preserve an unexpected main-process failure before Electron serializes the
 * rejection down to its message for the invoking renderer.
 */
export async function withIpcErrorLogging<T>(
  payload: Omit<IpcErrorLogPayload, 'event' | 'cause'>,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    logIpcError({ event: 'ipc.error', ...payload, cause });
    throw cause;
  }
}
