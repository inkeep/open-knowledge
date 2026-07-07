/**
 * RFC 9457 Problem Details error-response helper.
 *
 * Single sanctioned site for emitting HTTP error bodies from
 * `api-extension.ts` handlers. Constructs a typed
 * `ProblemDetails` body, validates it against `ProblemDetailsSchema`,
 * sets `Content-Type: application/problem+json`, generates a UUID
 * `instance` correlation ID when caller doesn't pass one,
 * increments the `ok.api.error.count` telemetry counter,
 * and emits a Pino structured log line (`log.warn` for 4xx, `log.error`
 * for 5xx) with the same `instance` value for grep correlation between
 * the HTTP response and the structured log.
 *
 * Defense-in-depth floor — runtime backstops for every wire-emit point so
 * compile-time gaps degrade to typed problem+json envelopes rather than
 * truncated responses or process crashes:
 *   1. `headersSent || writableEnded || destroyed` triple-guard on sync emit
 *      paths; `writableEnded || destroyed` on streaming-writer emit (mid-stream
 *      `headersSent === true` is the expected state, not a double-write).
 *   2. `safeParse` fallback on `ProblemDetailsSchema` (errorResponse).
 *   3. `safeParse` fallback on `StreamingProblemEventSchema` (streaming).
 *   4. Spread-order defense for `extensions` (canonical body wins on collision).
 *   5. Spread-order defense for `extraHeaders` (security headers win).
 *   6. Pre-stringify guard on `wireBody` — circular refs, `BigInt`, cause-chain
 *      cycles caught BEFORE `writeHead` so the client never sees a half-sent
 *      response. Mirrored in `success-response.ts` for symmetric coverage.
 *   7. `try`/`catch` around streaming-writer `res.write` (race-window backstop).
 *
 * Inline `json(res, NNN, { ok: false, error: '...' })` calls are not
 * permitted in `api-extension.ts`, and inline `json(res, NNN, { ok: true, ... })`
 * success wrappers are not permitted either (the RFC 9457 wire shape drops
 * the `ok: true` wrapper from success bodies). `error-envelope-coverage.test.ts` runs in
 * fail-on-any-occurrence mode: it AST-scans `api-extension.ts` for both
 * inline patterns and fails the build with file:line + handler name on any
 * match. New handlers go through `withValidation(...) + errorResponse(...)`
 * from day one.
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemType,
  type StreamingProblemEvent,
  StreamingProblemEventSchema,
} from '@inkeep/open-knowledge-core';
import type { Counter } from '@opentelemetry/api';
import { getLogger } from '../logger.ts';
import { getMeter } from '../telemetry.ts';

// Lazy logger accessor — `loggerFactory.configure()` (used by capture-logger
// tests in `server-factory.test.ts` and `logger.test.ts`) clears the
// factory's instance cache. A module-level `const log = getLogger('http')`
// captures the pre-configure instance and becomes a stale reference for
// the rest of the test process. `getLogger('http')` is itself a Map.get
// against the singleton factory — calling it per-emission is free.
const log = (): ReturnType<typeof getLogger> => getLogger('http');

/**
 * Closed union of HTTP status codes valid for `errorResponse(...)` and
 * `streamingProblemEvent(...)`. Mirrors what `ProblemDetailsSchema` accepts
 * (`int 400-599`) but tightens the surface to status codes actually used or
 * sanctioned in this codebase, so an out-of-range literal (e.g. `200`) is a
 * compile-time error rather than a runtime `safeParse` fallback to
 * `urn:ok:error:internal-server-error`. Adding a new status code is the same
 * friction model as adding a new `ProblemType` URN — extend the union here
 * and the schema range covers it automatically.
 */
export type HttpErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 408
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504
  | 507;

// Lazy-init so the counter registers against a real meter post-initTelemetry
// (not the pre-init no-op). Mirrors the `hintEmittedCounter` pattern in
// `api-extension.ts`.
let _apiErrorCounter: Counter | null = null;
export function apiErrorCounter(): Counter {
  _apiErrorCounter ||= getMeter().createCounter('ok.api.error.count', {
    description: 'API error responses by problem type and handler',
    unit: '1',
  });
  return _apiErrorCounter;
}

interface ErrorResponseOptions {
  /** Optional handler attribute for telemetry (`ok.api.error.count{handler}`). */
  handler?: string;
  /** Optional pre-generated correlation ID. Defaults to a fresh UUID. */
  instance?: string;
  /** Optional longer human-readable explanation (RFC 9457 `detail`). */
  detail?: string;
  /**
   * Optional RFC 9457 extension members merged onto the problem+json body
   * (§3.2). Use for typed structured data callers must read without parsing
   * `detail` strings (e.g. `colliding: [{existing, incoming, to}]` on
   * managed-rename collisions).
   *
   * Reserved RFC 9457 core fields (`type`/`title`/`status`/`instance`/`detail`)
   * are excluded from the type — passing them as extensions would be silently
   * dropped by the merge order, so the type-system disallows the
   * footgun at compile time.
   */
  extensions?: Record<string, unknown> & {
    [K in 'type' | 'title' | 'status' | 'instance' | 'detail']?: never;
  };
  /** Optional headers merged into the response head (e.g. `Allow:` on 405). */
  extraHeaders?: Record<string, string>;
  /**
   * Optional `cause` chain forwarded to Pino's std serializer for the log
   * line. Surfaces underlying errno / syscall on storage failures.
   */
  cause?: unknown;
}

/**
 * Subset of `ErrorResponseOptions` applicable to streaming surfaces. The NDJSON
 * streaming protocol (`{type:'progress'|'complete'|'error', ...}`) writes events
 * one per line, so per-event response headers (`extraHeaders`) are meaningless —
 * the head was already written when the stream was opened. RFC 9457 §3.2
 * extension members on the `problem` body (`extensions`) are similarly out of
 * scope: streaming sites today only carry `type/title/status/instance/detail`,
 * and adding extensions would change the wire shape mid-stream. Narrowing the
 * type here makes both omissions a compile-time guard rather than a silent drop.
 */
type StreamingErrorOptions = Pick<
  ErrorResponseOptions,
  'instance' | 'handler' | 'detail' | 'cause'
>;

/**
 * Emit an RFC 9457 Problem Details error response.
 *
 * @param res - Node HTTP response. If the head has already been written,
 *   the call is suppressed and logged (defense-in-depth against async races
 *   and programming errors at any of the ~286 call sites).
 * @param status - HTTP status code, 4xx or 5xx. Mirrored to body.status.
 * @param type - URN problem type (`urn:ok:error:<kebab>`). Closed enum.
 * @param title - Required short human-readable English summary.
 * @param options - Optional handler tag, instance UUID, detail, headers, cause.
 */
export function errorResponse(
  res: ServerResponse,
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options: ErrorResponseOptions = {},
): void {
  // RFC 9457 §3.1.6 — `instance` is a URI reference. `urn:uuid:<uuid>` is
  // the RFC 4122 URN form that satisfies the URI-reference contract while
  // remaining a single token (no slashes / path segments) so existing
  // log-grep workflows still pattern-match a flat string.
  // `ProblemDetailsSchema.instance` in core validates the prefix shape.
  const instance = options.instance ?? `urn:uuid:${randomUUID()}`;

  // Defense-in-depth: if a handler has already started writing (async race,
  // programming error at any of the ~286 call sites), `res.writeHead()`
  // would throw `ERR_HTTP_HEADERS_SENT` and lose the original error. Mirror
  // `createStreamingErrorWriter`'s `writableEnded` guard so the sync path
  // is similarly defensive. Log the suppression so the failure stays loud
  // in dev tools / production telemetry instead of silently disappearing.
  if (res.headersSent || res.writableEnded || res.destroyed) {
    log().error(
      {
        event: 'api.error.double-write',
        instance,
        type,
        status,
        handler: options.handler,
      },
      'errorResponse called after headers already sent — suppressed',
    );
    // Counter increments on the suppressed-write path too — same rationale
    // as the safeParse fallback. Operators relying on
    // `ok.api.error.count` as the sole alerting signal must see double-write
    // programming errors. Tagged `internal-server-error` (the canonical
    // bucket for server-side faults; the original `type` never reaches the
    // client because no body was emitted).
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return;
  }

  // Set `detail` explicitly (even when absent) so the spread-merge
  // overrides any caller-supplied `extensions.detail`. The TypeScript
  // `extensions` type narrows reserved keys to `never`, but a runtime
  // caller could still slip through a `detail` key — without an explicit
  // `detail: undefined` on the body, the extension's value would survive
  // the spread. `undefined` keys serialize as missing in JSON.stringify.
  const body: ProblemDetails = {
    type,
    title,
    status,
    instance,
    detail: options.detail ?? undefined,
  };
  // Defense-in-depth: validate the body against the schema. A bad
  // `errorResponse` call (e.g., empty title hitting `min(1)`) would have
  // crashed via throwing `.parse()` before any bytes left the process —
  // the original error that triggered `errorResponse` would be lost and
  // the client would get no HTTP response at all. Use `safeParse` and emit
  // a hardcoded fallback ProblemDetails so the client still gets a typed
  // response while the validation failure stays loud in logs + telemetry.
  const validated = ProblemDetailsSchema.safeParse(body);
  if (!validated.success) {
    log().error(
      {
        event: 'api.error.malformed-envelope',
        issues: validated.error.issues,
        body,
        handler: options.handler,
        originalStatus: status,
      },
      'errorResponse produced an invalid ProblemDetails body — emitting fallback',
    );
    // Override status to 500 so the fallback's `type: internal-server-error`
    // and the HTTP status agree. A malformed envelope IS a server bug;
    // emitting `internal-server-error` at the caller's original 4xx status
    // would surface a contradiction to the client (e.g., 404 with body
    // type=internal-server-error). The original status is preserved in the
    // log line for ops triage.
    const fallbackStatus = 500 as const;
    // Counter increments on the fallback path too — using the type that
    // actually goes on the wire (`internal-server-error`), not the caller's
    // original (which never escapes the process). Operators relying on
    // `ok.api.error.count` as the sole alerting signal see programming
    // errors as `internal-server-error{handler}` spikes; the structured
    // `api.error.malformed-envelope` Pino line is the grep
    // correlation. Without this increment, a handler that always passes a
    // malformed body would never register on the dashboard.
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    // Omit caller `extraHeaders` from the fallback. Headers like `Allow: POST`
    // (from a 405) or `Retry-After: 5` (from a 429/503) are semantically
    // tied to the original error, not the replacement `internal-server-error`.
    // Surfacing them alongside a 500 is an HTTP semantic contradiction.
    res.writeHead(fallbackStatus, {
      'Content-Type': 'application/problem+json',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error' satisfies ProblemType,
        title: 'Internal server error.',
        status: fallbackStatus,
        instance,
      }),
    );
    return;
  }

  // RFC 9457 §3.2 extension members: emitted alongside `body` after schema
  // validation so the closed `ProblemDetails` shape stays the floor and
  // extensions ride as additional fields. The schema is `.loose()`, so
  // round-tripping through `safeParse` on the client preserves them.
  const wireBody: Record<string, unknown> = options.extensions
    ? { ...options.extensions, ...body }
    : body;

  apiErrorCounter().add(1, {
    type,
    ...(options.handler ? { handler: options.handler } : {}),
  });

  // Status-conditional log level: 4xx are routine client-side issues
  // (validation, 404, 405, etc.) — `log.warn`; 5xx are server-side faults
  // worth ops attention — `log.error`. The telemetry counter
  // `ok.api.error.count{type, handler}` is the load-bearing triage signal —
  // always increments along EVERY exit path: this happy path tags the
  // caller's `type`, and the safeParse fallback tags
  // `internal-server-error` (the type that actually went on the wire).
  // The Pino line is for grep correlation via `instance`. Separating
  // levels avoids drowning monitoring in routine 4xx noise (mirrors
  // pino-http's `customLogLevel` defaults).
  const logLevel = status >= 500 ? 'error' : 'warn';
  log()[logLevel](
    {
      event: 'api.error',
      instance,
      type,
      status,
      handler: options.handler,
      detail: options.detail,
      err: options.cause,
    },
    title,
  );

  // Pre-stringify BEFORE `writeHead` so an unserializable `wireBody`
  // (circular reference, `BigInt`, `Error` cause-chain cycle) doesn't
  // commit headers and then throw mid-`res.end()`, leaving the client
  // staring at a truncated 5xx with no body. The `extensions` type narrows
  // RFC 9457 reserved keys to `never`, but TypeScript can't narrow the
  // VALUE shape — a circular structure typed `Record<string, unknown>`
  // sneaks past compile-time. On stringify failure: log structured event
  // (with `bodyKeys` only — same data-leak hygiene as the safeParse-failure
  // branch), increment the error counter, and emit a hardcoded
  // `urn:ok:error:internal-server-error` envelope so the client still gets
  // a typed contract response. Completes the "runtime defense at every
  // wire-emit point" pattern this file documents through every other
  // safeguard.
  let serialized: string;
  try {
    serialized = JSON.stringify(wireBody);
  } catch (stringifyErr) {
    log().error(
      {
        event: 'api.error.unserializable-body',
        bodyKeys: Object.keys(wireBody),
        handler: options.handler,
        originalStatus: status,
        instance,
        err: stringifyErr,
      },
      'errorResponse wireBody is not JSON-serializable — emitting hardcoded fallback',
    );
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    // Omit caller `extraHeaders` for the same reason as the safeParse-failure
    // fallback — headers tied to the original error type (e.g. `Allow:
    // POST` on 405, `Retry-After: 5` on 429) don't apply to the replacement
    // `internal-server-error` 500.
    res.writeHead(500, {
      'Content-Type': 'application/problem+json',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error' satisfies ProblemType,
        title: 'Internal server error.',
        status: 500,
        instance,
      }),
    );
    return;
  }
  // Spread `extraHeaders` FIRST so the security defaults (`Content-Type:
  // application/problem+json`, `X-Content-Type-Options: nosniff`) always
  // win on key collision. The type narrows `extraHeaders` to `Record<string,
  // string>` with no compile-time guard against a caller including a
  // reserved-name override (case-variant or otherwise); spread-order is
  // the runtime backstop. Mirrors the `wireBody` body-merge order
  // where `body` (canonical fields) wins over `options.extensions`.
  res.writeHead(status, {
    ...options.extraHeaders,
    'Content-Type': 'application/problem+json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serialized);
}

/**
 * Build a typed mid-stream error event for NDJSON streaming endpoints.
 * The streaming protocol's `type` field discriminates event kinds
 * (`progress` | `complete` | `error`); RFC 9457 `ProblemDetails` lives
 * nested under `problem` so the streaming `type: 'error'` and the URN
 * `problem.type` never collide.
 *
 * Like `errorResponse(...)`, this generates a UUID `instance`, validates
 * the body against `StreamingProblemEventSchema`, increments the
 * `ok.api.error.count{type, handler}` counter, and emits a Pino
 * structured log line (`log.warn` for 4xx, `log.error` for 5xx) with the
 * same `instance` for grep correlation.
 *
 * The caller is responsible for writing the returned object to the stream
 * (`res.write(`${JSON.stringify(event)}\n`)`) — separation keeps the
 * helper synchronous and lets callers compose with their own
 * `res.writableEnded` / cleanup logic.
 *
 * @param status - HTTP-equivalent status mirrored to `problem.status`.
 * @param type - URN problem type (`urn:ok:error:<kebab>`).
 * @param title - Required short human-readable summary.
 * @param options - Optional handler tag, instance UUID, detail, cause.
 * @returns The `{ type: 'error', problem: ProblemDetails }` event ready for
 *   `JSON.stringify` + `res.write` on the streaming response.
 */
export function streamingProblemEvent(
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options: StreamingErrorOptions = {},
): StreamingProblemEvent {
  // RFC 9457 §3.1.6 — see `errorResponse` above for the urn:uuid: rationale.
  const instance = options.instance ?? `urn:uuid:${randomUUID()}`;
  const problem: ProblemDetails = {
    type,
    title,
    status,
    instance,
    detail: options.detail ?? undefined,
  };
  const event: StreamingProblemEvent = { type: 'error', problem };
  // Defense-in-depth: mirror `errorResponse`'s `safeParse` discipline.
  // A throwing `.parse()` here would crash mid-stream and the original error
  // that triggered the event would be lost without anything reaching the
  // client. On schema-validation failure: log the issues + the malformed
  // event, then return a hardcoded fallback `urn:ok:error:internal-server-error`
  // event so the caller still has something typed to write to the stream.
  const validated = StreamingProblemEventSchema.safeParse(event);
  if (!validated.success) {
    log().error(
      {
        event: 'api.streaming.malformed-envelope',
        issues: validated.error.issues,
        body: event,
        handler: options.handler,
        originalStatus: status,
      },
      'streamingProblemEvent produced an invalid StreamingProblemEvent — returning fallback',
    );
    // Override status to 500 so the fallback's `type: internal-server-error`
    // and `problem.status` agree. Same rationale as the `errorResponse`
    // fallback: a malformed envelope IS a server bug; emitting an
    // `internal-server-error` type with the caller's original 4xx status
    // would surface a contradiction. Original status preserved in the log
    // line for ops triage.
    const fallbackStatus = 500 as const;
    // Counter increments on the fallback path — same rationale as
    // `errorResponse`: operators relying on `ok.api.error.count` as the
    // sole alerting signal must see programming errors. Tag with the type
    // that actually goes on the stream (`internal-server-error`), not the
    // caller's original.
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return {
      type: 'error',
      problem: {
        type: 'urn:ok:error:internal-server-error',
        title: 'Internal server error.',
        status: fallbackStatus,
        instance,
      },
    };
  }

  apiErrorCounter().add(1, {
    type,
    ...(options.handler ? { handler: options.handler } : {}),
  });

  // Status-conditional log level (mirrors `errorResponse`).
  const logLevel = status >= 500 ? 'error' : 'warn';
  log()[logLevel](
    {
      event: 'api.streaming.error',
      instance,
      type,
      status,
      handler: options.handler,
      detail: options.detail,
      err: options.cause,
    },
    title,
  );

  return event;
}

/**
 * Bind a streaming-error writer to a specific `(res, handler)` pair. Returns
 * a closure that writes a typed `{ type: 'error', problem: ProblemDetails }`
 * event to the NDJSON stream, gated on `res.writableEnded` so a second call
 * after the response has been ended is a benign no-op.
 *
 * Three NDJSON streaming handlers in `api-extension.ts` (clone, auth-login,
 * auth-repos) need the same closure shape — extracting it here removes the
 * three-site duplication and lets future streaming handlers consume the
 * helper without rebuilding the same write/guard/counter scaffolding.
 *
 * @param res - The streaming response (already in `application/x-ndjson`
 *   mode; helper does NOT write the head).
 * @param handler - Handler tag for `ok.api.error.count{handler}`.
 */
export function createStreamingErrorWriter(
  res: ServerResponse,
  handler: string,
): (
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options?: { detail?: string; cause?: unknown },
) => void {
  return (status, type, title, options = {}) => {
    // `writableEnded` covers `res.end()` (graceful close); `destroyed`
    // covers TCP RST / client abrupt disconnect mid-stream where the
    // socket is torn down without `end()` ever being called. Without the
    // second guard, a downstream `res.write` would throw
    // `ERR_STREAM_DESTROYED` and lose the original error context the
    // caller was trying to surface (see precedent at `api-extension.ts`
    // asset-streaming sites).
    if (res.writableEnded || res.destroyed) {
      log().error(
        {
          event: 'api.streaming.error.suppressed',
          type,
          status,
          handler,
          detail: options.detail,
          err: options.cause,
        },
        'createStreamingErrorWriter called after writableEnded/destroyed — suppressed',
      );
      apiErrorCounter().add(1, {
        type: 'urn:ok:error:internal-server-error',
        ...(handler ? { handler } : {}),
      });
      return;
    }
    const event = streamingProblemEvent(status, type, title, { handler, ...options });
    try {
      res.write(`${JSON.stringify(event)}\n`);
    } catch (writeErr) {
      // Race window: socket destruction between the guard and the
      // write itself (e.g., async TCP RST). Preserve the original error
      // (`options.cause`) in the log alongside the write error so neither
      // gets swallowed.
      log().error(
        {
          event: 'api.streaming.error.write-failed',
          type,
          status,
          handler,
          err: options.cause,
          writeErr,
        },
        'createStreamingErrorWriter: res.write threw — original error preserved in log',
      );
    }
  };
}

/**
 * Internal: reset the lazy-cached counter. Test-only — production callers
 * never invoke this. Allows narrow-integration tests to swap the meter
 * provider between cases without process restart.
 */
export function _resetApiErrorCounterForTest(): void {
  _apiErrorCounter = null;
}
