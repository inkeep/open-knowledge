/**
 * The `/api/*` admission pipeline — request identity, CORS, DNS-rebinding
 * gates, and the OTel dispatch span — shared by BOTH routers during the
 * strangler migration.
 *
 * The pipeline used to live inline in `api-extension.ts`'s `onRequest` hook.
 * Native routes mounted on the canonical Hono app sit ABOVE the strangler
 * catch-all and therefore bypass that hook entirely — safe for the health
 * probes, a security regression for `/api/*`. Extracting the pipeline and
 * dispatching both routers through it makes byte parity structural: one
 * implementation, two route tables. When the legacy dispatch handles nothing,
 * its table is deleted and the pipeline keeps running for the native one.
 *
 * The gate ORDER is load-bearing and mirrors the historical hook exactly:
 *
 *   0. table resolve — a URL the table declines returns `false` HERE, before
 *      any request observation. Load-bearing for the multi-group native
 *      chain (`api-extension.ts` runs one pipeline per group in turn): only
 *      the owning group's pipeline may observe the request, so a probe or
 *      request-id write hoisted above the resolve would fire once per
 *      declining group for every request a later group owns.
 *   1. embed-probe observation (ring buffer drained by `/api/__embed-detect`)
 *   2. request-id resolve + echo + `api.access` log wiring — BEFORE the gates
 *      so even gate-rejected responses carry the `x-request-id` echo
 *   3. origin-allowlist CORS with verbatim ACAO reflection + OPTIONS 204
 *   4. mutating-route loopback + workspace-Host gate (DNS-rebinding defense)
 *   5. ephemeral-mode loopback + workspace-Host gate on every `/api/*` read
 *   6. OTel server span wrapping dispatch, the unmatched-route 404, and the
 *      duration histogram
 *
 * NOT part of this pipeline: the proxied-request tripwire and the remote-admit
 * Host gate. Those are surface-wide (`/mcp`, static assets, the SPA) and live
 * with the mount (`admitRequestSurface` in `http-app.ts`); the Vite dev server
 * never applied them and must keep not applying them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLIENT_VERSION_HEADER } from '@inkeep/open-knowledge-core';
import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { isAllowedApiOrigin } from '../api-origin.ts';
import { recordEmbedProbe } from '../embed-probe.ts';
import type { PinoLogger } from '../logger.ts';
import {
  isAllowedWorkspaceHostHeader as isAllowedWorkspaceHostHeaderBase,
  isLoopbackAddress,
} from '../loopback.ts';
import { hostHeaderMatchesPublicHost } from '../remote-access.ts';
import { getMeter, getTracer, onTelemetryShutdown } from '../telemetry.ts';
import { errorResponse } from './error-response.ts';
import { REQUEST_ID_HEADER, rememberRequestId, resolveRequestId } from './request-id.ts';

/** Outcome of resolving a pathname against a route table. */
interface ApiRouteResolution {
  /**
   * Low-cardinality route TEMPLATE for the access log, span name, and
   * duration-histogram labels (`/api/tags/:name`, never the raw path) —
   * cardinality discipline for log aggregators and metric labels.
   */
  template: string;
  /**
   * Bound dispatch for the matched handler. Absent means the table owns the
   * URL but nothing handles it (empty `/api/history/` segment, unregistered
   * route) — the pipeline emits the explicit RFC 9457 404 after the gates.
   */
  dispatch?: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
}

/**
 * A router's view of its `/api/*` routes. Two implementations exist during
 * the migration: the legacy dispatch record in `api-extension.ts` (which
 * never declines a URL — unmatched resolves to the `/api/*` template with no
 * dispatch so the pipeline's 404 owns the response) and the native route
 * group (which declines URLs it has not claimed so the caller can fall
 * through to the legacy dispatch with zero side effects).
 */
export interface ApiRouteTable {
  resolve(pathname: string): ApiRouteResolution | null;
  /** Membership in the loopback + workspace-Host mutating gate. */
  isMutating(pathname: string): boolean;
}

export interface ApiPipelineOptions {
  log: PinoLogger;
  /**
   * The tunnel's public host when the server was started with remote access
   * enabled. Widens the browser-Origin allowlist and the workspace-Host
   * predicate the same way the api-extension's local shadows do.
   */
  remotePublicHost?: string;
  /** No-project ephemeral single-file mode — gates EVERY `/api/*` request. */
  ephemeral?: boolean;
  table: ApiRouteTable;
}

/**
 * Returns `true` when the pipeline owned the request (response written or
 * handler dispatched), `false` when the table declined the URL — the caller
 * then falls through to its next dispatch layer. Rejects when a handler
 * throws (the RFC 9457 500 is already on the wire; callers log and move on).
 */
export type ApiRequestPipeline = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// Cache the HTTP duration histogram at module scope — lazy-init at first use
// so the meter is a real meter (post-`initTelemetry`), not the pre-init no-op.
// Recreating the histogram every request allocates + registers a fresh
// instrument on every hit.
let _httpDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
// Reset on provider teardown so a shutdownTelemetry + initTelemetry cycle
// (dev-server restart, test harness) re-registers against the fresh provider
// instead of silently recording into the dead one. Same pattern as
// `parse-pool.ts`.
onTelemetryShutdown(() => {
  _httpDurationHist = null;
});
function httpDurationHist(): ReturnType<ReturnType<typeof getMeter>['createHistogram']> {
  _httpDurationHist ||= getMeter().createHistogram('http.server.request.duration', {
    description: 'HTTP server request duration in seconds',
    unit: 's',
  });
  return _httpDurationHist;
}

export function createApiRequestPipeline(opts: ApiPipelineOptions): ApiRequestPipeline {
  const { log, remotePublicHost, ephemeral, table } = opts;
  // In remote mode the tunnel's public Host is as legitimate as a loopback
  // name — the mount's admit gate already vetted it. Same widening the
  // api-extension applies to its route-level Host gates.
  const isAllowedWorkspaceHostHeader = (host: string | undefined): boolean =>
    isAllowedWorkspaceHostHeaderBase(host) ||
    (remotePublicHost !== undefined && hostHeaderMatchesPublicHost(host, remotePublicHost));

  return async (request, response) => {
    const url = request.url?.split('?')[0];
    if (!url) return false;

    const resolution = table.resolve(url);
    // Decline with ZERO side effects — see step 0 in the module docblock;
    // moving any observation above this return double-records chained-group
    // requests.
    if (!resolution) return false;

    // Per-request client-context observation for embed-detection spikes.
    // Pushed into a bounded in-process ring buffer drained by
    // /api/__embed-detect. Assumes loopback-only deployment — the consumer
    // endpoint enforces this. Multi-valued headers (rare) collapse to the
    // joined string Node provides by default for the headers we capture.
    const headerString = (name: string): string | undefined => {
      const value = request.headers[name];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value.join(', ') : value;
    };
    recordEmbedProbe({
      ts: Date.now(),
      url,
      method: request.method ?? '',
      ua: headerString('user-agent'),
      origin: headerString('origin'),
      referer: headerString('referer'),
      host: headerString('host'),
      remote: request.socket?.remoteAddress,
      secChUa: headerString('sec-ch-ua'),
      secChUaMobile: headerString('sec-ch-ua-mobile'),
      secChUaPlatform: headerString('sec-ch-ua-platform'),
      secFetchSite: headerString('sec-fetch-site'),
      secFetchDest: headerString('sec-fetch-dest'),
      secFetchMode: headerString('sec-fetch-mode'),
      secFetchUser: headerString('sec-fetch-user'),
    });

    const method = request.method ?? 'GET';
    const routeTemplate = resolution.template;

    // Request identity + access log for the /api/* surface. Slots BEFORE the
    // origin/loopback/host gates (without touching their order) so even
    // gate-rejected responses carry the `x-request-id` echo and produce an
    // access-log line. The `typeof` guards mirror the CORS block below —
    // unit-test doubles stub only `writeHead` + `end`.
    const requestId = url.startsWith('/api/') ? resolveRequestId(request) : undefined;
    if (requestId !== undefined) {
      rememberRequestId(request, requestId);
      if (typeof response.setHeader === 'function') {
        response.setHeader(REQUEST_ID_HEADER, requestId);
      }
      if (typeof response.once === 'function') {
        const accessStarted = Date.now();
        let accessLogged = false;
        // One line per request on whichever of finish/close fires first:
        // 'finish' is the fully-flushed response (including long-lived
        // NDJSON streams, logged at stream end); 'close' catches aborted
        // sockets (client disconnect, timeout destroy) that never finish.
        // Route TEMPLATE, never the raw path — cardinality discipline for
        // log aggregators matches the metric-label STOP rule. Byte counts
        // are omitted: Node exposes no cheap per-response counter under
        // chunked encoding (socket.bytesWritten is per-connection).
        const emitAccessLog = () => {
          if (accessLogged) return;
          accessLogged = true;
          log.info(
            {
              event: 'api.access',
              requestId,
              method,
              route: routeTemplate,
              status: response.statusCode,
              durationMs: Date.now() - accessStarted,
              ...(response.writableFinished ? {} : { aborted: true }),
            },
            `${method} ${routeTemplate} ${response.statusCode}`,
          );
        };
        response.once('finish', emitAccessLog);
        response.once('close', emitAccessLog);
      }
    }

    // Origin-allowlist CORS for /api/*. Only loopback origins are accepted:
    // - No Origin header (same-origin browser tab, curl, CLI): passes through.
    // - Origin "null" (Electron packaged renderer, file:// per Fetch spec §4.3): allowed.
    // - http(s)://localhost[:port] / 127.x.x.x[:port] / [::1][:port]: allowed.
    // - Any other Origin: 403 — closes the CSRF door on unauthenticated mutating
    //   routes (/api/agent-write-md, /api/rollback, /api/manage/delete, etc.)
    //   without breaking the Electron renderer or local Vite dev servers.
    //
    // When an allowed Origin is present, it is reflected verbatim in ACAO (not
    // `*`) so the browser's preflight check passes while non-loopback origins are
    // still refused by the gate above. `Vary: Origin` prevents cache poisoning.
    //
    // Setting via `setHeader` (not `writeHead`) so handler responses that call
    // `writeHead(status, { ... })` inherit these headers. The typeof guard handles
    // unit tests that stub only `writeHead` + `end`.
    if (url.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin !== undefined && !isAllowedApiOrigin(origin, remotePublicHost)) {
        // RFC 9457 problem+json. Tag the handler as `api-origin-gate` so
        // the `ok.api.error.count` counter distinguishes onRequest-level
        // CSRF rejections from per-handler emits. The cross-origin browser
        // can't read the body anyway (CORS strips it) but consistent wire
        // shape lets server-to-server callers + tests parse uniformly.
        errorResponse(response, 403, 'urn:ok:error:invalid-origin', 'Origin not allowed.', {
          handler: 'api-origin-gate',
        });
        return true;
      }
      if (typeof response.setHeader === 'function') {
        if (origin !== undefined) {
          response.setHeader('Access-Control-Allow-Origin', origin);
          response.setHeader('Vary', 'Origin');
        }
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        // Content-Type/Authorization: standard request headers. traceparent/
        // tracestate/baggage: OTel W3C trace-context propagation from the
        // browser SDK. x-ok-client-*: the client→version metadata the renderer
        // stamps on every /api/* request (clientVersionHeaders) — omitting
        // these fails the preflight for the cross-origin renderer (dev Vite
        // origin / file:// packaged) before the real request fires.
        response.setHeader(
          'Access-Control-Allow-Headers',
          `Content-Type, Authorization, traceparent, tracestate, baggage, ${REQUEST_ID_HEADER}, ${CLIENT_VERSION_HEADER.protocol}, ${CLIENT_VERSION_HEADER.runtime}, ${CLIENT_VERSION_HEADER.kind}`,
        );
        // Let cross-origin renderer JS read the correlation ID echo — CORS
        // hides non-safelisted response headers by default.
        response.setHeader('Access-Control-Expose-Headers', REQUEST_ID_HEADER);
      }
      // OPTIONS preflight — short-circuit with 204 + the headers above.
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return true;
      }
    }

    // DNS-rebinding defense for state-mutating endpoints. The
    // `isLoopbackAddress` TCP-peer check and `isAllowedWorkspaceHostHeader`
    // Host-header check together block the standard rebinding pattern
    // (attacker-owned hostname whose DNS resolves to 127.0.0.1 after an
    // initial attacker-serves-JS response — the TCP peer is loopback,
    // but the Host header names the attacker domain). The same mitigation
    // already gates `/api/workspace`; without it, a rebinding page could
    // POST /api/upload + /api/agent-write, mutating the local vault.
    //
    // Test-harness note: Node's production socket always has
    // `remoteAddress` set by the kernel; the only path that reaches
    // this check without a socket is a mocked `IncomingMessage` built
    // from `Readable.from(...)`. Those mocks bypass the HTTP listener
    // entirely and can't be reached by a real remote attacker, so a
    // missing socket is treated as test-context and skips the check.
    // The Host-header gate still fires (tests set `host: 'localhost'`),
    // so the protection remains meaningful for any production path.
    if (table.isMutating(url)) {
      const peerAddress = request.socket?.remoteAddress;
      if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
        errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
          handler: 'api-mutating-gate',
        });
        return true;
      }
      if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
        errorResponse(response, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
          handler: 'api-mutating-gate',
        });
        return true;
      }
    }

    // No-project ephemeral single-file mode (`ok <file>`) sets contentDir to
    // the opened file's PARENT — often a user-data dir (~/Downloads,
    // ~/Documents). Several read routes (`/api/asset`, `/api/asset-text`,
    // `/api/document`) return bytes under contentDir bounded only by
    // `isWithinContentDir`, NOT by the single-file content scope (which is
    // enforced at the indexing/listing layer, not the byte-read path). So
    // without a host gate a DNS-rebound page could exfiltrate sibling files.
    // Apply the same loopback + workspace-host check the mutating gate uses to
    // EVERY `/api/*` request in ephemeral mode — one choke point, so future
    // read routes inherit it rather than each needing its own gate. Project /
    // desktop modes (`ephemeral` falsy) keep their prior origin-only posture
    // for reads (the user chose the served root there); this mirrors the
    // ephemeral-scoped content-asset gate in `mcp-mount.ts`, which covers the
    // non-`/api/` static-serve path.
    if (ephemeral && url.startsWith('/api/')) {
      const peerAddress = request.socket?.remoteAddress;
      if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
        errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
          handler: 'api-ephemeral-gate',
        });
        return true;
      }
      if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
        errorResponse(response, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
          handler: 'api-ephemeral-gate',
        });
        return true;
      }
    }

    // Only /api/* gets a server span. Non-API routes (static file serving,
    // Hocuspocus's own paths) fall through silently. (Route dispatch
    // happens inside the OTel active-span block below.)
    if (!url.startsWith('/api/')) return false;

    // Extract incoming trace context (W3C traceparent header) so this server
    // span attaches as a child of the browser-initiated trace.
    const extractedCtx = propagation.extract(context.active(), request.headers);

    const tracer = getTracer();
    const started = Date.now();
    await context.with(extractedCtx, () =>
      tracer.startActiveSpan(
        `HTTP ${method} ${routeTemplate}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            [ATTR_HTTP_REQUEST_METHOD]: method,
            [ATTR_HTTP_ROUTE]: routeTemplate,
            [ATTR_URL_PATH]: url,
            [ATTR_URL_SCHEME]: 'http',
            [ATTR_USER_AGENT_ORIGINAL]: request.headers['user-agent'] ?? '',
            // Correlation ID (UUID or client-supplied bounded token) — a
            // sanctioned span attribute like `ok.error.instance`; the
            // cardinality STOP rule governs metric labels, which stay
            // request-id-free.
            'ok.request.id': requestId,
          },
        },
        async (span) => {
          try {
            const dispatch = resolution.dispatch;
            if (dispatch !== undefined) {
              await dispatch(request, response);
            } else {
              // Defense-in-depth: unmatched `/api/*` routes (typos, removed
              // endpoints, empty `/api/rescue/` / `/api/history/` segments)
              // would otherwise fall through with no response body, leaving
              // Hocuspocus's `onRequest` machinery to either pass through to
              // static-file middleware or hang. Emit an explicit RFC 9457 404
              // so the dispatch surface is fully closed.
              //
              // `detail` echoes the actual requested URL (no information
              // leak — the client sent it). `routeTemplate` is bounded
              // to `/api/*` for unmatched routes and used only for
              // histogram labels / span attributes upstream — keeping
              // the two concerns separate so the wire-detail stays
              // actionable for debuggers without coupling to the
              // cardinality-bounded telemetry surface.
              errorResponse(response, 404, 'urn:ok:error:not-found', 'API endpoint not found.', {
                handler: 'api-dispatch',
                detail: `No handler for ${method} ${url}`,
              });
            }

            const status = response.statusCode;
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
            if (status >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `status ${status}` });
            }
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            // Last-resort RFC 9457 envelope. Per-handler try/catch is the
            // primary error boundary, but a synchronous throw before any
            // response write would otherwise reach the client as a
            // connection reset (or Hocuspocus default error handling) —
            // not the typed application/problem+json envelope SDK
            // consumers parse. Guard on
            // `!headersSent && !writableEnded && !destroyed` so we
            // don't double-emit when the inner handler already wrote a
            // response or the socket was destroyed mid-handler — same
            // three-way guard `createStreamingErrorWriter` uses for
            // mid-stream emission. Handler tag is the matched route
            // template so telemetry attributes a 5xx surge to the
            // failing endpoint.
            if (!response.headersSent && !response.writableEnded && !response.destroyed) {
              errorResponse(
                response,
                500,
                'urn:ok:error:internal-server-error',
                'Internal server error.',
                {
                  handler: routeTemplate,
                  cause: err,
                },
              );
            }
            // Error spans carry the HTTP status attribute too (OTel HTTP
            // server semconv) — the try-path stamp above never ran, and
            // trace UIs filter error spans by status code.
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.statusCode);
            // Re-throw so the caller's error machinery logs the exception —
            // the legacy dispatch surfaces it through Hocuspocus's onRequest
            // extension chain, the native mount through its own catch. The
            // response is already ended (either by errorResponse above or by
            // an earlier handler write), so Hocuspocus 4.x treats this as a
            // post-response observation, not a connection-level failure.
            // Verify this assumption holds when bumping Hocuspocus —
            // version-specific reaction to throws from onRequest is
            // framework-internal behavior.
            throw err;
          } finally {
            span.end();
            const durSec = (Date.now() - started) / 1000;
            httpDurationHist().record(durSec, {
              [ATTR_HTTP_REQUEST_METHOD]: method,
              [ATTR_HTTP_ROUTE]: routeTemplate,
              [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.statusCode,
            });
          }
        },
      ),
    );
    return true;
  };
}
