/**
 * Schema-validating success-response helper, symmetric with
 * `errorResponse(...)` (RFC 9457 problem+json) at `error-response.ts`.
 *
 * Single sanctioned site for emitting HTTP success bodies from
 * `api-extension.ts` handlers. Runs `schema.safeParse(body)` on every emit
 * (with a defense-in-depth fallback to a 500 problem+json via
 * `errorResponse` on parse failure), sets `Content-Type: application/json`,
 * and writes the parsed body. Catches schema-vs-server drift at the wire
 * boundary regardless of fixture coverage.
 *
 * Inline `json(res, 2xx, ...)` calls are not permitted in `api-extension.ts`
 * (drops the `ok: true` wrapper from success bodies; this helper closes
 * the residual schema-vs-server drift class). `error-envelope-coverage.test.ts`
 * runs in fail-on-any-occurrence mode: it AST-scans `api-extension.ts` for
 * the inline pattern and fails the build with file:line + handler name on
 * any match. New handlers go through `withValidation(...) +
 * successResponse(...)` (or `errorResponse(...)`) from day one.
 */

import type { ServerResponse } from 'node:http';
import type { z } from 'zod';
import { getLogger } from '../logger.ts';
import { apiErrorCounter, errorResponse } from './error-response.ts';

// Lazy logger accessor — see `error-response.ts` for the rationale (factory
// reconfigure clears the cache, module-level captures become stale).
const log = (): ReturnType<typeof getLogger> => getLogger('http');

/**
 * Closed union of HTTP success status codes. Symmetric with `HttpErrorStatus`
 * in `error-response.ts` (which is exported because `uploadStatusFor()`
 * returns it). Kept un-exported here because no external consumer needs to
 * name the type — the constraint only matters at the `successResponse`
 * call site and is enforced via the function signature. Adding a new 2xx
 * (e.g. `203`, `206`) is a single-edit extension here.
 */
type HttpSuccessStatus = 200 | 201 | 202;

interface SuccessResponseOptions {
  /**
   * Optional handler attribute. Surfaces on the parse-failure-fallback path
   * via `errorResponse`'s `ok.api.error.count{type, handler}` counter so
   * the existing alert signal covers `successResponse` parse failures
   * without inventing a parallel counter. Happy-path emits do NOT
   * increment a counter — would balloon cardinality across 68 emit sites
   * with no operator triage signal.
   */
  handler?: string;
  /**
   * Optional headers merged into the response head (e.g. `Cache-Control:
   * no-store` on the asset-upload handler). Spread BEFORE the security
   * defaults (`Content-Type: application/json`, `X-Content-Type-Options:
   * nosniff`) so the canonical headers always win on key collision —
   * mirrors `errorResponse`'s spread-order protection.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Emit a schema-validated JSON success response.
 *
 * @param res - Node HTTP response. If the head has already been written,
 *   the call is suppressed and logged (defense-in-depth against async races
 *   and programming errors at any of the ~68 success-emit sites).
 * @param status - HTTP success status code. Typed as the closed union
 *   `HttpSuccessStatus` (200 | 201 | 202) for symmetry with
 *   `errorResponse`'s `HttpErrorStatus`. Compile-time guard rejects
 *   `successResponse(res, 500, ...)` accidents — emitting a 5xx via the
 *   success helper would set `Content-Type: application/json` instead of
 *   `application/problem+json` and bypass the error counter, which the
 *   narrower type makes structurally impossible. Adding a new 2xx
 *   (`203`, `206`, etc.) is a single-edit extension here.
 * @param schema - Per-handler `XyzSuccessSchema` from
 *   `@inkeep/open-knowledge-core`. Runs `.safeParse()` on the body for
 *   defense-in-depth — a schema-vs-server divergence surfaces at the wire
 *   boundary instead of leaking malformed data to clients.
 * @param body - The success body. Typed as `unknown` to mirror `safeParse`'s
 *   own input contract: the schema is the load-bearing typing surface, and
 *   in-process runtime types (interfaces, classes) routinely lack the
 *   `[x: string]: unknown` index signature that `.loose()` schemas infer —
 *   forcing structural alignment at the call site would pollute every
 *   handler's internal types. The runtime `safeParse` is the load-bearing
 *   defense: schema-vs-runtime drift surfaces as a typed problem+json
 *   fallback regardless of compile-time loosening. Per-handler smoke tests
 *   plus the structural meta-test (`error-envelope-coverage`) cover the
 *   "did you pass the right schema for this handler" question that the
 *   compile-time generic would otherwise enforce.
 * @param options - Optional handler tag and extraHeaders.
 */
export function successResponse(
  res: ServerResponse,
  status: HttpSuccessStatus,
  schema: z.ZodType,
  body: unknown,
  options: SuccessResponseOptions = {},
): void {
  // Defense-in-depth: if a handler has already started writing (async race,
  // programming error), `res.writeHead()` would throw `ERR_HTTP_HEADERS_SENT`
  // and lose the original error. Mirrors `errorResponse`'s headersSent guard.
  // Log the suppression so the failure stays loud in dev tools / production
  // telemetry instead of silently disappearing.
  if (res.headersSent || res.writableEnded || res.destroyed) {
    log().error(
      {
        event: 'api.success.double-write',
        status,
        handler: options.handler,
      },
      'successResponse called after headers already sent — suppressed',
    );
    // Mirror errorResponse's discipline: increment the alert counter so
    // operators relying on `ok.api.error.count` as the sole signal see
    // success-path double-writes too. Tag with internal-server-error to
    // match the file-wide convention for programming-bug exit paths.
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return;
  }

  // Defense-in-depth: validate the body against the schema. A bad emit
  // (e.g., a handler returning `{ docName, content }` for an endpoint whose
  // schema requires `{ documents }`) would otherwise reach the client as
  // malformed JSON and surface as a parse error in the SDK or UI. Use
  // `safeParse` so a schema mismatch routes through the typed fallback
  // instead of throwing a raw `ZodError` that would crash the handler and
  // bypass `errorResponse`'s structured logging + telemetry.
  const validated = schema.safeParse(body);
  if (!validated.success) {
    // Failure: log the issues + the malformed body, then emit a typed
    // problem+json via `errorResponse` so the client gets a contract-shaped
    // response and the existing `ok.api.error.count{type, handler}` counter
    // increments. Preserves the load-bearing alert signal for schema-vs-server
    // drift without inventing a parallel counter.
    log().error(
      {
        event: 'api.success.malformed-body',
        issues: validated.error.issues,
        bodyKeys: typeof body === 'object' && body !== null ? Object.keys(body) : null,
        handler: options.handler,
        originalStatus: status,
      },
      'successResponse produced an invalid body for the supplied schema — emitting fallback',
    );
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: options.handler,
    });
    return;
  }

  // Pre-stringify BEFORE `writeHead` so an unserializable parsed body
  // doesn't commit headers and then throw mid-`res.end()`, leaving the
  // client staring at a truncated 2xx with no payload. Most success schemas
  // are tightly constrained, but `HistoryEntrySchema.checkpoint` accepts
  // `z.unknown().nullable()` — survivor data can carry circular refs,
  // `BigInt`, or `Error` cause-chain cycles past the schema. On stringify
  // failure: log structured event with `bodyKeys` only (data-leak hygiene
  // mirrors the safeParse-failure branch above) and route through
  // `errorResponse` so the client gets a typed contract response and the
  // existing `ok.api.error.count{handler}` counter increments. Mirrors
  // `errorResponse`'s pre-stringify guard for symmetric defense across
  // both wire-emit helpers.
  let serialized: string;
  try {
    serialized = JSON.stringify(validated.data);
  } catch (stringifyErr) {
    log().error(
      {
        event: 'api.success.unserializable-body',
        bodyKeys:
          typeof validated.data === 'object' && validated.data !== null
            ? Object.keys(validated.data)
            : null,
        handler: options.handler,
        originalStatus: status,
        err: stringifyErr,
      },
      'successResponse parsed body is not JSON-serializable — emitting fallback',
    );
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: options.handler,
    });
    return;
  }
  // Spread `extraHeaders` FIRST so the security defaults (`Content-Type:
  // application/json`, `X-Content-Type-Options: nosniff`) always win on
  // key collision. The type narrows `extraHeaders` to `Record<string,
  // string>` with no compile-time guard against a caller including a
  // reserved-name override (case-variant or otherwise); spread-order is
  // the runtime backstop. Mirrors `errorResponse`.
  res.writeHead(status, {
    ...options.extraHeaders,
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  // Emit the parsed body. For Zod, this is the same shape as the input plus
  // any schema-level transforms (none of the api.ts schemas currently
  // transform; using `validated.data` future-proofs the helper if a
  // transform schema lands later).
  res.end(serialized);
}
