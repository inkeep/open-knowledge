import type { SkillScope, SkillSearchResult, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkills } from '@/hooks/use-skills';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';

/**
 * Whether a skills.sh result is already in the project, and which entry it is.
 *
 * An ephemeral per-session "imported" set would miss a skill brought in earlier,
 * which would then offer Import again. An import lands on disk under its
 * frontmatter name, or `<name>-imported[-N]` when that name is taken (the
 * server's `firstFreeSkillName`), so a result counts as imported when some
 * project skill FROM THE SAME SOURCE carries one of those three name shapes.
 *
 * Both halves are load-bearing. Dropping a name shape makes a collision-renamed
 * import look un-imported; matching on `origin.source` alone would mark every
 * sibling of a multi-skill repo as imported the moment one of them landed, since
 * siblings share a source.
 *
 * Pure and exported for its own test — `entries` is expected to be pre-filtered
 * to skills that have an `origin`, but an entry without one can never match.
 */
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

/**
 * Shared behavior for every surface that lists skills.sh discovery results (the
 * Explore modal, the Skills home's popular grid): resolving whether a result is
 * already in the project, and what a click on it does. Extracted so both
 * surfaces stay in lockstep — a card that says "Added" in one place must say it
 * in the other, and both must land on the same destination.
 *
 * `scope` is the preview's scope coordinate, so the preview's Import targets
 * Project/Global correctly. `onNavigate` lets a modal close itself before the
 * navigation lands.
 */
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

  /** The already-imported project skill for a result, else null. The returned
   *  entry's own `.scope` and `.name` are what `openResult` navigates to. */
  const importedEntry = (r: SkillSearchResult): SkillsListEntry | null =>
    findImportedSkill(importedSkills, r);

  // Open a result's card (the single per-card action). An already-imported skill
  // opens its real doc in the scope it landed in (resolving the on-disk name so a
  // collision-rename still lands right); an un-imported one gets the full-page
  // read-only preview, where Import lives.
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
