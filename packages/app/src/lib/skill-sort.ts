import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { FileTreeSortComparator } from '@pierre/trees';
import { SKILL_SCOPE_ORDER } from '@/lib/skill-scope';

export const SKILL_MD_PATH = 'SKILL.md';

export function createSkillSortComparator(
  labelToScope: ReadonlyMap<string, SkillScope>,
  detectedPrefixes: { has(prefix: string): boolean },
  groupPrefixes: { has(prefix: string): boolean } = { has: () => false },
  skillPrefixes: { has(prefix: string): boolean } = { has: () => false },
  pinnedPrefixes: { has(prefix: string): boolean } = { has: () => false },
): FileTreeSortComparator {
  return (a, b) => {
    const aScope = a.segments[0] ?? '';
    const bScope = b.segments[0] ?? '';
    if (aScope !== bScope) {
      const ai = SKILL_SCOPE_ORDER.indexOf(labelToScope.get(aScope) ?? 'project');
      const bi = SKILL_SCOPE_ORDER.indexOf(labelToScope.get(bScope) ?? 'project');
      if (ai !== bi) return ai - bi;
    }
    const aPath = a.segments.join('/');
    const bPath = b.segments.join('/');

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

    if (aGroup && bGroup) {
      const aId = a.segments[1] ?? '';
      const bId = b.segments[1] ?? '';
      if (aId !== bId)
        return aId.localeCompare(bId, undefined, { numeric: true, sensitivity: 'base' });
    }

    if (a.depth === b.depth && (skillPrefixes.has(aPath) || detectedPrefixes.has(aPath))) {
      const aDetected = detectedPrefixes.has(aPath);
      const bDetected = detectedPrefixes.has(bPath);
      if (aDetected !== bDetected) return aDetected ? 1 : -1;
      return a.basename.localeCompare(b.basename, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    }
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
