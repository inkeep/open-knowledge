import type { SkillScope, SkillSearchResult, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkills } from '@/hooks/use-skills';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';

export function findImportedSkill(
  entries: readonly SkillsListEntry[],
  result: SkillSearchResult,
): SkillsListEntry | null {
  return (
    entries.find(
      (s) =>
        s.origin?.source === result.source &&
        (s.name === result.name ||
          s.name === `${result.name}-imported` ||
          s.name.startsWith(`${result.name}-imported-`)),
    ) ?? null
  );
}

export function useSkillDirectory({
  scope,
  onNavigate,
}: {
  scope?: SkillScope;
  onNavigate?: () => void;
} = {}) {
  const openSkill = useOpenSkill();
  const skills = useSkills();

  const importedSkills = skills.status === 'ready' ? skills.data.filter((s) => s.origin) : [];

  const importedEntry = (r: SkillSearchResult): SkillsListEntry | null =>
    findImportedSkill(importedSkills, r);

  function openResult(r: SkillSearchResult): void {
    onNavigate?.();
    const existing = importedEntry(r);
    if (existing) {
      openSkill(existing.scope, existing.name);
      return;
    }
    openSkillPreviewTab({
      flavor: 'explore',
      source: r.source,
      name: r.name,
      subtitle: r.source,
      level: scope,
    });
  }

  return { importedEntry, openResult };
}
