import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { useManagedArtifactRetarget } from '@/components/ManagedArtifactProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { parseEditorTabId } from '@/editor/editor-tabs';
import { parseSkillTabDocName } from '@/hooks/use-reconcile-skill-tabs';
import { useSkills } from '@/hooks/use-skills';
import {
  beginOptimisticSkillMove,
  beginSkillWrite,
  endOptimisticSkillMove,
  endSkillWrite,
} from '@/lib/documents-events';
import { skillEntryLiveDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { useSkillScopeLabels } from '@/lib/skill-scope';
import { moveSkillScope } from '@/lib/skills-api';

/**
 * The single scope-move (project ↔ global) commit, shared by the toolbar's level
 * control (`useSkillScopeMove`) AND the sidebar three-dot menu. Owns: the
 * optimistic source-row drop, the POST, the toast, and the open-tab retarget — so
 * both surfaces relocate a skill identically. Returns whether the move succeeded.
 */
export function useMoveSkillScope(): (
  skill: { scope: SkillScope; name: string },
  toScope: SkillScope,
) => Promise<boolean> {
  const { t } = useLingui();
  const scopeLabels = useSkillScopeLabels();
  const retarget = useManagedArtifactRetarget();
  const { openTabs } = useDocumentContext();
  const skillsState = useSkills();
  return async (skill, toScope) => {
    if (toScope === skill.scope) return false;
    // Optimistically drop the source row the instant it's confirmed — the move
    // deletes the source last, so without this the row lingers through the copy.
    // Mark the whole operation, not just the optimistic row-hide. The optimistic
    // flag is cleared as soon as the request returns, which is BEFORE the
    // retarget runs and before the list carries the skill at its new scope — so
    // the reconciler saw it absent from both scopes with no guard set and closed
    // the tab. Cleared in the single exit below, after the retarget.
    beginSkillWrite(skill.scope, skill.name);
    beginOptimisticSkillMove(skill.scope, skill.name);
    const result = await moveSkillScope({ name: skill.name, fromScope: skill.scope, toScope });
    endOptimisticSkillMove(skill.scope, skill.name);
    if (!result.ok) {
      endSkillWrite(skill.scope, skill.name);
      toast.error(t`Couldn't move skill: ${result.error}`);
      return false;
    }
    // The server move copies the whole bundle verbatim (binaries included), so
    // there is no partial-copy warning to surface.
    toast.success(t`Moved "${skill.name}" to ${scopeLabels[toScope]}`);
    // Retarget by REAL doc names (store-shaped fallbacks minted phantom
    // `.ok/skills` docs): the FROM doc is the entry's actual open doc; the TO
    // doc uses the move response's real landing path for project (global docs
    // stay on the managed `__skill__/global/` scheme). Falling back to
    // `skillLiveDocName` only when neither is known.
    const entry =
      skillsState.status === 'ready'
        ? skillsState.data.find((sk) => sk.scope === skill.scope && sk.name === skill.name)
        : undefined;
    // Resolve the FROM doc from the open tabs when the list lookup misses —
    // never from `skillLiveDocName`, which mints the store shape
    // (`.ok/skills/<name>/SKILL`). An in-place project skill is open at its real
    // content path (`.claude/skills/<name>/SKILL`), so the store name matches no
    // tab: the retarget silently hits nothing and the tab is left pointing at a
    // path this move is about to delete. That is the stranded tab on a
    // non-existent doc, which then sits on "Couldn't load document".
    //
    // The lookup misses routinely, not rarely: `beginOptimisticSkillMove` has
    // already dropped the source row by this point, and the list may still be
    // refetching. `useOpenSkill` carries the same never-mint-the-store-shape
    // rule; this is the path that was missing it.
    const skillTabs = openTabs
      .map((id) => parseEditorTabId(id))
      .filter((tab) => {
        if (tab.kind !== 'doc') return false;
        const parsed = parseSkillTabDocName(tab.docName);
        return parsed?.scope === skill.scope && parsed.name === skill.name;
      });
    // Prefer the SKILL-level tab, but fall back to a bundle-FILE tab of the same
    // skill. Clicking a skill and then one of its bundle files leaves the file
    // tab as the only one for that skill (the file replaces the SKILL preview
    // tab), and with nothing to repoint the user was left on a doc this move
    // deletes — the tab reconciler then closed it, emptying the Skills surface,
    // which fell back to Files. Both shapes land on the same `toDoc`, so a file
    // tab simply follows its skill to the new scope.
    const openSkillDoc =
      skillTabs.find(
        (tab) => tab.kind === 'doc' && parseSkillTabDocName(tab.docName)?.rel === null,
      ) ?? skillTabs[0];
    // An actually-open tab outranks the list entry. `retarget` repoints a tab BY
    // doc name, so a name no tab carries silently repoints nothing — which is
    // what happened whenever the open tab was a bundle FILE: the entry resolved
    // to the skill's SKILL doc, the retarget hit nothing, and the file tab was
    // left on a doc the move deletes. When no tab is open the retarget is a
    // no-op either way, so the entry stays as the fallback.
    const fromDoc =
      openSkillDoc?.kind === 'doc'
        ? openSkillDoc.docName
        : entry
          ? skillEntryLiveDocName(entry)
          : // Global skills open at the managed `__skill__/global/<name>` doc, which
            // is a real resolvable name rather than a minted store path.
            skill.scope === 'global'
            ? skillLiveDocName(skill.scope, skill.name)
            : null;
    const toDoc =
      toScope === 'project' && result.path !== undefined
        ? `${result.path.replace(/\/+$/, '')}/SKILL`
        : skillLiveDocName(toScope, skill.name);
    // No resolvable source means no open tab to repoint — skip rather than
    // retarget from a guessed name.
    //
    // Guarded because the write flag below is module state that ONLY a reload
    // clears, and it suppresses the tab reconciler for this skill while set. A
    // throw in here would therefore disable the very thing that repairs a tab
    // left on the old scope: the tab never repoints, the toolbar keeps deriving
    // its level from the stale doc name, and the skill stays unfixable for the
    // rest of the session. Releasing the flag matters more than the retarget
    // succeeding — the reconciler can redo a retarget, but not un-leak a flag.
    try {
      if (fromDoc !== null) retarget(fromDoc, toDoc);
    } catch (err) {
      console.error('[skill-move-scope] retarget failed after a successful move', err);
    }
    // Pin the sidebar to Skills, like every other skill mutation (delete, file
    // delete, rename retarget). A project skill's doc is ordinary project
    // CONTENT (`.claude/skills/<name>/SKILL`), so retargeting onto it lets the
    // Released only now: the tab has been repointed and the surface pinned, so
    // an absent reading after this really is an absence.
    endSkillWrite(skill.scope, skill.name);
    return true;
  };
}
