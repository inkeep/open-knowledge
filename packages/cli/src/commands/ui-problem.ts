/**
 * RFC 9457 problem+json emitter shared by `ok ui`'s in-process responses
 * (`ui.ts` collab-server-not-running 503; `ui-proxy.ts` loopback / Host /
 * Origin gate 403s). Static-asset / SPA-fallthrough 404s do NOT use this
 * emitter — they go through `notFoundStatic` in `ui.ts` (a plain 404, not the
 * API envelope). Mirrors `errorResponse(...)` in
 * `packages/server/src/http/error-response.ts` so client-side
 * `ProblemDetailsSchema.safeParse` flows match across both processes.
 *
 * **Intentional divergences from `errorResponse(...)`** — documented so
 * future readers don't try to "consolidate":
 *
 *   - **No `apiErrorCounter()` increment.** The CLI process has no OTel
 *     SDK initialization (CLI lacks the server's telemetry infra entirely).
 *     Adding a counter call here would be a no-op at best; at worst it
 *     would lazy-initialize a meter the rest of the CLI doesn't use.
 *   - **No Pino `log.error()` call.** CLI uses different logging
 *     conventions (console + structured warn-style for events asserted in
 *     tests). The server's `getLogger()` is a Pino instance not present
 *     in the CLI runtime.
 *   - **Adds `Cache-Control: no-store`** that the server helper doesn't.
 *     `ok ui` is a dev-mode preview server; clients should never cache its
 *     5xx/4xx fallthroughs (e.g., on collab-server restart). The main
 *     server's responses are routed through Vite/asset middleware that
 *     handles caching policy at a different layer.
 *   - **No pre-stringify try/catch around `JSON.stringify(body)`.** The
 *     server helper guards against circular references / unserializable
 *     extensions in `options.extensions` (RFC 9457 §3.2 open-shape
 *     extension members). `emitProblem` accepts no extension members; the
 *     body is built exclusively from primitives (`type`, `title: string`,
 *     `status: number`, `instance: string`, `detail?: string`) so the
 *     stringify call has no surface for circularity. Adding the guard
 *     would be over-engineering for a path that cannot fail given the
 *     closed signature.
 *
 * Beyond those four divergences, the wire shape, header set, schema
 * validation behavior (`safeParse` + hardcoded fallback on schema-validation
 * failure), `headersSent` guard, and URN closed-enum discipline are identical
 * to `errorResponse(...)`.
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemType,
} from '@inkeep/open-knowledge-core';
import type { HttpErrorStatus } from '@inkeep/open-knowledge-server';

export function emitProblem(
  res: ServerResponse,
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  detail?: string,
): void {
  // RFC 9457 §3.1.6 — `instance` is a URI reference. Mirrors
  // `errorResponse` in `packages/server/src/http/error-response.ts` which
  // emits `urn:uuid:<uuid>` for the same reason.
  const instance = `urn:uuid:${randomUUID()}`;
  // Defense-in-depth: mirror the four canonical wire emitters
  // (`errorResponse`, `successResponse`, `createStreamingErrorWriter`,
  // and this helper) on the same three-way guard
  // `headersSent || writableEnded || destroyed`. If the listener ever
  // runs after a partial response, after the response was ended, or
  // after a TCP RST destroyed the socket, this suppresses the double-
  // emit instead of crashing the `ok ui` process. Loud via console.error
  // since CLI lacks Pino.
  if (res.headersSent || res.writableEnded || res.destroyed) {
    // `console.error` (not `.warn`) for severity parity with the
    // server's `errorResponse()` which routes this same class through
    // `log.error` — double-write after headers are sent IS a programming
    // bug, not a routine warning. CLI lacks Pino, so console.error is
    // the local equivalent for "ops should care."
    console.error('[ok ui] emitProblem called after headers sent — suppressed', {
      type,
      status,
      instance,
    });
    return;
  }
  const body: ProblemDetails = {
    type,
    title,
    status,
    instance,
    ...(detail !== undefined ? { detail } : {}),
  };
  // Defense-in-depth: `safeParse` mirrors `errorResponse`'s pass-1 hardening.
  // The bare `http.createServer` listener has no try/catch — a throwing
  // `.parse()` (schema tightening, hardcoded title violating `min(1)`, etc.)
  // would crash the `ok ui` process. On validation failure, log to stderr
  // (CLI has no Pino) and emit a hardcoded fallback so the client still gets
  // a typed problem+json response.
  const validated = ProblemDetailsSchema.safeParse(body);
  if (!validated.success) {
    console.error('[ok ui] emitProblem produced an invalid ProblemDetails body:', {
      issues: validated.error.issues,
      originalStatus: status,
      body,
    });
    // Override status to 500 so the fallback's `type: internal-server-error`
    // and the HTTP status agree. Mirrors `errorResponse` (`error-response.ts`):
    // a malformed envelope IS a server bug; emitting `internal-server-error`
    // at the caller's original 4xx status would surface a contradiction
    // (e.g., HTTP 404 with body `{type: internal-server-error, status: 404}`).
    // Original status preserved in the warn log for ops triage.
    const fallbackStatus = 500 as const;
    res.writeHead(fallbackStatus, {
      'Content-Type': 'application/problem+json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
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
  res.writeHead(status, {
    'Content-Type': 'application/problem+json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
