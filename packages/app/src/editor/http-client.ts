/**
 * Client-side HTTP-response parsing helpers.
 *
 * `HttpResponseParseError` distinguishes contract-shape responses (parsed via
 * `safeParse(Schema, body)`) from non-contract responses — reverse-proxy 502s
 * with HTML body, network errors that return JSON in a different shape,
 * malformed bytes, etc. Throwing a typed class lets callers route the
 * non-contract path through their own retry / surface-to-user handling
 * without confusing it with a real `ProblemDetails` (RFC 9457 problem+json)
 * error from the server.
 *
 * Pattern (RFC 9457 two-step parse):
 *
 *   const res = await fetch(url, { ... });
 *   const body = await res.json().catch(() => null);
 *   if (!res.ok) {
 *     const problem = ProblemDetailsSchema.safeParse(body);
 *     if (!problem.success) {
 *       throw new HttpResponseParseError('Server returned non-RFC9457 error', {
 *         cause: problem.error,
 *         status: res.status,
 *       });
 *     }
 *     // Handle problem.data.type / problem.data.title
 *   } else {
 *     const success = XyzSuccessSchema.safeParse(body);
 *     if (!success.success) {
 *       throw new HttpResponseParseError('Server returned malformed success body', {
 *         cause: success.error,
 *         status: res.status,
 *       });
 *     }
 *     // Use success.data
 *   }
 */

export interface HttpResponseParseErrorOptions {
  cause?: unknown;
  status?: number;
  /** RFC 9457 `instance` correlation ID, when present in the body. */
  instance?: string;
}

export class HttpResponseParseError extends Error {
  readonly status?: number;
  readonly instance?: string;

  constructor(message: string, options: HttpResponseParseErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpResponseParseError';
    this.status = options.status;
    this.instance = options.instance;
  }
}
