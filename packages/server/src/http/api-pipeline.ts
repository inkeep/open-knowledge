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
import { recordEmbedProbe } from '../embed-probe.ts';
import {
  buildIngressPolicy,
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isOriginAdmitted,
  isPeerAdmitted,
  stampIngressContext,
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import { getMeter, getTracer, onTelemetryShutdown } from '../telemetry.ts';
import { errorResponse } from './error-response.ts';
import { REQUEST_ID_HEADER, rememberRequestId, resolveRequestId } from './request-id.ts';

interface ApiRouteResolution {
  template: string;
  dispatch?: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
}

export interface ApiRouteTable {
  resolve(pathname: string): ApiRouteResolution | null;
  isMutating(pathname: string): boolean;
}

export type ApiRouteRecord = Readonly<
  Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
>;

export interface ApiRouteGroupDynamicLeg {
  prefix: string;
  template: string;
  dispatch: (
    suffix: string,
  ) => ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
}

export interface ApiRouteGroup {
  paths: readonly string[];
  table: ApiRouteTable;
}

export function createApiRouteGroup<R extends ApiRouteRecord>(
  routes: R,
  opts: {
    mutating?: readonly (string extends keyof R ? never : keyof R & string)[];
    mutatingPrefixes?: readonly string[];
    dynamic?: ApiRouteGroupDynamicLeg;
  } = {},
): ApiRouteGroup {
  const { dynamic } = opts;
  const mutating: ReadonlySet<string> = new Set(opts.mutating ?? []);
  const mutatingPrefixes: readonly string[] = opts.mutatingPrefixes ?? [];
  const routeKeys = Object.keys(routes);
  for (const prefix of mutatingPrefixes) {
    if (!prefix.endsWith('/')) {
      throw new Error(
        `mutatingPrefixes entry '${prefix}' must end in '/' — a bare prefix also matches unrelated siblings ('/api/local-op' matches '/api/local-op-status')`,
      );
    }
    if (prefix !== dynamic?.prefix && !routeKeys.some((key) => key.startsWith(prefix))) {
      throw new Error(
        `mutatingPrefixes entry '${prefix}' covers no registered route and is not the dynamic leg's prefix — a typo here leaves its family on the read posture`,
      );
    }
  }
  const routeMap = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>(
    Object.entries(routes),
  );
  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routeMap.get(url);
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      if (dynamic !== undefined && url.startsWith(dynamic.prefix)) {
        return {
          template: dynamic.template,
          dispatch: dynamic.dispatch(url.slice(dynamic.prefix.length)),
        };
      }
      return null;
    },
    isMutating: (url) => mutating.has(url) || mutatingPrefixes.some((p) => url.startsWith(p)),
  };
  return {
    paths:
      dynamic !== undefined ? [...Object.keys(routes), `${dynamic.prefix}*`] : Object.keys(routes),
    table,
  };
}

export interface ApiPipelineOptions {
  log: PinoLogger;
  policy?: IngressPolicy;
  ephemeral?: boolean;
  table: ApiRouteTable;
}

export type ApiRequestPipeline = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

let _httpDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
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
  const { log, ephemeral, table } = opts;
  const policy = opts.policy ?? buildIngressPolicy({});
  const isAllowedWorkspaceHostHeader = (host: string | undefined): boolean =>
    isHostAdmitted(host, policy);

  return async (request, response) => {
    const url = request.url?.split('?')[0];
    if (!url) return false;

    const resolution = table.resolve(url);
    if (!resolution) return false;

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

    const requestId = url.startsWith('/api/') ? resolveRequestId(request) : undefined;
    stampIngressContext(request, { requestId });
    if (requestId !== undefined) {
      rememberRequestId(request, requestId);
      if (typeof response.setHeader === 'function') {
        response.setHeader(REQUEST_ID_HEADER, requestId);
      }
      if (typeof response.once === 'function') {
        const accessStarted = Date.now();
        let accessLogged = false;
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

    if (url.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin !== undefined && !isOriginAdmitted(origin, policy)) {
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
        response.setHeader(
          'Access-Control-Allow-Headers',
          `Content-Type, Authorization, traceparent, tracestate, baggage, ${REQUEST_ID_HEADER}, ${CLIENT_VERSION_HEADER.protocol}, ${CLIENT_VERSION_HEADER.runtime}, ${CLIENT_VERSION_HEADER.kind}`,
        );
        response.setHeader('Access-Control-Expose-Headers', REQUEST_ID_HEADER);
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return true;
      }
    }

    if (table.isMutating(url)) {
      const peerAddress = request.socket?.remoteAddress;
      if (peerAddress !== undefined && !isPeerAdmitted(peerAddress, policy)) {
        errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
          handler: 'api-mutating-gate',
        });
        return true;
      }
      if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
        errorResponse(response, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
          handler: 'api-mutating-gate',
          detail: HOST_NOT_ADMITTED_REMEDIATION,
        });
        return true;
      }
    }

    if (url.startsWith('/api/')) {
      const gateHandler = ephemeral ? 'api-ephemeral-gate' : 'api-read-gate';
      const peerAddress = request.socket?.remoteAddress;
      if (peerAddress !== undefined && !isPeerAdmitted(peerAddress, policy)) {
        errorResponse(response, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
          handler: gateHandler,
        });
        return true;
      }
      if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
        errorResponse(response, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
          handler: gateHandler,
          detail: HOST_NOT_ADMITTED_REMEDIATION,
        });
        return true;
      }
    }

    if (!url.startsWith('/api/')) return false;

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
            'ok.request.id': requestId,
          },
        },
        async (span) => {
          try {
            const dispatch = resolution.dispatch;
            if (dispatch !== undefined) {
              await dispatch(request, response);
            } else {
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
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.statusCode);
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
