import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { useManagedArtifactRetarget } from '@/components/ManagedArtifactProperties';
import { useSkills } from '@/hooks/use-skills';
import { beginOptimisticSkillMove, endOptimisticSkillMove } from '@/lib/documents-events';
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
  const skillsState = useSkills();
  return async (skill, toScope) => {
    if (toScope === skill.scope) return false;
    // Optimistically drop the source row the instant it's confirmed — the move
    // deletes the source last, so without this the row lingers through the copy.
    beginOptimisticSkillMove(skill.scope, skill.name);
    const result = await moveSkillScope({ name: skill.name, fromScope: skill.scope, toScope });
    endOptimisticSkillMove(skill.scope, skill.name);
    if (!result.ok) {
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
    const fromDoc = entry
      ? skillEntryLiveDocName(entry)
      : skillLiveDocName(skill.scope, skill.name);
    const toDoc =
      toScope === 'project' && result.path !== undefined
        ? `${result.path.replace(/\/+$/, '')}/SKILL`
        : skillLiveDocName(toScope, skill.name);
    retarget(fromDoc, toDoc);
    return true;
  };
}
