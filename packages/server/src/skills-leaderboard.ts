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
import {
  parseSkillsShLeaderboard,
  parseSkillsShPublisherPage,
} from '@inkeep/open-knowledge-core/skills-catalog';
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
      // Don't follow redirects: the host was decided here, and following would
      // let the response come from somewhere this code never vetted. A 3xx is
      // not `ok`, so it degrades like any other bad response. Same posture as
      // `fetchWithinOrigin` in the website-skill fetcher.
      redirect: 'manual',
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

/**
 * Every skill one publisher lists on skills.sh, most-installed first.
 *
 * Same posture as {@link getPopularSkills} — one warm fetch per publisher shared
 * across clients, short TTL, and a failure returns the last good list (else
 * `[]`) rather than throwing, because a caller that can't rank still has a list
 * to show from its other source.
 *
 * Keyed per source: the map is bounded by the handful of publishers a build
 * actually asks for (today, ours), not by user input.
 */
const publisherCache = new Map<string, { at: number; data: SkillSearchResult[] }>();

export async function getPublisherSkills(
  source: string,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<SkillSearchResult[]> {
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const hit = publisherCache.get(source);
  if (hit && now - hit.at < TTL_MS) return hit.data;
  try {
    // No RSC header here: the publisher page keeps its install counts in
    // rendered markup, so the Flight stream the front page is read through
    // would come back without the numbers this exists to get.
    const res = await doFetch(`https://www.skills.sh/${source}`, {
      headers: { 'user-agent': 'open-knowledge (+skills discovery)' },
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = parseSkillsShPublisherPage(await res.text(), source);
    if (data.length === 0) throw new Error('parsed 0 skills (page format may have changed)');
    publisherCache.set(source, { at: now, data });
    return data;
  } catch (err) {
    log.warn({ err, source }, 'skills.sh publisher page fetch failed — install counts unavailable');
    return hit?.data ?? [];
  }
}

/** Test seam: reset the per-publisher cache between cases. */
export function __resetPublisherSkillsCache(): void {
  publisherCache.clear();
}
