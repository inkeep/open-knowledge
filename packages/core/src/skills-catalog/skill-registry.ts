import {
  groupSkillsByIdentity,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillOccurrence,
} from './dedup.ts';

export interface LocatedSkillOccurrence extends SkillOccurrence {
  readonly dir: string;
}

export function skillRegistryKey(scope: SkillOccurrence['scope'], name: string): string {
  return `${scope}/${name}`;
}

export interface SkillRegistry {
  readonly admittedDirs: ReadonlySet<string>;
  readonly canonicalDir: ReadonlyMap<string, string>;
  readonly excludedCopyDirs: ReadonlySet<string>;
}

function nameDefaultRank(occurrence: LocatedSkillOccurrence): number {
  if (occurrence.preferredSource === true) return -1;
  const i = SKILL_CANONICAL_PRECEDENCE.indexOf(occurrence.editor);
  return i === -1 ? SKILL_CANONICAL_PRECEDENCE.length : i;
}

export function buildSkillRegistry<T extends LocatedSkillOccurrence>(
  occurrences: readonly T[],
): SkillRegistry {
  const groups = groupSkillsByIdentity(occurrences);
  const admittedDirs = new Set<string>();
  const canonicalDir = new Map<string, string>();
  const excludedCopyDirs = new Set<string>();
  const defaultRank = new Map<string, number>();

  for (const g of groups) {
    admittedDirs.add(g.canonical.dir);
    for (const c of g.copies) excludedCopyDirs.add(c.dir);
    const key = skillRegistryKey(g.scope, g.name);
    const rank = nameDefaultRank(g.canonical);
    const held = defaultRank.get(key);
    if (held === undefined || rank < held) {
      defaultRank.set(key, rank);
      canonicalDir.set(key, g.canonical.dir);
    }
  }

  return { admittedDirs, canonicalDir, excludedCopyDirs };
}
