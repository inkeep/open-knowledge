import type { Config, SkillScope } from '@inkeep/open-knowledge-core';

export const PIN_FIELD = { project: 'pinnedProjectSkills', global: 'pinnedGlobalSkills' } as const;

export function readPins(
  config: Config | null | undefined,
  scope: SkillScope,
): ReadonlySet<string> {
  const raw = config?.appearance?.sidebar?.[PIN_FIELD[scope]];
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name) out.add(name);
  }
  return out;
}

export function togglePin(current: ReadonlySet<string>, name: string, pinned: boolean): string[] {
  const next = new Set(current);
  if (pinned) next.add(name);
  else next.delete(name);
  return [...next].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
