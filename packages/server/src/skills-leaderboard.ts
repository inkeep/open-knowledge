/**
 * Server-side "popular skills" source for the Discover blank state.
 *
 * skills.sh has no keyless leaderboard endpoint (that data is token-gated), so we
 * scrape the front-page Next.js RSC payload and parse it with the pure
 * `parseSkillsShLeaderboard` (in core, unit-tested). This module owns the network
 * + cache half:
 *
 *   - ONE warm fetch per server, shared across all clients, cached with a short
 *     TTL (the board moves slowly). Clients never scrape skills.sh directly.
 *   - Best-effort: any failure (network, HTTP, or a 0-card parse from format
 *     drift) logs and returns the last good list if we have one, else `[]`. It
 *     NEVER throws — a scrape break degrades Discover to topic chips, it doesn't
 *     error the page.
 */

import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { parseSkillsShLeaderboard } from '@inkeep/open-knowledge-core/skills-catalog';
import { getLogger } from './logger.ts';

const log = getLogger('skills-leaderboard');

// The all-time board moves slowly; a 10-minute TTL keeps it fresh enough while
// collapsing every client's Discover open into at most one upstream fetch.
const TTL_MS = 10 * 60_000;
// Prefer the lighter RSC Flight stream (~140KB) over full HTML (~920KB); the
// parser handles either if the server ignores the header.
const FRONT_PAGE = 'https://www.skills.sh/';

let cache: { at: number; data: SkillSearchResult[] } | null = null;

/**
 * Popular skills (most-installed first) for the Discover blank state. Cached;
 * best-effort. `now` and `fetchImpl` are injectable so the fetch→parse→map→cache
 * pipeline is unit-testable offline against a fixture body (the one idea worth
 * lifting from the standalone leaderboard client — we keep the productionized
 * cache + degrade-don't-throw posture rather than its throwing CLI shape).
 */
export async function getPopularSkills(
  limit = 24,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<SkillSearchResult[]> {
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  if (cache && now - cache.at < TTL_MS) return cache.data.slice(0, limit);
  try {
    const res = await doFetch(FRONT_PAGE, {
      headers: { 'user-agent': 'open-knowledge (+skills discovery)', RSC: '1' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = parseSkillsShLeaderboard(await res.text());
    if (data.length === 0) throw new Error('parsed 0 skills (payload format may have changed)');
    cache = { at: now, data };
    return data.slice(0, limit);
  } catch (err) {
    log.warn({ err }, 'skills.sh leaderboard fetch failed — Discover falls back to topics');
    // A stale-but-real list beats an empty Discover; only truly-never-fetched
    // servers return [].
    return cache?.data.slice(0, limit) ?? [];
  }
}

/** Test seam: reset the module cache between cases. */
export function __resetPopularSkillsCache(): void {
  cache = null;
}
