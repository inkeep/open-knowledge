/**
 * Opt-in error boundary for `api-extension.ts` handlers.
 *
 * `withValidation(...)` deliberately does NOT catch inner-handler throws, so
 * historically every handler carried a hand-rolled
 * `try { ... } catch (e) { errorResponse(res, 500, ...) }` tail. `catchErrors`
 * replaces that tail: it wraps the handler, catches anything the handler
 * throws, and routes it through the sanctioned `errorResponse(...)` emitter
 * as a typed RFC 9457 500 with the original error attached as `cause` (Pino
 * `err` serialization; never on the wire).
 *
 * Composes on either side of `withValidation`'s inner handler thanks to the
 * variadic signature:
 *
 * ```ts
 * const handleFoo = withValidation(
 *   FooRequestSchema,
 *   catchErrors(async (req, res, body) => { ... }, { handler: 'foo' }),
 *   { handler: 'foo', method: 'POST' },
 * );
 * ```
 *
 * STOP rule: `BridgeMergeContentLossError` is NEVER swallowed here — its
 * single sanctioned catch site is Observer A Path B in `server-observers.ts`
 * (silent checkpoint + merge as-computed). This wrapper re-throws it so the
 * error keeps propagating to the extension-level machinery unchanged; a
 * catch here would silently drop the content-loss observability signal.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BridgeMergeContentLossError } from '@inkeep/open-knowledge-core';
import { errorResponse } from './error-response.ts';

export interface CatchErrorsOptions {
  /** Handler tag for telemetry (`ok.api.error.count{handler}`) + the log line. */
  handler: string;
  /**
   * Wire `title` for the 500 envelope. Defaults to `'Internal server
   * error.'`; migrated handlers pass their historical per-handler title
   * (e.g. `'Failed to list templates.'`) so the wire contract is unchanged.
   */
  title?: string;
}

/**
 * Wrap a handler so any throw becomes a typed RFC 9457 500.
 *
 * The already-responded case (handler wrote a response, then threw) is
 * delegated to `errorResponse`'s internal `headersSent || writableEnded ||
 * destroyed` triple-guard, which suppresses the double-write and logs the
 * `api.error.double-write` structured event — identical to what the
 * hand-rolled catch tails did before migration.
 */
export function catchErrors<Args extends unknown[]>(
  fn: (req: IncomingMessage, res: ServerResponse, ...rest: Args) => Promise<void> | void,
  options: CatchErrorsOptions,
): (req: IncomingMessage, res: ServerResponse, ...rest: Args) => Promise<void> {
  return async (req, res, ...rest) => {
    try {
      await fn(req, res, ...rest);
    } catch (err) {
      // STOP rule: content-loss errors pass through uncaught (see module doc).
      // The name check is a belt-and-braces companion to `instanceof` so a
      // duplicated class identity (two loaded copies of core) cannot demote
      // the signal into a generic 500.
      if (
        err instanceof BridgeMergeContentLossError ||
        (err instanceof Error && err.name === 'BridgeMergeContentLossError')
      ) {
        throw err;
      }
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        options.title ?? 'Internal server error.',
        { handler: options.handler, cause: err },
      );
    }
  };
}
