import { runSubprocess } from './subprocess.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

export type AuthStatusResponse =
  | {
      authenticated: true;
      host: string;
      login: string;
      tier?: 'A' | 'B' | 'C';
      name?: string;
      email?: string;
    }
  | { authenticated: false; host: string; error?: string };

export interface RepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

export type AuthReposResponse =
  | { ok: true; host: string; repos: RepoEntry[] }
  | { ok: false; error: string };

export interface RunAuthQueryOptions {
  cliArgs: readonly string[];
  host?: string;
  timeoutMs?: number;
}

export async function runAuthStatusSubprocess(
  opts: RunAuthQueryOptions,
): Promise<AuthStatusResponse> {
  const host = opts.host ?? 'github.com';
  const lines: Record<string, unknown>[] = [];
  const proc = runSubprocess({
    cliArgs: opts.cliArgs,
    trailingArgs: ['auth', 'status', '--json', '--host', host],
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onLine: ({ parsed }) => {
      if (parsed) lines.push(parsed);
    },
  });
  const result = await proc.done;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as Record<string, unknown>;
    if (line.type !== 'status') continue;
    const lineHost = typeof line.host === 'string' ? line.host : host;
    if (line.authenticated === true && typeof line.login === 'string') {
      const tier =
        line.tier === 'A' || line.tier === 'B' || line.tier === 'C' ? line.tier : undefined;
      return {
        authenticated: true,
        host: lineHost,
        login: line.login,
        tier,
        name: typeof line.name === 'string' ? line.name : undefined,
        email: typeof line.email === 'string' ? line.email : undefined,
      };
    }
    return {
      authenticated: false,
      host: lineHost,
      error: typeof line.error === 'string' ? line.error : undefined,
    };
  }
  return {
    authenticated: false,
    host,
    error: result.timedOut
      ? 'auth status timed out'
      : result.code !== 0
        ? result.stderr || `auth status exited with code ${result.code ?? -1}`
        : undefined,
  };
}

export async function runAuthReposSubprocess(
  opts: RunAuthQueryOptions,
): Promise<AuthReposResponse> {
  const host = opts.host ?? 'github.com';
  const lines: Record<string, unknown>[] = [];
  const proc = runSubprocess({
    cliArgs: opts.cliArgs,
    trailingArgs: ['auth', 'repos', '--json', '--host', host],
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onLine: ({ parsed }) => {
      if (parsed) lines.push(parsed);
    },
  });
  const result = await proc.done;
  if (result.timedOut) return { ok: false, error: 'auth repos timed out' };
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr || `auth repos exited with code ${result.code ?? -1}`,
    };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as Record<string, unknown>;
    if (line.type !== 'repos' || !Array.isArray(line.repos)) continue;
    const repos: RepoEntry[] = [];
    for (const r of line.repos) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.full_name !== 'string' || typeof rec.clone_url !== 'string') continue;
      repos.push({
        full_name: rec.full_name,
        clone_url: rec.clone_url,
        private: rec.private === true,
      });
    }
    return {
      ok: true,
      host: typeof line.host === 'string' ? line.host : host,
      repos,
    };
  }
  return { ok: false, error: 'auth repos returned no data' };
}
