import type { ServerResponse } from 'node:http';
import type { Extension, Hocuspocus } from '@hocuspocus/server';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';

export const PERF_SERVER_MEMORY_ROUTE = '/__ok_perf/server-memory';

const SERVER_MEMORY_SCHEMA_VERSION = 1 as const;

export interface ServerMemorySnapshot {
  readonly schemaVersion: typeof SERVER_MEMORY_SCHEMA_VERSION;
  readonly capturedAt: string;
  readonly snapshot: {
    readonly rssMb: number;
    readonly heapTotalMb: number;
    readonly heapUsedMb: number;
    readonly externalMb: number;
    readonly arrayBuffersMb: number;
  };
}

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

export function captureServerMemorySnapshot(): ServerMemorySnapshot {
  const mem = process.memoryUsage();
  return {
    schemaVersion: SERVER_MEMORY_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    snapshot: {
      rssMb: toMb(mem.rss),
      heapTotalMb: toMb(mem.heapTotal),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers),
    },
  };
}

function isRouteEnabled(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return false;
  return process.env.OK_PERF_SERVER_MEMORY_ENABLED === 'true';
}

function urlPathOf(rawUrl: string | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
}

export function installPerfMeasurementHttpRoute(server: Hocuspocus): void {
  const extension: Extension = {
    async onRequest({ request, response }) {
      if (request.method !== 'GET') return;
      const path = urlPathOf(request.url);
      if (path !== PERF_SERVER_MEMORY_ROUTE) return;

      if (!isRouteEnabled()) {
        writeJsonResponse(response, 404, JSON.stringify({ error: 'route disabled' }));
        return;
      }

      if (!isLoopbackAddress(request.socket?.remoteAddress)) {
        writeJsonResponse(response, 403, JSON.stringify({ error: 'loopback required' }));
        return;
      }
      if (!isAllowedWorkspaceHostHeader(request.headers.host)) {
        writeJsonResponse(response, 403, JSON.stringify({ error: 'host header not allowed' }));
        return;
      }

      const body = JSON.stringify(captureServerMemorySnapshot());
      writeJsonResponse(response, 200, body);
    },
  };
  server.configuration.extensions.push(extension);
}

function writeJsonResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}
