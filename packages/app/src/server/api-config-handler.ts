/**
 * Dev-only `/api/config` handler for the Vite plugin.
 *
 * In production the endpoint is served by `ok ui`. `bun run dev` combines collab
 * and the React app on one port, so it needs its own handler — the response
 * shape mirrors `ok ui` exactly so the client (`api-config.ts`,
 * `use-collab-url.ts`) treats dev and prod identically.
 *
 * Extracted as a pure function so it can be unit-tested without spinning up
 * Vite. The Vite plugin supplies the port from its own `httpServer.address()`
 * since dev serves the collab WebSocket on the same port.
 */

interface DevApiConfigResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** HEAD requests: return status + headers only, skip writing the body. */
  omitBody: boolean;
}

/**
 * Compute the `/api/config` response for a given method + resolved dev port.
 * Returns `null` for methods other than GET/HEAD — callers should fall
 * through so the catch-all returns a 404 JSON.
 *
 * Body shape: `{ collabUrl, previewUrl, port, paneTarget }` — matches `ok ui`.
 * `collabUrl` is null when `port <= 0` (server not yet bound); callers
 * should not invoke this before the dev server has emitted 'listening'.
 * `paneTarget` is always null in dev — the armed-pane-target store is an
 * `ok ui` concern (the Claude pane opens against `ok ui`, not `bun run dev`),
 * but the field rides the dev response too so the dev/prod shape stays identical.
 */
export function computeDevApiConfigResponse(
  method: string | undefined,
  port: number,
  singleFile = false,
): DevApiConfigResponse | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const collabUrl = port > 0 ? `ws://localhost:${port}/collab` : null;
  return {
    status: 200,
    body: JSON.stringify({ collabUrl, previewUrl: null, port, paneTarget: null, singleFile }),
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    omitBody: method === 'HEAD',
  };
}
