import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { FileTreeSortComparator } from '@pierre/trees';
import { SKILL_SCOPE_ORDER } from '@/lib/skill-scope';

/** A skill's `SKILL.md`, as the basename nested under its skill folder. */
export const SKILL_MD_PATH = 'SKILL.md';

/**
 * Build the Skills-tree row comparator. Kept pure + dependency-injected (the two
 * closure inputs are passed in) so it is unit-testable without a DOM mount —
 * the correctness of the depth literals below is load-bearing and previously
 * shipped wrong with no test to catch it.
 *
 * `@pierre/trees` reports a node's `depth` as `segments.length`, so a scope-header
 * row (`Project/`) is depth 1, a skill folder (`Project/foo/`) is depth 2, and a
 * bundle file (`Project/foo/SKILL.md`) is depth 3. Match those exactly — an
 * off-by-one silently drops each branch and lets Pierre alphabetize the rows
 * (which pins `Global` above `Project` regardless of `SKILL_SCOPE_ORDER`).
 *
 * @param labelToScope maps a scope-header basename (`Project`/`Global`) to its scope.
 * @param detectedPrefixes membership test for `scopeLabel/skill` prefixes that are
 *   detected (un-managed) rather than OK-managed.
 */
export function createSkillSortComparator(
  labelToScope: ReadonlyMap<string, SkillScope>,
  detectedPrefixes: { has(prefix: string): boolean },
): FileTreeSortComparator {
  return (a, b) => {
    // Different scopes → order by SKILL_SCOPE_ORDER on the ROOT segment
    // (`segments[0]` = the scope label), REGARDLESS of the entries' depths.
    // Pierre invokes the comparator across MIXED depths (a depth-1 scope header
    // vs a depth-2/3 skill row under the other scope, etc.), so a depth-gated
    // check (`a.depth === 1 && b.depth === 1`) never fired for those pairs and
    // fell through to the alphabetical default — which pinned GLOBAL above
    // PROJECT. Keying on the root segment groups every PROJECT entry above every
    // GLOBAL entry, so the section order is deterministic at any skill count.
    const aScope = a.segments[0] ?? '';
    const bScope = b.segments[0] ?? '';
    if (aScope !== bScope) {
      const ai = SKILL_SCOPE_ORDER.indexOf(labelToScope.get(aScope) ?? 'project');
      const bi = SKILL_SCOPE_ORDER.indexOf(labelToScope.get(bScope) ?? 'project');
      if (ai !== bi) return ai - bi;
    }
    // Within a scope, managed skills sort above detected (un-managed) ones.
    if (a.depth === 2 && b.depth === 2) {
      const aDetected = detectedPrefixes.has(a.segments.join('/'));
      const bDetected = detectedPrefixes.has(b.segments.join('/'));
      if (aDetected !== bDetected) return aDetected ? 1 : -1;
      return a.basename.localeCompare(b.basename, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    }
    // SKILL.md sorts first, but only at the skill root (depth 3: scope/skill/file)
    // — a bundle file named SKILL.md nested in a subfolder must not jump its siblings.
    const aMd = a.depth === 3 && a.basename === SKILL_MD_PATH;
    const bMd = b.depth === 3 && b.basename === SKILL_MD_PATH;
    if (aMd !== bMd) return aMd ? -1 : 1;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
  };
}
