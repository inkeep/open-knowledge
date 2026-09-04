import type { IncomingMessage, ServerResponse } from 'node:http';
import { BridgeMergeContentLossError } from '@inkeep/open-knowledge-core';
import { errorResponse } from './error-response.ts';

export interface CatchErrorsOptions {
  handler: string;
  title?: string;
}

export function catchErrors<Args extends unknown[]>(
  fn: (req: IncomingMessage, res: ServerResponse, ...rest: Args) => Promise<void> | void,
  options: CatchErrorsOptions,
): (req: IncomingMessage, res: ServerResponse, ...rest: Args) => Promise<void> {
  return async (req, res, ...rest) => {
    try {
      await fn(req, res, ...rest);
    } catch (err) {
      /*
       * STOP: content-loss errors must leave this handler uncaught. The name
       * check backs `instanceof` so two loaded copies of core cannot demote the
       * signal into a generic 500.
       */
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
