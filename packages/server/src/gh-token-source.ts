/**
 * Cached gh-token resolver for the sync engine's credential relay.
 *
 * The sync engine authenticates git over HTTPS by relaying a `gh` token down to
 * the credential helper (see `RelayGhToken` in `git-handle.ts`). The token comes
 * from the injected `DetectGhFn` — the same `gh auth token` shell-out the
 * push-permission probe already uses — but `detectGh` is a synchronous
 * `execFileSync` with a multi-second timeout ceiling, and a single push cycle
 * creates many git handles. Resolving on every handle would spawn `gh`
 * repeatedly on the hot path.
 *
 * This wraps `detectGh` with a short per-host TTL cache so resolution costs at
 * most one `gh` spawn per host per `ttlMs` window. `invalidate()` drops the
 * cache so a credential change (a fresh `gh auth login`, or a revoked token that
 * just produced a classified auth error) is picked up on the next cycle rather
 * than after the TTL elapses.
 */

import type { RelayGhToken } from './git-handle.ts';
import type { DetectGhFn } from './github-permissions.ts';

export interface GhTokenSource {
  /**
   * Resolve the gh token for `host`, served from cache when fresh. Returns
   * `null` when `gh` is unavailable, not authenticated for the host, or no
   * `detectGh` was injected.
   */
  get(host: string): RelayGhToken | null;
  /** Drop all cached entries so the next `get` re-resolves. */
  invalidate(): void;
}

interface CacheEntry {
  token: string | null;
  expiresAt: number;
}

export interface GhTokenSourceOptions {
  /** Cache lifetime per host. Default 60s. */
  ttlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
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

      // `detectGh` never throws (it swallows spawn failures into
      // `{ available: false }`), so no try/catch is needed here.
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
