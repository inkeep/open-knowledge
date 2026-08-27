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
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import { errorResponse } from './error-response.ts';
import type { McpDispatch } from './mcp-route.ts';

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

/**
 * A router-agnostic bundle of natively-served `/api/*` routes: the Hono
 * patterns to claim ahead of the strangler catch-all, plus the shared
 * admission pipeline (`http/api-pipeline.ts`) bound to the native route
 * table. `dispatch` returns `false` when the table declines the URL — the
 * mount then falls through to the legacy dispatch. That decline is
 * reachable: Hono matches against a normalized path (dot segments resolved,
 * non-reserved percent-escapes decoded) while the pipeline resolves the raw
 * `req.url`, so requests like `/api/./backlinks` are claimed by the router
 * and declined by the table.
 */
export interface NativeApiHandle {
  paths: readonly string[];
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/**
 * The surface-wide admission prelude every request runs before dispatch —
 * shared verbatim between the legacy `mcp-mount` dispatch and the
 * natively-mounted `/mcp` route and `/api/*` groups (which sit above the
 * strangler catch-all and would otherwise bypass it). Returns `false` after
 * writing the 403 when the request is refused. Both gates consult the ONE
 * boot-built `IngressPolicy` — the same object the WS upgrade path and
 * per-route gates consume.
 *
 * Gate 1 — tripwire: proxy-forwarding headers the policy does not tolerate
 * mean a tunnel is pointed at a server that never opted into exposure.
 * Refuse with the fix instruction — the alternative is silently serving a
 * public tunnel with full local trust, decided by whether the tunnel
 * rewrites Host.
 *
 * Gate 2 — with the surface EXPOSED (`server.allowExternal` consent), ONE
 * admit decision covers every surface: an admitted peer + Host on the
 * allowlist. Refusals are wrong-Host callers (DNS-rebound pages), not auth
 * failures.
 *
 * `handler` is the caller's tag on the `ok.api.error.count` counter for
 * rejections ('mcp-mount' for the legacy dispatch, 'native-mcp-surface' for
 * the native /mcp route, 'native-api-surface' for the native /api groups) —
 * the primary triage dimension, so refusals attribute to the surface that
 * actually refused. The closed union keeps a typo'd tag at a future call
 * site from silently minting an uncorrelated metric series.
 */
export type SurfaceAdmissionCaller = 'mcp-mount' | 'native-api-surface' | 'native-mcp-surface';

export function admitRequestSurface(
  req: IncomingMessage,
  res: ServerResponse,
  policy: IngressPolicy,
  handler: SurfaceAdmissionCaller,
): boolean {
  if (tripsForwardedHeaderTripwire(req, policy)) {
    errorResponse(
      res,
      403,
      'urn:ok:error:host-not-allowed',
      'Proxied request refused: this server has not consented to external exposure. Set OK_EXTERNAL_URL to the public origin and OK_ALLOW_EXTERNAL=1 (or server.externalUrl + server.allowExternal in config), then restart the server.',
      { handler },
    );
    return false;
  }
  // Gate 2 runs whenever the surface is EXPOSED (`allowExternal` consent).
  // This covers every surface the prelude fronts: `/mcp`, `/api/*`, the
  // static shell, and project-mode content assets. The predicate is the
  // consolidated one (loopback + bind literals + externalUrl), identical to the
  // `/api` pipeline gate, so direct-IP access to the shell/content matches
  // what the API admits. Pure-local (no exposure) skips this SURFACE-wide
  // gate on purpose — the read-sensitive legs behind it carry their own
  // always-on Host gates (the `/api` pipeline read gate, the content-serve
  // gate in `asset-serve-middleware.ts`, the unconditional `/mcp` gate),
  // while the SPA shell stays deliberately ungated: it is public bundle
  // code, and a rebound attacker serves their own page anyway.
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

/**
 * "A route lives in exactly one router" — the mechanical form. A path
 * claimed by a native group that still has a legacy record entry would
 * silently shadow it (the native mount dispatches first), leaving
 * live-looking dead code in the legacy dispatch. Callers invoke this at
 * construction so the overlap fails the boot instead. Both directions are
 * checked: a native exact path that is also a legacy record key, and a
 * legacy record key that falls under a native wildcard's namespace (the
 * wildcard claims everything below its prefix, so such a key is just as
 * shadowed as an exact duplicate).
 *
 * `nativePaths` is the CONCATENATION of every native group's paths, so the
 * same rule applies within the native set: two groups claiming one path (or
 * one group's wildcard covering another group's path) would silently answer
 * from whichever group sits earlier in the dispatch chain. Those collisions
 * throw here too, with their own message.
 */
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
  // A wildcard's own entry is `${prefix}*` — exclude it; everything else
  // under the prefix (exact paths AND narrower wildcards) is shadowed.
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
  /** Readiness provider for /readyz; omitted means always-ready (harnesses with synchronous init). */
  health?: HealthProvider;
  /** The pre-router dispatch. Every route without a native handler flows through here unchanged. */
  legacyDispatch: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Natively-served `/api/*` routes, mounted ABOVE the strangler catch-all.
   * Each claimed path runs the same surface admission gates the legacy
   * dispatch applies (`admitRequestSurface`) and then the shared `/api/*`
   * pipeline via `dispatch` — so a ported route keeps byte-identical gate
   * behavior while never reaching the legacy dispatch.
   */
  nativeApi?: NativeApiHandle;
  /**
   * The bound `/mcp` dispatch (`createMcpDispatch` in `mcp-route.ts`) for the
   * natively-mounted `/mcp` route — injected like `nativeApi.dispatch`, so
   * this module stays a composition layer with no MCP semantics. When
   * omitted, `/mcp` is NOT mounted and the URL falls through the strangler
   * catch-all like any other unclaimed path — the restartable test harness
   * and ephemeral single-file mode take this path.
   */
  mcpDispatch?: McpDispatch;
  /**
   * The boot-built ingress policy for the surface admission gates on native
   * routes (same object the mount applies to the legacy dispatch). Omitted
   * (test rigs) ⇒ the loopback-only default policy.
   */
  ingressPolicy?: IngressPolicy;
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

  const ingressPolicy = opts.ingressPolicy ?? buildIngressPolicy({});

  // The natively-mounted /mcp route, ABOVE the strangler catch-all. Once the
  // raw path is confirmed to be exactly `/mcp` (below), admission ordering
  // matches the legacy dispatch: the surface prelude first (tripwire +
  // remote-admit pair), then the leg's own unconditional gates.
  const mcpDispatch = opts.mcpDispatch;
  if (mcpDispatch !== undefined) {
    app.all('/mcp', (c) => {
      const req = c.env.incoming;
      const res = c.env.outgoing;
      // Hono routes on a NORMALIZED path (dot segments resolved, non-reserved
      // percent-escapes decoded), while the legacy dispatch matched the raw
      // `req.url` exactly. Re-derive the raw path and decline mismatches
      // (`/./mcp`, `/mc%70`) to the legacy dispatch, which serves them the
      // same static-fallback/404 it always has — mirrors the native /api
      // groups' table-decline fall-through. (An app-wide raw-path `getPath`
      // on the Hono constructor would make this guard unnecessary, but it
      // was considered and deferred: it also flips `/./healthz`-style
      // aliases on the ALWAYS-mounted health routes from natively served to
      // legacy 404s, a behavior change out of scope for a byte-parity wave.)
      const url = req.url?.split('?')[0];
      if (url !== '/mcp') {
        opts.legacyDispatch(req, res);
        return RESPONSE_ALREADY_SENT;
      }
      if (!admitRequestSurface(req, res, ingressPolicy, 'native-mcp-surface')) {
        return RESPONSE_ALREADY_SENT;
      }
      mcpDispatch(req, res);
      return RESPONSE_ALREADY_SENT;
    });
  }

  // Natively-served /api/* routes, ABOVE the strangler catch-all. Each runs
  // the surface admission gates first (the tripwire + remote-admit pair the
  // legacy dispatch applies in mcp-mount's onRequest), then the shared
  // /api/* pipeline — request-id, CORS, DNS-rebinding gates, dispatch span.
  const nativeApi = opts.nativeApi;
  if (nativeApi !== undefined) {
    for (const path of nativeApi.paths) {
      app.all(path, async (c) => {
        const req = c.env.incoming;
        const res = c.env.outgoing;
        if (!admitRequestSurface(req, res, ingressPolicy, 'native-api-surface')) {
          return RESPONSE_ALREADY_SENT;
        }
        try {
          const handled = await nativeApi.dispatch(req, res);
          // Reachable: Hono routes on a NORMALIZED path (`@hono/node-server`
          // resolves dot segments, and strict-mode `getPath` percent-decodes),
          // while the pipeline re-derives the path from the untouched
          // `c.env.incoming.url`. So `/api/./backlinks` and `/api/back%6Cinks`
          // get claimed here and then declined by the table. The legacy
          // dispatch owns every URL the native table does not; this branch is
          // what keeps those requests from hanging with no response written.
          if (!handled) opts.legacyDispatch(req, res);
        } catch (err) {
          // Mirrors the legacy dispatch's posture for onRequest rejections:
          // the pipeline already emitted the typed 500 before rethrowing, so
          // this is log-only unless the response never started.
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
