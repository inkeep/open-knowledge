import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InstalledAgentsSuccessSchema } from '@inkeep/open-knowledge-core';
import { errorResponse } from './http/error-response.ts';
import { successResponse } from './http/success-response.ts';

export const INSTALLED_AGENTS_SCHEMES = ['claude', 'codex', 'cursor'] as const;
export type InstalledAgentScheme = (typeof INSTALLED_AGENTS_SCHEMES)[number];

export const INSTALLED_AGENTS_CACHE_TTL_MS = 60_000;
const INSTALLED_AGENTS_PROBE_TIMEOUT_MS = 2000;

const MACOS_APP_NAMES: Record<InstalledAgentScheme, ReadonlyArray<string>> = {
  claude: ['Claude'],
  codex: ['Codex', 'OpenAI Codex'],
  cursor: ['Cursor'],
};

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts: { timeout?: number; encoding?: BufferEncoding },
  cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
) => void;

interface InstalledAgentsProbeDeps {
  probe: (scheme: InstalledAgentScheme) => Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
}

type CacheEntry =
  | { status: 'resolved'; installed: boolean; expiresAt: number }
  | { status: 'inflight'; promise: Promise<boolean> };

export function createInstalledAgentsProbe(deps: InstalledAgentsProbeDeps): {
  probeAll: () => Promise<Record<InstalledAgentScheme, boolean>>;
  probeWithCache: (scheme: InstalledAgentScheme) => Promise<boolean>;
} {
  const cache = new Map<InstalledAgentScheme, CacheEntry>();
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? INSTALLED_AGENTS_CACHE_TTL_MS;

  async function probeWithCache(scheme: InstalledAgentScheme): Promise<boolean> {
    const cached = cache.get(scheme);
    if (cached?.status === 'resolved' && cached.expiresAt > now()) {
      return cached.installed;
    }
    if (cached?.status === 'inflight') {
      return cached.promise;
    }
    const promise = (async () => {
      try {
        const installed = await deps.probe(scheme);
        cache.set(scheme, { status: 'resolved', installed, expiresAt: now() + ttl });
        return installed;
      } catch {
        cache.set(scheme, { status: 'resolved', installed: false, expiresAt: now() + ttl });
        return false;
      }
    })();
    cache.set(scheme, { status: 'inflight', promise });
    return promise;
  }

  async function probeAll(): Promise<Record<InstalledAgentScheme, boolean>> {
    const entries = await Promise.all(
      INSTALLED_AGENTS_SCHEMES.map(
        async (s): Promise<readonly [InstalledAgentScheme, boolean]> => [
          s,
          await probeWithCache(s),
        ],
      ),
    );
    return Object.fromEntries(entries) as Record<InstalledAgentScheme, boolean>;
  }

  return { probeAll, probeWithCache };
}

export function isLocalWebHost(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader === 'string' && hostHeader.length > 0) {
    try {
      const { hostname } = new URL(`http://${hostHeader}/`);
      return isLoopbackHostname(hostname);
    } catch {}
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return isLoopbackHostname(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return true;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export async function handleInstalledAgents(
  req: IncomingMessage,
  res: ServerResponse,
  probeAll: () => Promise<Record<InstalledAgentScheme, boolean>>,
): Promise<void> {
  if (req.method !== 'GET') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'installed-agents',
      extraHeaders: { Allow: 'GET' },
    });
    return;
  }
  try {
    const result = isLocalWebHost(req)
      ? await probeAll()
      : (Object.fromEntries(INSTALLED_AGENTS_SCHEMES.map((s) => [s, true] as const)) as Record<
          InstalledAgentScheme,
          boolean
        >);
    successResponse(res, 200, InstalledAgentsSuccessSchema, result, {
      handler: 'installed-agents',
    });
  } catch (e) {
    console.error('[installed-agents]', e);
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: 'installed-agents',
      cause: e,
    });
  }
}

export function createOsProbe(
  platform: NodeJS.Platform,
  exec: ExecFileLike = execFile as ExecFileLike,
): (scheme: InstalledAgentScheme) => Promise<boolean> {
  return (scheme) => {
    if (platform === 'darwin') return probeMacOs(scheme, exec);
    if (platform === 'win32') return probeWindows(scheme, exec);
    return probeLinux(scheme, exec);
  };
}

function probeMacOs(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  const candidates = MACOS_APP_NAMES[scheme];
  function tryCandidate(appName: string): Promise<boolean> {
    return new Promise((resolve) => {
      exec(
        'osascript',
        ['-e', `id of app "${appName}"`],
        { timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
        (err, stdout) => {
          if (err) {
            resolve(false);
            return;
          }
          resolve(stdout.trim().length > 0);
        },
      );
    });
  }
  return (async () => {
    for (const candidate of candidates) {
      if (await tryCandidate(candidate)) return true;
    }
    return false;
  })();
}

function probeWindows(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      'reg',
      ['query', `HKCR\\${scheme}`, '/ve'],
      { timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      (err) => {
        resolve(!err);
      },
    );
  });
}

function probeLinux(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      'xdg-mime',
      ['query', 'default', `x-scheme-handler/${scheme}`],
      { timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().length > 0);
      },
    );
  });
}
