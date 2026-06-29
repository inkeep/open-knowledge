import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import type {
  OkDesktopBridge,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthSignoutResponse,
  OkLocalOpAuthStatusResponse,
} from '@/lib/desktop-bridge-types';

async function extractProblemTitle(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    const result = ProblemDetailsSchema.safeParse(body);
    if (result.success) return result.data.title;
  } catch {}
  return undefined;
}

export interface AuthQueryTransport {
  status(request?: { host?: string }): Promise<OkLocalOpAuthStatusResponse>;
  repos(request?: { host?: string }): Promise<OkLocalOpAuthReposResponse>;
  signout?(request?: { host?: string }): Promise<OkLocalOpAuthSignoutResponse>;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {}
  }
  return null;
}

export function httpAuthQueryTransport(): AuthQueryTransport {
  return {
    async status(request) {
      const host = request?.host ?? 'github.com';
      const res = await postJson('/api/local-op/auth/status', request);
      if (!res.ok) {
        const error = await extractProblemTitle(res);
        return { authenticated: false, host, error };
      }
      const data = (await res.json()) as Record<string, unknown>;
      const h = typeof data.host === 'string' ? data.host : host;
      if (data.authenticated === true && typeof data.login === 'string') {
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
    },
    async repos(request) {
      const host = request?.host ?? 'github.com';
      const res = await postJson('/api/local-op/auth/repos', request);
      if (!res.ok) {
        const title = await extractProblemTitle(res);
        return { ok: false, error: title ?? 'Failed to fetch repositories' };
      }
      const data = lastJsonLine(await res.text());
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
        const error = await extractProblemTitle(res);
        return { ok: false, error };
      }
      return { ok: true };
    },
  };
}

export function ipcAuthQueryTransport(bridge: OkDesktopBridge): AuthQueryTransport {
  return {
    status: (request) => bridge.localOp.authStatus(request),
    repos: (request) => bridge.localOp.authRepos(request),
  };
}
