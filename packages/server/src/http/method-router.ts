/**
 * HTTP-verb dispatcher for `api-extension.ts` routes that multiplex several
 * handlers behind one path (`/api/skill` GET/PUT/POST/DELETE, `/api/search`
 * GET/POST, ...). Replaces the hand-rolled
 * `if (req.method === 'GET') return handleXGet(req, res); ... errorResponse(405)`
 * dispatcher functions with a single declarative map.
 *
 * The 405 fallback preserves the historical wire shape exactly: RFC 9457
 * `urn:ok:error:method-not-allowed` via `errorResponse(...)` with an `Allow`
 * header listing the supported verbs in declaration order.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponse } from './error-response.ts';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface MethodRouterOptions {
  /** Handler tag for the 405 fallback's telemetry + log line. */
  handler: string;
}

/**
 * Build a route handler that dispatches on `req.method`.
 *
 * Declare AFTER the per-verb handlers it references — the map captures the
 * handler values at declaration time (`const` initializers are not hoisted).
 */
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
