import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import {
  parseSkillsShLeaderboard,
  parseSkillsShPublisherPage,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { getLogger } from './logger.ts';

const log = getLogger('skills-leaderboard');

const TTL_MS = 10 * 60_000;
const FRONT_PAGE = 'https://www.skills.sh/';

let cache: { at: number; data: SkillSearchResult[] } | null = null;

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
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = parseSkillsShLeaderboard(await res.text());
    if (data.length === 0) throw new Error('parsed 0 skills (payload format may have changed)');
    cache = { at: now, data };
    return data.slice(0, limit);
  } catch (err) {
    log.warn({ err }, 'skills.sh leaderboard fetch failed — Discover falls back to topics');
    return cache?.data.slice(0, limit) ?? [];
  }
}

export function __resetPopularSkillsCache(): void {
  cache = null;
}

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

export function __resetPublisherSkillsCache(): void {
  publisherCache.clear();
}
