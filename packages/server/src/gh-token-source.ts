import type { RelayGhToken } from './git-handle.ts';
import type { DetectGhFn } from './github-permissions.ts';
import { sameGitHubLogin } from './share/git-context.ts';

export interface GhTokenSource {
  get(host: string, login?: string): RelayGhToken | null;
  invalidate(): void;
}

interface CacheEntry {
  token: string | null;
  resolvedLogin?: string;
  expiresAt: number;
}

export interface GhTokenSourceOptions {
  ttlMs?: number;
  fallbackTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FALLBACK_TTL_MS = 5_000;

export function createGhTokenSource(
  detectGh: DetectGhFn | undefined,
  options: GhTokenSourceOptions = {},
): GhTokenSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fallbackTtlMs = options.fallbackTtlMs ?? DEFAULT_FALLBACK_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const missStreak = new Map<string, number>();

  function toRelay(entry: CacheEntry, host: string): RelayGhToken | null {
    if (entry.token == null) return null;
    return {
      token: entry.token,
      host,
      ...(entry.resolvedLogin ? { login: entry.resolvedLogin } : {}),
    };
  }

  return {
    get(host: string, login?: string): RelayGhToken | null {
      if (!detectGh) return null;

      const key = `${host}\0${login ?? ''}`;
      const t = now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > t) return toRelay(cached, host);

      const result = detectGh(host, { login });
      const token = result.available && result.token ? result.token : null;
      const resolvedLogin = result.available ? result.resolvedLogin : undefined;

      const honored = !login || (token != null && sameGitHubLogin(resolvedLogin, login));
      let entryTtl: number;
      if (honored) {
        missStreak.delete(key);
        entryTtl = ttlMs;
      } else {
        const misses = missStreak.get(key) ?? 0;
        missStreak.set(key, misses + 1);
        entryTtl = Math.min(fallbackTtlMs * 2 ** misses, ttlMs);
      }
      const entry: CacheEntry = {
        token,
        resolvedLogin,
        expiresAt: t + entryTtl,
      };
      cache.set(key, entry);
      return toRelay(entry, host);
    },

    invalidate(): void {
      cache.clear();
      missStreak.clear();
    },
  };
}
