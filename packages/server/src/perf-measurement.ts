/**
 * Hocuspocus server-side memory instrumentation.
 *
 * Captures Node `process.memoryUsage()` per-cell so the sweep harness can
 * attribute MAX_POOL-driven Y.Doc retention server-side. Server-side memory
 * growth is invisible from the renderer — without this surface, the cap-
 * graduation campaign can only see renderer-side RSS and misses the
 * 1-5 MB/doc amplification that scales with pool size.
 *
 * The HTTP route is DEV-only:
 *   - Gated on `NODE_ENV !== 'production'` AND `OK_PERF_SERVER_MEMORY_ENABLED=true`.
 *   - Either gate alone unset → 404 (matches the codebase precedent for
 *     disabled DEV-only routes via api-extension's unmatched-route 404 path).
 *   - Never registered into a shipped build — the env var is the explicit
 *     opt-in surface, mirroring the renderer-side __ok_perf collector posture.
 *
 * Response shape is pre-converted to MB so consumers do not re-derive the
 * unit. `schemaVersion: 1` is a forward-compat anchor — readers can fail
 * loud on a future v2 change rather than silently coerce.
 */

import type { ServerResponse } from 'node:http';
import type { Extension, Hocuspocus } from '@hocuspocus/server';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';

/**
 * Canonical route exposed by `installPerfMeasurementHttpRoute`. Exported so
 * the sweep harness (consumer) can scrape this exact path without
 * hand-coding the URL in two places.
 */
export const PERF_SERVER_MEMORY_ROUTE = '/__ok_perf/server-memory';

/**
 * The current schema version for the JSON response body. Bumping requires
 * updating downstream sweep-harness consumers; readers should fail loud on
 * a mismatch rather than coerce. Not exported — consumers read the version
 * off the snapshot itself (`snapshot.schemaVersion`) so we don't need to
 * publish a second import surface for the same value.
 */
const SERVER_MEMORY_SCHEMA_VERSION = 1 as const;

/** Server-side memory snapshot. All sizes in MB, ISO8601 timestamp. */
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

/**
 * Capture the current process memory snapshot. Pure function — safe to call
 * from any context (no I/O beyond the `process.memoryUsage` syscall).
 */
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

/**
 * Returns true iff both DEV gates are satisfied (NODE_ENV is an explicit
 * 'development' or 'test' marker AND OK_PERF_SERVER_MEMORY_ENABLED is the
 * literal string "true"). Evaluated per-request so an operator can flip
 * the env var without restart — the route is engineer-local sweep
 * instrumentation; per-request cost is negligible.
 *
 * The NODE_ENV check is affirmative (`=== 'development' || === 'test'`)
 * rather than `!== 'production'`. Under Bun, `NODE_ENV` is `undefined` by
 * default, so the negative form would treat unset = production-safe,
 * defeating the gate's purpose; the affirmative form fails closed.
 */
function isRouteEnabled(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return false;
  return process.env.OK_PERF_SERVER_MEMORY_ENABLED === 'true';
}

/**
 * Strip an optional `?query=string` suffix so the route matches regardless
 * of caller-attached tagging (e.g. `?cell=42` for sweep correlation).
 */
function urlPathOf(rawUrl: string | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
}

/**
 * Install the GET /__ok_perf/server-memory route on a Hocuspocus server.
 *
 * **This function is library-only and is NOT called by `bootServer()` or
 * the dev-server `hocuspocus-plugin` by default.** The cap-graduation
 * sweep scenario (`packages/app/tests/perf/scenarios/sweep-cache-regime.ts`)
 * is the intended caller: it installs the route into the dev server it
 * boots for the campaign, scrapes the route per-cell to capture the
 * server-amplification axis, and tears the server down at campaign exit.
 * Production binaries never call this; the route is unreachable in
 * shipped builds.
 *
 * Pushes a minimal Extension onto `server.configuration.extensions` whose
 * onRequest handler short-circuits when:
 *   - the URL matches PERF_SERVER_MEMORY_ROUTE AND
 *   - the method is GET AND
 *   - both DEV gates pass (`NODE_ENV in {development,test}` AND
 *     `OK_PERF_SERVER_MEMORY_ENABLED=true`).
 *
 * Otherwise the handler is a silent no-op (returns without writing) so
 * sibling extensions (api-extension's onRequest, Hocuspocus's static-file
 * middleware) own the response. The single exception is route + GET +
 * disabled gates → 404; that closes the dispatch loop for the route's own
 * URL when the operator hasn't opted in.
 *
 * Uses `configuration.extensions.push` (NOT `configure({ extensions: [] })`)
 * because the latter REPLACES the array.
 */
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

      // Defense-in-depth: even when both DEV gates pass, refuse non-loopback
      // peers + non-allowlisted Host headers. The information disclosure
      // impact (RSS/heap MB, not secrets) is low, but matching the same
      // gate api-extension.ts applies to /api/principal + /api/workspace
      // keeps the route's posture consistent with the rest of the package
      // — engineers don't have to remember which DEV-only routes are
      // safe under `--host 0.0.0.0`.
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
  // 404 carries a minimal `{ "error": "route disabled" }` body. Sending an
  // empty body with `Content-Type: application/json` makes strict consumers
  // throw "Unexpected end of JSON input" on `await res.json()` instead of
  // surfacing the real reason (the gate isn't enabled). 200 carries the
  // serialized ServerMemorySnapshot. Both set application/json so the wire
  // shape is unambiguous to fetch() consumers.
  //
  // X-Content-Type-Options: nosniff prevents browsers from MIME-sniffing
  // the response body — a small defense-in-depth alongside the loopback
  // gate. Cache-Control: no-store prevents any intermediate proxy from
  // caching the live process-memory telemetry; even though the route is
  // loopback-only, the cell-results JSON downstream consumers read should
  // always reflect the moment of capture, not a stale prior reading.
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}
