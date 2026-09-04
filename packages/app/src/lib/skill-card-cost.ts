import { estimateSkillCost, type SkillCostTiers } from '@inkeep/open-knowledge-core';
import { fetchSkillPreview } from '@/lib/skills-api';

const cache = new Map<string, SkillCostTiers | null>();
const inFlight = new Map<string, Promise<SkillCostTiers | null>>();

function keyOf(source: string, name: string): string {
  return `${source}::${name}`;
}

export function peekSkillCardCost(source: string, name: string): SkillCostTiers | null | undefined {
  return cache.get(keyOf(source, name));
}

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

export function clearSkillCardCostCache(): void {
  cache.clear();
  inFlight.clear();
}
