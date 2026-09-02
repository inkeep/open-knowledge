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
    beginSkillWrite(skill.scope, skill.name);
    beginOptimisticSkillMove(skill.scope, skill.name);
    const result = await moveSkillScope({ name: skill.name, fromScope: skill.scope, toScope });
    endOptimisticSkillMove(skill.scope, skill.name);
    if (!result.ok) {
      endSkillWrite(skill.scope, skill.name);
      toast.error(t`Couldn't move skill: ${result.error}`);
      return false;
    }
    toast.success(t`Moved "${skill.name}" to ${scopeLabels[toScope]}`);
    const entry =
      skillsState.status === 'ready'
        ? skillsState.data.find((sk) => sk.scope === skill.scope && sk.name === skill.name)
        : undefined;
    const skillTabs = openTabs
      .map((id) => parseEditorTabId(id))
      .filter((tab) => {
        if (tab.kind !== 'doc') return false;
        const parsed = parseSkillTabDocName(tab.docName);
        return parsed?.scope === skill.scope && parsed.name === skill.name;
      });
    const openSkillDoc =
      skillTabs.find(
        (tab) => tab.kind === 'doc' && parseSkillTabDocName(tab.docName)?.rel === null,
      ) ?? skillTabs[0];
    const fromDoc =
      openSkillDoc?.kind === 'doc'
        ? openSkillDoc.docName
        : entry
          ? skillEntryLiveDocName(entry)
          : skill.scope === 'global'
            ? skillLiveDocName(skill.scope, skill.name)
            : null;
    const toDoc =
      toScope === 'project' && result.path !== undefined
        ? `${result.path.replace(/\/+$/, '')}/SKILL`
        : skillLiveDocName(toScope, skill.name);
    try {
      if (fromDoc !== null) retarget(fromDoc, toDoc);
    } catch (err) {
      console.error('[skill-move-scope] retarget failed after a successful move', err);
    }
    endSkillWrite(skill.scope, skill.name);
    return true;
  };
}
