/**
 * `withValidation()` middleware wrapper for HTTP request bodies.
 *
 * Structural enforcement that handlers can't be added without going through
 * Zod validation: at handler registration, wrap with
 * `withValidation(XyzRequestSchema, async (req, res, body) => { ... })`.
 * The handler receives an already-validated, typed `body`. Failure auto-
 * routes through `errorResponse(res, 400, 'urn:ok:error:invalid-request', ...)`
 * — the inner handler never sees a malformed body.
 *
 * Body-shape errors emitted by this wrapper happen BEFORE
 * `extractAgentIdentity` is called by the inner handler, which is
 * semantically OK: no Y.Doc mutation is attempted, so the response is
 * legitimately anonymous. Semantic errors (handler-internal logic) must be
 * post-identity (attributed). The `attribution-sweep-coverage.test.ts`
 * ordering check enforces the distinction on mutating
 * handlers (precedent #24).
 *
 * Multipart binary parsing remains busboy's job (`POST /api/upload`); for
 * multipart handlers, call `validateBody(schema, parsedMetadata)` after
 * busboy assembles the metadata fields.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { errorResponse } from './error-response.ts';

/**
 * 1 MB request-body cap. This is the canonical site — body reading was
 * consolidated into `withValidation()` here, so all ~50 POST handlers
 * inherit the cap automatically. No upstream caller declares its own
 * limit.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Per-function body-read timeout. Bounded below the server-level
 * `requestTimeout` (60s in `boot.ts`) so a slowloris-class client that
 * dribbles bytes below the byte cap is killed inside the handler's async
 * slot with a typed RFC 9457 envelope rather than a raw 408 from Node's
 * server-level cap. The 30s budget matches the MCP shim's `httpGet`/`httpPost`
 * timeouts (`mcp/tools/shared.ts`) so cross-process and same-process body
 * reads share the same cancellation deadline.
 */
const REQUEST_BODY_TIMEOUT_MS = 30_000;

/**
 * Read the full request body up to `MAX_BODY_BYTES`. Returns the raw `Buffer`
 * for callers that need bytes (or want to JSON-parse themselves). Throws
 * `PayloadTooLargeError` when the body exceeds the cap; throws
 * `RequestBodyTimeoutError` when the read takes longer than
 * `REQUEST_BODY_TIMEOUT_MS`.
 */
function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return readBoundedJsonBody(req, {
    maxBytes: MAX_BODY_BYTES,
    timeoutMs: REQUEST_BODY_TIMEOUT_MS,
  });
}

/**
 * Bounded body reader with timeout — guards against unbounded payloads AND
 * slowloris-class clients on a POST endpoint. Caller chooses caps; defaults
 * for `withValidation()`-wrapped handlers are 1 MB / 30s, but
 * loopback-only handlers (`/api/spawn-cursor`, `/api/handoff`) opt for
 * tighter 4 KB / 5s budgets that match their loopback-only blast radius.
 *
 * Throws typed errors so callers can map to RFC 9457 URN tokens:
 *   - `PayloadTooLargeError` when bytes exceed `opts.maxBytes`.
 *   - `RequestBodyTimeoutError` when the read exceeds `opts.timeoutMs`.
 *   - Native errors (`ERR_STREAM_PREMATURE_CLOSE`, `ERR_STREAM_DESTROYED`,
 *     `AbortError`) bubble up for the catch-all 500 path.
 */
export async function readBoundedJsonBody(
  req: IncomingMessage,
  opts: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  // When the timeout fires, destroy the request stream so the for-await loop
  // throws our typed error and unblocks the handler's async slot. Without
  // this the iterator would keep reading until the server-level
  // `requestTimeout` (60s) fires, producing a raw 408 instead of a typed
  // RFC 9457 ProblemDetails response.
  const onTimeout = () => req.destroy(new RequestBodyTimeoutError(opts.timeoutMs));
  timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  try {
    for await (const chunk of req) {
      totalBytes += (chunk as Buffer).length;
      if (totalBytes > opts.maxBytes) {
        throw new PayloadTooLargeError(opts.maxBytes);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    timeoutSignal.removeEventListener('abort', onTimeout);
  }
}

export class PayloadTooLargeError extends Error {
  /** Cap that was exceeded, in bytes — carried so the log line reflects the
   *  actual per-handler bound (e.g. 4 KB for loopback POSTs) rather than
   *  hardcoding `withValidation`'s 1 MB default. Optional for back-compat
   *  with any external constructors. */
  readonly maxBytes?: number;
  constructor(maxBytes?: number) {
    super(
      maxBytes !== undefined
        ? `Request body exceeded ${formatBytes(maxBytes)} cap`
        : 'Request body exceeded cap',
    );
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown by `readRequestBody` when the per-function timeout fires before the
 * client finishes streaming the body. Surfaces through `withValidation`'s
 * catch as a typed 408 `urn:ok:error:request-timeout` so SDK consumers can
 * distinguish slowloris-class failures (drop and retry) from bug-class 400s
 * and size-class 413s.
 */
export class RequestBodyTimeoutError extends Error {
  /** Timeout that fired, in ms — carried so the log line reflects the actual
   *  per-handler bound (e.g. 5 000 ms for loopback POSTs) rather than
   *  hardcoding `withValidation`'s 30 000 ms default. Optional for back-compat. */
  readonly timeoutMs?: number;
  constructor(timeoutMs?: number) {
    super(
      timeoutMs !== undefined
        ? `Request body read exceeded ${timeoutMs}ms timeout`
        : 'Request body read exceeded timeout',
    );
    this.name = 'RequestBodyTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

export interface WithValidationOptions {
  /** Tag for telemetry; surfaces as `ok.api.error.count{handler}` attribute. */
  handler?: string;
  /**
   * If true, the wrapper does NOT read the request body. Caller is
   * responsible for parsing (e.g., busboy multipart). Use `validateBody()`
   * directly with the parsed metadata.
   */
  skipBodyParse?: boolean;
  /**
   * Allowed HTTP method. When set, the wrapper rejects mismatched methods
   * with a 405 + `Allow: <method>` BEFORE reading the body — proper REST
   * semantics (a GET on a POST-only endpoint should not consume the body).
   * Omitting accepts any method.
   */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /**
   * Runs after method check, BEFORE body read. Return `false` to short-
   * circuit (caller must already have emitted via `errorResponse`); return
   * `true` to proceed.
   *
   * Use cases:
   *   - **Security gate** (`checkLocalOpSecurity`): reject 403 loopback /
   *     Origin violations BEFORE consuming bytes from untrusted sources.
   *   - **Service-availability gate** (`getSyncEngine?.()`): emit 503
   *     `urn:ok:error:sync-not-active` early when the subsystem isn't
   *     initialized; saves the body read.
   *   - **Fail-fast preconditions** that depend only on headers/path.
   *
   * Compose multiple gates inline by returning early:
   *   ```ts
   *   preBodyGate: (req, res) => {
   *     if (!checkLocalOpSecurity(req, res, { handler })) return false;
   *     const engine = getSyncEngine?.();
   *     if (!engine) {
   *       errorResponse(res, 503, 'urn:ok:error:sync-not-active', '…', { handler });
   *       return false;
   *     }
   *     return true;
   *   }
   *   ```
   */
  preBodyGate?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

/**
 * Validate a parsed body against a Zod schema and emit a 400 error response
 * on failure. Returns a discriminated `Result` so callers can branch on
 * validation outcome without try/catch ceremony. Used both directly by
 * multipart handlers and indirectly by `withValidation()`.
 */
export function validateBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  res: ServerResponse,
  options: WithValidationOptions = {},
): { ok: true; value: T } | { ok: false } {
  const parseResult = schema.safeParse(raw);
  if (parseResult.success) {
    return { ok: true, value: parseResult.data };
  }
  const detail = parseResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Request body is invalid.', {
    handler: options.handler,
    detail,
  });
  return { ok: false };
}

export type ValidatedHandler<T> = (
  req: IncomingMessage,
  res: ServerResponse,
  body: T,
) => Promise<void> | void;

/**
 * Wrap a JSON-body handler with Zod validation. The wrapper:
 *   1. Reads the request body (up to `MAX_BODY_BYTES`).
 *   2. JSON-parses; on parse failure → 400 `urn:ok:error:invalid-request`.
 *   3. Schema-validates; on failure → 400 with field-path detail.
 *   4. Invokes the inner handler with a typed, validated body.
 *
 * Inner handler exceptions are NOT caught — `api-extension.ts` keeps its
 * existing top-level try/catch + 500 emission per handler.
 */
export function withValidation<T>(
  schema: z.ZodType<T>,
  handler: ValidatedHandler<T>,
  options: WithValidationOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (options.method !== undefined && req.method !== options.method) {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: options.handler,
        extraHeaders: { Allow: options.method },
      });
      return;
    }

    if (options.preBodyGate !== undefined) {
      const gateOk = options.preBodyGate(req, res);
      if (!gateOk) {
        // The gate's contract is "return false ONLY after writing your own
        // RFC 9457 envelope" (e.g., loopback rejection emits via
        // emitProblem). A future gate that returns false without writing
        // would otherwise hang the connection until requestTimeout (60s).
        // Convert that silent hang into a loud 500 + structured log so the
        // bug surfaces immediately rather than as a vague timeout report.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          // Route the diagnostic through `cause` (Pino-logged via err: field,
          // never emitted on the wire). Detail stays generic to match the
          // codebase's data-leak hygiene precedent: the sync helper's catch-
          // all 500 also uses 'Internal server error.' as the wire title and
          // routes raw err.message via cause (auth-failed, folder-config-put,
          // template-put, template-delete handlers all do this).
          errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
            handler: options.handler,
            cause: new Error('preBodyGate returned false without writing a response'),
          });
        }
        return;
      }
    }

    if (options.skipBodyParse) {
      // GET-style endpoint: don't read the body. Validate against an empty
      // object so the schema is still load-bearing (catches schemas that
      // require fields when paired with a no-body method by mistake).
      const validated = validateBody(schema, {}, res, options);
      if (!validated.ok) return;
      await handler(req, res, validated.value);
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Distinct URN from `urn:ok:error:invalid-request` so SDK consumers
        // can branch on retry-class (413 → reduce payload, retry) vs
        // bug-class (400 → fix request shape).
        errorResponse(res, 413, 'urn:ok:error:payload-too-large', 'Payload too large.', {
          handler: options.handler,
          cause: err,
        });
        return;
      }
      if (err instanceof RequestBodyTimeoutError) {
        // Slowloris-class: per-function body-read timeout fired before the
        // client finished streaming. Distinct URN + 408 so SDK consumers can
        // branch on retry-class (drop and retry) vs the bug-class 400.
        errorResponse(res, 408, 'urn:ok:error:request-timeout', 'Request body read timed out.', {
          handler: options.handler,
          cause: err,
        });
        return;
      }
      // Catch-all for genuinely unknown errors out of `for-await` request-stream
      // (`ERR_STREAM_PREMATURE_CLOSE`, `ERR_STREAM_DESTROYED`, memory-pressure
      // failures, native `AbortError` variants). These are transport/server-class,
      // NOT client-caused — surface as 500 so SDK retry semantics match (a client
      // receiving 400 for a transport failure would retry unchanged believing it
      // sent bad data). The two specifically-typed branches (413, 408) keep
      // their precise client-class status codes.
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Failed to read request body.',
        {
          handler: options.handler,
          cause: err,
        },
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch (err) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Request body is not valid JSON.', {
        handler: options.handler,
        cause: err,
      });
      return;
    }

    const validated = validateBody(schema, parsed, res, options);
    if (!validated.ok) return;

    await handler(req, res, validated.value);
  };
}
