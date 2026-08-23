import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { FileTreeSortComparator } from '@pierre/trees';
import { SKILL_SCOPE_ORDER } from '@/lib/skill-scope';

/** A skill's `SKILL.md`, as the basename nested under its skill folder. */
export const SKILL_MD_PATH = 'SKILL.md';

/**
 * Build the Skills-tree row comparator. Kept pure + dependency-injected so it is
 * unit-testable without a DOM mount; the ordering it encodes is load-bearing and
 * has shipped wrong before with no test to catch it.
 *
 * Rows are identified by MEMBERSHIP, not by depth. Provenance grouping made a
 * row's depth ambiguous — depth 2 is a skill when ungrouped and a group when not,
 * depth 3 is a bundle file or a grouped skill — so every depth literal here
 * became a coin flip. The prefix maps the builder already produces say what a row
 * IS, so ask them. That also retires the off-by-one hazard this comment used to
 * warn about, instead of restating it one level deeper.
 *
 * @param labelToScope maps a scope-header basename (`Project`/`Global`) to its scope.
 * @param detectedPrefixes membership test for prefixes that are detected
 *   (un-managed) rather than OK-managed.
 * @param groupPrefixes membership test for `scopeLabel/groupId` provenance groups.
 * @param skillPrefixes membership test for any prefix that IS a skill folder.
 */
export function createSkillSortComparator(
  labelToScope: ReadonlyMap<string, SkillScope>,
  detectedPrefixes: { has(prefix: string): boolean },
  groupPrefixes: { has(prefix: string): boolean } = { has: () => false },
  skillPrefixes: { has(prefix: string): boolean } = { has: () => false },
  pinnedPrefixes: { has(prefix: string): boolean } = { has: () => false },
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
    const aPath = a.segments.join('/');
    const bPath = b.segments.join('/');

    // Skills you authored lead their scope; everything from elsewhere sorts
    // below, grouped. Your own work is the reason the panel is open, and it is
    // the half that carries no label — so it reads as the content and the groups
    // read as provenance filed beneath it. Groups fold to one row each, so the
    // cost of putting them last is scrolling past skills you were scrolling past
    // anyway.
    //
    // Keyed on the ANCESTOR segment, not the whole path: Pierre only ever hands
    // the comparator LEAF entries (`Global/<group>/<skill>/SKILL.md` at depth 4)
    // and synthesizes the directory rows above them itself. Testing the full path
    // against the group map never matched, which is how an earlier cut of this
    // rule silently did nothing while its unit test passed.
    // Pinned rows lead their scope, ahead of everything including your own
    // authored skills. They are the one part of the tree the user built by hand,
    // so anything below is by definition less urgent than what they pinned.
    const inPinned = (segs: readonly string[]) =>
      segs.length >= 2 && pinnedPrefixes.has(`${segs[0]}/${segs[1]}`);
    const aPinned = inPinned(a.segments);
    const bPinned = inPinned(b.segments);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    const inGroup = (segs: readonly string[]) =>
      segs.length >= 2 && groupPrefixes.has(`${segs[0]}/${segs[1]}`);
    const aGroup = inGroup(a.segments);
    const bGroup = inGroup(b.segments);
    if (aGroup !== bGroup) return aGroup ? 1 : -1;

    // Groups order alphabetically among themselves. Two leaves in DIFFERENT
    // groups are both `<scope>/<group>/<skill>/SKILL.md`, so every later rule
    // compares the same basename and returns 0 — which left the group rows in
    // emission order, i.e. whatever order the skills endpoint answered in.
    // Comparing the group segment is the only thing that reaches them, since
    // Pierre synthesizes the group rows from these leaves rather than passing
    // them through the comparator.
    if (aGroup && bGroup) {
      const aId = a.segments[1] ?? '';
      const bId = b.segments[1] ?? '';
      if (aId !== bId)
        return aId.localeCompare(bId, undefined, { numeric: true, sensitivity: 'base' });
    }

    // Within a scope, managed skills sort above detected (un-managed) ones.
    if (a.depth === b.depth && (skillPrefixes.has(aPath) || detectedPrefixes.has(aPath))) {
      const aDetected = detectedPrefixes.has(aPath);
      const bDetected = detectedPrefixes.has(bPath);
      if (aDetected !== bDetected) return aDetected ? 1 : -1;
      return a.basename.localeCompare(b.basename, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    }
    // SKILL.md sorts first, but only as a skill folder's OWN child — a bundle
    // file named SKILL.md nested deeper must not jump its siblings. Asking
    // whether the parent is a skill works at any depth, so grouping cannot
    // silently shift it the way a depth literal did.
    const parentIsSkill = (segs: readonly string[]) =>
      skillPrefixes.has(segs.slice(0, -1).join('/')) ||
      detectedPrefixes.has(segs.slice(0, -1).join('/'));
    const aMd = a.basename === SKILL_MD_PATH && parentIsSkill(a.segments);
    const bMd = b.basename === SKILL_MD_PATH && parentIsSkill(b.segments);
    if (aMd !== bMd) return aMd ? -1 : 1;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
  };
}
