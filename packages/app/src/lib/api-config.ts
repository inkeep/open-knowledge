/**
 * `/api/config` client — fetches the UI's collab-bootstrap payload.
 *
 * Served by `ok ui` post-lifecycle-split AND by the Vite dev plugin
 * (`packages/app/src/server/api-config-handler.ts`) — both answer with the
 * same shape `{collabUrl, previewUrl, port}` where `collabUrl` is
 * `ws://localhost:<port>/collab` when a collab server is bound, else `null`.
 *
 * Result classification:
 *   - `{ status: 'ok', config }` — endpoint responded with a valid shape.
 *   - `{ status: 'absent' }`      — 404 / 501. Retained as defense-in-depth
 *                                   for unusual deployments (misconfigured
 *                                   proxy, mixed-version upgrade) that drop
 *                                   the endpoint; caller falls back to the
 *                                   same-origin WS URL.
 *   - `{ status: 'error', code }` — 5xx, network failure, or malformed body.
 *                                   Caller retries with backoff.
 *
 * Collapsing all failures to `null` (the previous shape) masked genuine
 * misconfigurations (e.g. corrupt `server.lock`) as dev-mode 404s, producing
 * a silent fallback to the wrong WebSocket URL.
 */

interface ApiConfig {
  collabUrl: string | null;
  previewUrl: string | null;
  port: number;
  /**
   * Armed pane-target route fragment (`#/<doc>` or `#/<folder>/`), TTL-bounded
   * server-side. Present only when an agent armed an explicit deep-link target
   * via `preview_url({ armPaneTarget: true })`; the app applies it once on a
   * base-open. `null` when unarmed or expired.
   */
  paneTarget: string | null;
  /**
   * `true` when served by a no-project ephemeral single-file server (`ok <file>`).
   * The browser fallback reads this to drop project chrome (the desktop reads the
   * same signal from the bridge config — it loads from `file://`, off-origin from
   * this endpoint). Absent/false on every normal project server.
   */
  singleFile: boolean;
}

export type FetchApiConfigResult =
  | { status: 'ok'; config: ApiConfig }
  | { status: 'absent' }
  | { status: 'error'; code: number | 'network' | 'invalid-body' };

export async function fetchApiConfig(signal?: AbortSignal): Promise<FetchApiConfigResult> {
  let res: Response;
  try {
    res = await fetch('/api/config', {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    return { status: 'error', code: 'network' };
  }
  if (res.status === 404 || res.status === 501) {
    return { status: 'absent' };
  }
  if (!res.ok) {
    return { status: 'error', code: res.status };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', code: 'invalid-body' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'error', code: 'invalid-body' };
  }
  const obj = body as Record<string, unknown>;
  return {
    status: 'ok',
    config: {
      collabUrl: typeof obj.collabUrl === 'string' ? obj.collabUrl : null,
      previewUrl: typeof obj.previewUrl === 'string' ? obj.previewUrl : null,
      port: typeof obj.port === 'number' ? obj.port : 0,
      paneTarget: typeof obj.paneTarget === 'string' ? obj.paneTarget : null,
      singleFile: obj.singleFile === true,
    },
  };
}
