/**
 * Transport abstraction for one-shot auth queries — `auth status` (is the
 * user signed in?), `auth repos` (list of accessible repositories), and
 * `auth signout` (clear OpenKnowledge's own stored credential).
 *
 * Two implementations:
 *   - `httpAuthQueryTransport` — wraps `fetch('/api/local-op/auth/...')`.
 *     Default for editor windows + web distribution.
 *   - `ipcAuthQueryTransport` — wraps `bridge.localOp.authStatus()` /
 *     `.authRepos()`. Used by the Project Navigator window where there
 *     is no backing API server (apiOrigin is empty).
 *
 * Bounded responses on every method (status: one line; repos: bounded
 * list; signout: success/failure), so no streaming surface is needed.
 */

import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import type {
  OkDesktopBridge,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthSignoutResponse,
  OkLocalOpAuthStatusResponse,
} from '@/lib/desktop-bridge-types';

/**
 * Client-side fallback only — the coalescing-map key and the display `host`
 * on error responses when the caller omitted one. Deliberately NOT sent on
 * the wire: a host-less request lets the server derive the host from the
 * workspace's origin remote, which the client cannot know. Workspace-scoped
 * callers should omit `host`.
 */
const DEFAULT_AUTH_QUERY_HOST = 'github.com';
// Default HTTP transports are created per component; keep status single-flight
// at module scope so overlapping callers share one local-op request.
const authStatusInFlight = new Map<string, Promise<OkLocalOpAuthStatusResponse>>();

/**
 * Extract the RFC 9457 problem+json title from a pre-stream error body for
 * surfacing the typed reason (rate limit, origin rejection, auth failure)
 * instead of a generic fallback. Mirrors the pattern in auth-transport.ts /
 * clone-transport.ts pre-stream branch — the three transports form a
 * cohesive family that all surface ProblemDetails titles consistently.
 */
async function extractProblemTitle(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    const result = ProblemDetailsSchema.safeParse(body);
    if (result.success) return result.data.title;
  } catch {
    /* non-JSON body or empty — fall through to caller's generic */
  }
  return undefined;
}

export interface AuthQueryTransport {
  status(request?: { host?: string }): Promise<OkLocalOpAuthStatusResponse>;
  repos(request?: { host?: string }): Promise<OkLocalOpAuthReposResponse>;
  // Optional: the HTTP transport implements signout; the IPC transport does not.
  signout?(request?: { host?: string }): Promise<OkLocalOpAuthSignoutResponse>;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function requestAuthStatus(request?: {
  host?: string;
}): Promise<OkLocalOpAuthStatusResponse> {
  const host = request?.host ?? DEFAULT_AUTH_QUERY_HOST;
  const res = await postJson('/api/local-op/auth/status', request);
  if (!res.ok) {
    // Surface the typed RFC 9457 title (e.g. "Origin not allowed.",
    // "Loopback required.") instead of dropping the structured
    // diagnosis. Sibling transports do the same.
    const error = await extractProblemTitle(res);
    return { authenticated: false, host, error };
  }
  const data = (await res.json()) as Record<string, unknown>;
  const h = typeof data.host === 'string' ? data.host : host;
  if (data.authenticated === true && typeof data.login === 'string') {
    // Mirror the whitelist in auth-query.ts so the HTTP and IPC paths
    // surface `tier` consistently — without this, only IPC carries it.
    const tier =
      data.tier === 'A' || data.tier === 'B' || data.tier === 'C' ? data.tier : undefined;
    return {
      authenticated: true,
      host: h,
      login: data.login,
      tier,
      name: typeof data.name === 'string' ? data.name : undefined,
      email: typeof data.email === 'string' ? data.email : undefined,
    };
  }
  return {
    authenticated: false,
    host: h,
    error: typeof data.error === 'string' ? data.error : undefined,
  };
}

function coalescedAuthStatus(request?: { host?: string }): Promise<OkLocalOpAuthStatusResponse> {
  const host = request?.host ?? DEFAULT_AUTH_QUERY_HOST;
  const existing = authStatusInFlight.get(host);
  if (existing) return existing;

  const promise = requestAuthStatus(request).finally(() => {
    authStatusInFlight.delete(host);
  });
  authStatusInFlight.set(host, promise);
  return promise;
}

/**
 * Pull the last parseable JSON line out of an NDJSON-ish body. The HTTP
 * relays for status / repos emit one structured line; older builds may
 * prefix with non-JSON log output.
 */
function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* skip non-JSON */
    }
  }
  return null;
}

/** HTTP transport — wraps the `/api/local-op/auth/{status,repos}` endpoints. */
export function httpAuthQueryTransport(): AuthQueryTransport {
  return {
    status: coalescedAuthStatus,
    async repos(request) {
      const host = request?.host ?? 'github.com';
      const res = await postJson('/api/local-op/auth/repos', request);
      if (!res.ok) {
        // Surface the typed RFC 9457 title from pre-stream errors (host
        // not allowed, loopback required, rate limit, etc.) instead of
        // the generic fallback. Mirrors the auth-transport.ts and
        // clone-transport.ts pre-stream pattern.
        const title = await extractProblemTitle(res);
        return { ok: false, error: title ?? 'Failed to fetch repositories' };
      }
      // CLI emits a single `{repos: [...]}` line; relay forwards as-is.
      // No streaming reader needed — read the whole body and parse.
      const data = lastJsonLine(await res.text());
      // Surface mid-stream RFC 9457 streaming-error envelope so the UI
      // shows the typed reason (rate limit, auth error) instead of a
      // generic "Failed to fetch" when the server emitted a problem.
      if (data && data.type === 'error' && data.problem && typeof data.problem === 'object') {
        const p = data.problem as { title?: string; detail?: string };
        return { ok: false, error: p.detail || p.title || 'Failed to fetch repositories' };
      }
      if (!data || !Array.isArray(data.repos)) {
        return { ok: false, error: 'Failed to fetch repositories' };
      }
      const repos: { full_name: string; clone_url: string; private: boolean }[] = [];
      for (const r of data.repos) {
        const rec = r as Record<string, unknown>;
        if (typeof rec?.full_name === 'string' && typeof rec.clone_url === 'string') {
          repos.push({
            full_name: rec.full_name,
            clone_url: rec.clone_url,
            private: rec.private === true,
          });
        }
      }
      return { ok: true, host: typeof data.host === 'string' ? data.host : host, repos };
    },
    async signout(request) {
      const res = await postJson('/api/local-op/auth/signout', request);
      if (!res.ok) {
        // Surface the typed RFC 9457 title (auth-failed, concurrent-operation,
        // origin rejection) so the disconnect UI shows the real reason. Success
        // returns an empty body — the HTTP status is the only signal.
        // Leave `error` undefined when the server gave no title — AccountSection
        // renders a localized fallback rather than an English literal here.
        const error = await extractProblemTitle(res);
        return { ok: false, error };
      }
      return { ok: true };
    },
  };
}

/** IPC transport — wraps `bridge.localOp.{authStatus,authRepos}` directly. */
export function ipcAuthQueryTransport(bridge: OkDesktopBridge): AuthQueryTransport {
  return {
    status: (request) => bridge.localOp.authStatus(request),
    repos: (request) => bridge.localOp.authRepos(request),
  };
}
