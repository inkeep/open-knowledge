import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import type { PinoLogger } from '../logger.ts';
import { errorResponse } from './error-response.ts';

/**
 * The canonical HTTP application, introduced strangler-fig style: a Hono app
 * owns top-level routing, and every surface that has not yet been migrated to
 * a native handler falls through a catch-all into the pre-existing raw-Node
 * dispatch byte-for-byte unchanged. Surfaces migrate route by route; when the
 * legacy dispatch handles nothing, it gets deleted and the app stands alone.
 *
 * Handlers here write through the adapter's raw escape hatch
 * (`c.env.incoming`/`c.env.outgoing` + `RESPONSE_ALREADY_SENT`) rather than
 * returning web-standard Responses. That is deliberate for the migration
 * window: the characterization suite pins responses byte-for-byte, and the
 * existing response helpers (`errorResponse` et al.) write imperatively to
 * `ServerResponse`. Native `c.json()`-style handlers come later, surface by
 * surface, when the response-helper seam is rewritten.
 */

/** Async-init lifecycle as reported by /readyz. Only `ready` answers 200. */
export type ReadinessState = 'pending' | 'ready' | 'failed' | 'draining';

export interface HealthProvider {
  readiness: () => ReadinessState;
  degraded: () => readonly string[];
}

export interface CreateHttpAppOptions {
  /** Readiness provider for /readyz; omitted means always-ready (harnesses with synchronous init). */
  health?: HealthProvider;
  /** The pre-router dispatch. Every route without a native handler flows through here unchanged. */
  legacyDispatch: (req: IncomingMessage, res: ServerResponse) => void;
  /** Structured logger for handler errors the router catches. */
  log: PinoLogger;
}

export interface HttpAppHandle {
  /** Adapter-agnostic Node request listener — attach with `httpServer.on('request', ...)`. */
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
  // Single-shaped body in both branches so consumers can read `status` and
  // `degraded` unconditionally. `degraded` is only meaningful once ready —
  // mid-init the list is still being populated.
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

  // Keep 500s on the server's error contract: without this, a throwing
  // handler gets Hono's plain-text default — no pino line, no problem+json.
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

  // Health surface, mounted ABOVE the legacy dispatch and therefore above
  // every admission gate that lives inside it: orchestrator probes arrive
  // with an IP Host header, no Origin, and often through a proxy that adds
  // forwarding headers — all of which the gates refuse. The exemption is
  // safe because the surface is liveness/readiness only.
  for (const path of ['/healthz', '/readyz'] as const) {
    app.all(path, (c) => {
      writeHealthResponse(path, c.env.incoming, c.env.outgoing, opts.health);
      return RESPONSE_ALREADY_SENT;
    });
  }

  // Strangler catch-all: hand the raw req/res to the legacy dispatch and
  // tell the adapter the response is owned elsewhere. The legacy handlers
  // finish asynchronously; Node keeps the response open until they end it.
  app.all('*', (c) => {
    opts.legacyDispatch(c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  });

  // `overrideGlobalObjects: false` — the adapter otherwise replaces
  // globalThis.Request/Response with its lightweight shims at first call, a
  // process-wide mutation that would leak into the MCP SDK, OTel exporters,
  // and every other fetch consumer. Nothing here needs the shims; if native
  // handlers ever want them, opting in must be a deliberate decision.
  //
  // `autoCleanupIncoming: false` — the adapter otherwise drains rejected
  // non-GET/HEAD request bodies after the response, which would let a caller
  // refused by the admission gates force the server to read their upload
  // anyway. The legacy dispatch manages its own body lifecycle (the
  // reject-before-consuming contract), and this keeps the pre-router
  // connection semantics byte-identical.
  return {
    requestListener: getRequestListener(app.fetch, {
      overrideGlobalObjects: false,
      autoCleanupIncoming: false,
    }),
  };
}
