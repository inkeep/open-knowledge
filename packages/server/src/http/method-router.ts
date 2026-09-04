import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponse } from './error-response.ts';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface MethodRouterOptions {
  handler: string;
}

export function methodRouter(
  methods: Partial<Record<HttpMethod, RouteHandler>>,
  options: MethodRouterOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const allow = Object.keys(methods).join(', ');
  return async (req, res) => {
    const handler = req.method !== undefined ? methods[req.method as HttpMethod] : undefined;
    if (handler) {
      await handler(req, res);
      return;
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: options.handler,
      extraHeaders: { Allow: allow },
    });
  };
}
