import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
  tripsForwardedHeaderTripwire,
  warnForwardedHeaderRefusalOnce,
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import { errorResponse } from './error-response.ts';
import type { McpDispatch } from './mcp-route.ts';

export type ReadinessState = 'pending' | 'ready' | 'failed' | 'draining';

export interface HealthProvider {
  readiness: () => ReadinessState;
  degraded: () => readonly string[];
}

export interface NativeApiHandle {
  paths: readonly string[];
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

export type SurfaceAdmissionCaller = 'mcp-mount' | 'native-api-surface' | 'native-mcp-surface';

export function admitRequestSurface(
  req: IncomingMessage,
  res: ServerResponse,
  policy: IngressPolicy,
  handler: SurfaceAdmissionCaller,
  log?: PinoLogger,
): boolean {
  if (tripsForwardedHeaderTripwire(req, policy)) {
    if (log !== undefined) {
      warnForwardedHeaderRefusalOnce(log, handler);
    }
    errorResponse(
      res,
      403,
      'urn:ok:error:host-not-allowed',
      'Proxied request refused: this server has not consented to external exposure. Set OK_EXTERNAL_URL to the public origin and OK_ALLOW_EXTERNAL=1 (or server.externalUrl + server.allowExternal in config), then restart the server.',
      { handler },
    );
    return false;
  }
  if (policy.allowExternal) {
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    if (!isPeerAdmitted(req.socket.remoteAddress, policy) || !isHostAdmitted(host, policy)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler,
      });
      return false;
    }
  }
  return true;
}

export function assertSingleRouterOwnership(
  nativePaths: readonly string[],
  legacyRoutes: Readonly<Record<string, unknown>>,
): void {
  const doubleRouted = nativePaths.filter((p) => !p.includes('*') && p in legacyRoutes);
  const wildcardPrefixes = nativePaths.filter((p) => p.endsWith('/*')).map((p) => p.slice(0, -1));
  const shadowed = Object.keys(legacyRoutes)
    .filter((key) => wildcardPrefixes.some((prefix) => key.startsWith(prefix)))
    .map((key) => `${key} (under a native wildcard)`);
  const conflicts = [...doubleRouted, ...shadowed];
  if (conflicts.length > 0) {
    throw new Error(
      `route(s) present in both the legacy dispatch record and a native route group: ${conflicts.join(', ')}`,
    );
  }

  const seen = new Set<string>();
  const nativeDuplicates: string[] = [];
  for (const p of nativePaths) {
    if (seen.has(p)) nativeDuplicates.push(p);
    seen.add(p);
  }
  const nativeShadowed = nativePaths
    .filter((p) => wildcardPrefixes.some((prefix) => p !== `${prefix}*` && p.startsWith(prefix)))
    .map((p) => `${p} (under a native wildcard)`);
  const nativeConflicts = [...new Set([...nativeDuplicates, ...nativeShadowed])];
  if (nativeConflicts.length > 0) {
    throw new Error(
      `route(s) claimed by more than one native route group: ${nativeConflicts.join(', ')}`,
    );
  }
}

export interface CreateHttpAppOptions {
  health?: HealthProvider;
  legacyDispatch: (req: IncomingMessage, res: ServerResponse) => void;
  nativeApi?: NativeApiHandle;
  mcpDispatch?: McpDispatch;
  ingressPolicy?: IngressPolicy;
  log: PinoLogger;
}

export interface HttpAppHandle {
  requestListener: (req: IncomingMessage, res: ServerResponse) => void;
}

function writeHealthResponse(
  path: '/healthz' | '/readyz',
  req: IncomingMessage,
  res: ServerResponse,
  health: HealthProvider | undefined,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'health',
      extraHeaders: { Allow: 'GET, HEAD' },
    });
    return;
  }
  const probeHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (path === '/healthz') {
    res.writeHead(200, { ...probeHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  const readiness = health?.readiness() ?? 'ready';
  const ready = readiness === 'ready';
  res.writeHead(ready ? 200 : 503, { ...probeHeaders, 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ready,
      status: readiness,
      degraded: ready ? (health?.degraded() ?? []) : [],
    }),
  );
}

export function createHttpApp(opts: CreateHttpAppOptions): HttpAppHandle {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.onError((err, c) => {
    const res = c.env.outgoing;
    opts.log.error({ err }, 'Unhandled router handler error');
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'http-app',
        cause: err,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
    return RESPONSE_ALREADY_SENT;
  });

  for (const path of ['/healthz', '/readyz'] as const) {
    app.all(path, (c) => {
      writeHealthResponse(path, c.env.incoming, c.env.outgoing, opts.health);
      return RESPONSE_ALREADY_SENT;
    });
  }

  const ingressPolicy = opts.ingressPolicy ?? buildIngressPolicy({});

  const mcpDispatch = opts.mcpDispatch;
  if (mcpDispatch !== undefined) {
    app.all('/mcp', (c) => {
      const req = c.env.incoming;
      const res = c.env.outgoing;
      const url = req.url?.split('?')[0];
      if (url !== '/mcp') {
        opts.legacyDispatch(req, res);
        return RESPONSE_ALREADY_SENT;
      }
      if (!admitRequestSurface(req, res, ingressPolicy, 'native-mcp-surface', opts.log)) {
        return RESPONSE_ALREADY_SENT;
      }
      mcpDispatch(req, res);
      return RESPONSE_ALREADY_SENT;
    });
  }

  const nativeApi = opts.nativeApi;
  if (nativeApi !== undefined) {
    for (const path of nativeApi.paths) {
      app.all(path, async (c) => {
        const req = c.env.incoming;
        const res = c.env.outgoing;
        if (!admitRequestSurface(req, res, ingressPolicy, 'native-api-surface', opts.log)) {
          return RESPONSE_ALREADY_SENT;
        }
        try {
          const handled = await nativeApi.dispatch(req, res);
          if (!handled) opts.legacyDispatch(req, res);
        } catch (err) {
          opts.log.error({ err }, 'Unhandled onRequest error');
          if (!res.writableEnded && !res.headersSent) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Internal server error.',
              {
                handler: 'native-api-catch',
                cause: err,
              },
            );
          } else if (!res.writableEnded) {
            res.end();
          }
        }
        return RESPONSE_ALREADY_SENT;
      });
    }
  }

  app.all('*', (c) => {
    opts.legacyDispatch(c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  });

  return {
    requestListener: getRequestListener(app.fetch, {
      overrideGlobalObjects: false,
      autoCleanupIncoming: false,
    }),
  };
}
