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
 * This wraps `detectGh` with a TTL cache keyed per host + requested account so
 * resolution costs at most one `gh` spawn per key per TTL window. Entries whose
 * requested account did not produce the token (the active account answered
 * instead, or no token at all) expire on a shorter TTL that escalates while
 * the miss persists — see the invariant at the set site. `invalidate()` drops
 * the cache so a credential change (a
 * fresh `gh auth login`, or a revoked token that just produced a classified
 * auth error) is picked up on the next cycle rather than after the TTL elapses.
 */

import type { RelayGhToken } from './git-handle.ts';
import type { DetectGhFn } from './github-permissions.ts';
import { sameGitHubLogin } from './share/git-context.ts';

export interface GhTokenSource {
  /**
   * Resolve the gh token for `host`, served from cache when fresh. Returns
   * `null` when `gh` is unavailable, not authenticated for the host, or no
   * `detectGh` was injected.
   *
   * When `login` is given the token is requested for that account
   * specifically; an account gh cannot serve degrades to the active account's
   * token rather than to no credential. The relay value's `login` names the
   * account that actually produced the token — absent after such a fallback,
   * so callers surfacing an identity never claim the account they asked for.
   */
  get(host: string, login?: string): RelayGhToken | null;
  /** Drop all cached entries so the next `get` re-resolves. */
  invalidate(): void;
}

interface CacheEntry {
  token: string | null;
  /** Account that produced `token`, as reported by `detectGh`. */
  resolvedLogin?: string;
  expiresAt: number;
}

export interface GhTokenSourceOptions {
  /** Cache lifetime per key when the request was answered as asked. Default 60s. */
  ttlMs?: number;
  /**
   * INITIAL cache lifetime for entries whose requested account did not
   * produce the token. Default 5s — long enough that a push cycle's burst of
   * git handles shares one `gh` spawn, short enough that signing the declared
   * account in takes effect within a cycle or two. A miss that persists
   * doubles this per resolution up to `ttlMs`: the modal miss (a declared
   * account that is simply never signed in) must not re-pay the doubled
   * failing candidate walk every few seconds forever, and the worst-case
   * staleness converges to the same ceiling an honored entry already has.
   * `invalidate()` — fired on OK sign-in and on classified auth errors —
   * resets the escalation, so the explicit recovery signal stays instant.
   */
  fallbackTtlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
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
  // Consecutive unhonored resolutions per key, driving the fallback-TTL
  // escalation. Cleared alongside the cache and on any honored resolution.
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

      // NUL cannot appear in a hostname or a GitHub login, so the compound key
      // never collides with a bare-host key.
      const key = `${host}\0${login ?? ''}`;
      const t = now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > t) return toRelay(cached, host);

      // `detectGh` swallows spawn failures into `{ available: false }`, and
      // its only throw is an argument-shape guard a typed caller cannot trip,
      // so no try/catch is needed here.
      const result = detectGh(host, { login });
      const token = result.available && result.token ? result.token : null;
      // Narrowed once here so the rest of the body can read the identity
      // without re-narrowing — the unavailable arm carries no fields at all,
      // matching the CLI result shape exactly.
      const resolvedLogin = result.available ? result.resolvedLogin : undefined;

      // Invariant: an entry under an account key gets the full TTL only when
      // that account produced the token. A fallback (active account answered)
      // or a miss expires on the short-but-escalating TTL: fresh misses stay
      // fast so a `gh auth login` fix lands within a cycle or two, while a
      // standing miss backs off toward the full TTL instead of re-spawning gh
      // every few seconds indefinitely.
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
