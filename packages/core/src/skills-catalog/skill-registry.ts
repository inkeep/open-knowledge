/**
 * Skill registry — the derived projection over
 * {@link groupSkillsByIdentity} output that the two location-aware surfaces read:
 *
 *  - **content-filter admission:** `admittedDirs` (what to admit) and
 *    `excludedCopyDirs` (copy bundle dirs that must NOT be admitted, so a skill
 *    copied to N editors is ONE tracked identity, not N).
 *  - **by-name → physical-path mapper:** `canonicalDir` — where a host-less
 *    lookup of `<scope>/<name>` lands.
 *
 * It is DERIVED, not persisted: the canonical binding falls out of scanning +
 * dedup (cloud-safe, nothing machine-specific to commit). Machine-local copy
 * tracking for fan-out is a separate concern that lives in `.ok/local/`.
 */

import {
  groupSkillsByIdentity,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillOccurrence,
} from './dedup.ts';

/** An occurrence with its physical bundle dir (project-relative or absolute). */
export interface LocatedSkillOccurrence extends SkillOccurrence {
  readonly dir: string;
}

/** `<scope>/<name>` registry key. */
export function skillRegistryKey(scope: SkillOccurrence['scope'], name: string): string {
  return `${scope}/${name}`;
}

export interface SkillRegistry {
  /**
   * EVERY admitted bundle dir: one per distinct-CONTENT identity. Two same-named
   * bundles holding different bytes are two different skills and BOTH are admitted
   * — the user sees both, neither is hidden behind the other.
   */
  readonly admittedDirs: ReadonlySet<string>;
  /**
   * `<scope>/<name>` → the bundle dir a bare by-NAME lookup resolves to. When one
   * name has several distinct-content identities this is only the precedence
   * winner: a DEFAULT for callers that supply no host, never a claim that the
   * others are lesser. Callers that can act destructively must disambiguate
   * rather than lean on this.
   */
  readonly canonicalDir: ReadonlyMap<string, string>;
  /** Copy bundle dirs to EXCLUDE from content-index admission (dedup at admission). */
  readonly excludedCopyDirs: ReadonlySet<string>;
}

function nameDefaultRank(occurrence: LocatedSkillOccurrence): number {
  if (occurrence.preferredSource === true) return -1; // user choice wins
  const i = SKILL_CANONICAL_PRECEDENCE.indexOf(occurrence.editor);
  return i === -1 ? SKILL_CANONICAL_PRECEDENCE.length : i;
}

/**
 * Build the registry from located occurrences. Copies (same scope+name+hash,
 * non-canonical) are excluded from admission — that is the real dedup, and one
 * skill delivered to six editors stays ONE tracked identity. Same scope+name with
 * DIFFERENT content is not a copy relationship at all: every such identity is
 * admitted on its own terms. Precedence survives only to pick which one a bare
 * by-name lookup lands on.
 */
export function buildSkillRegistry<T extends LocatedSkillOccurrence>(
  occurrences: readonly T[],
): SkillRegistry {
  const groups = groupSkillsByIdentity(occurrences);
  const admittedDirs = new Set<string>();
  const canonicalDir = new Map<string, string>();
  const excludedCopyDirs = new Set<string>();
  // Rank of whatever currently holds each name's by-name default, so the walk
  // can keep the best without re-sorting.
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
