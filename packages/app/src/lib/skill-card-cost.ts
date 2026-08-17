import { estimateSkillCost, type SkillCostTiers } from '@inkeep/open-knowledge-core';
import { fetchSkillPreview } from '@/lib/skills-api';

/**
 * Hover-resolved context cost for a skills.sh directory card.
 *
 * The figure is NOT free: skills.sh publishes no size, so the only way to price
 * a card is to fetch its bundle, which clones the source server-side. Resolving
 * every card in a grid would clone once per distinct source on every settled
 * query, so this runs on hover only — a card the user never points at costs
 * nothing. Siblings are cheap because the server caches the clone by source, so
 * the second card from one repo reuses the first card's clone.
 *
 * Results are memoised per `source::name` for the session, including MISSES:
 * a source that cannot be cloned should not be retried on every re-hover.
 */
const cache = new Map<string, SkillCostTiers | null>();
const inFlight = new Map<string, Promise<SkillCostTiers | null>>();

function keyOf(source: string, name: string): string {
  return `${source}::${name}`;
}

/** Cached figure, or `undefined` when this card has never been resolved. */
export function peekSkillCardCost(source: string, name: string): SkillCostTiers | null | undefined {
  return cache.get(keyOf(source, name));
}

/**
 * Resolve (and memoise) a card's cost. Concurrent hovers on the same card share
 * one request. A failed fetch resolves to `null` — the card must render exactly
 * as it does today rather than surfacing an error for a decorative figure.
 */
export async function resolveSkillCardCost(
  source: string,
  name: string,
): Promise<SkillCostTiers | null> {
  const key = keyOf(source, name);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<SkillCostTiers | null> => {
    try {
      const res = await fetchSkillPreview({ source, name });
      if (!res.ok) return null;
      return estimateSkillCost({
        name: res.name,
        description: res.description ?? '',
        skillMd: res.skillMd,
        files: res.files,
      });
    } catch {
      // Network/abort — indistinguishable from "no figure available" for a
      // decorative card annotation.
      return null;
    }
  })();

  inFlight.set(key, run);
  try {
    const value = await run;
    cache.set(key, value);
    return value;
  } finally {
    inFlight.delete(key);
  }
}

/** Test seam — drops every memoised figure. */
export function clearSkillCardCostCache(): void {
  cache.clear();
  inFlight.clear();
}
