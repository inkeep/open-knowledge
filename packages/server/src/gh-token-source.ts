
import type { RelayGhToken } from './git-handle.ts';
import type { DetectGhFn } from './github-permissions.ts';

export interface GhTokenSource {
  get(host: string): RelayGhToken | null;
  invalidate(): void;
}

interface CacheEntry {
  token: string | null;
  expiresAt: number;
}

export interface GhTokenSourceOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

export function createGhTokenSource(
  detectGh: DetectGhFn | undefined,
  options: GhTokenSourceOptions = {},
): GhTokenSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    get(host: string): RelayGhToken | null {
      if (!detectGh) return null;

      const t = now();
      const cached = cache.get(host);
      if (cached && cached.expiresAt > t) {
        return cached.token != null ? { token: cached.token, host } : null;
      }

      const result = detectGh(host);
      const token = result.available && result.token ? result.token : null;
      cache.set(host, { token, expiresAt: t + ttlMs });
      return token != null ? { token, host } : null;
    },

    invalidate(): void {
      cache.clear();
    },
  };
}
