import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { tabIdsForSkillFile } from '@/hooks/use-reconcile-skill-tabs';
import { skillDir } from '@/lib/skill-scope';
import { deleteSkillFile } from '@/lib/skills-api';

export interface SkillFileDeleteTarget {
  skill: SkillsListEntry;
  filePath: string;
}

export function SkillFileDeleteDialog({
  target,
  onOpenChange,
}: {
  target: SkillFileDeleteTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { closeTabs, openTabs } = useDocumentContext();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete({ skill, filePath }: SkillFileDeleteTarget) {
    setDeleting(true);
    const result = await deleteSkillFile({
      scope: skill.scope,
      name: skill.name,
      path: filePath,
    });
    setDeleting(false);
    if (!result.ok) {
      toast.error(t`Couldn't delete file: ${result.error}`);
      return;
    }
    if (!result.existed) {
      toast.error(t`${filePath} is no longer in this skill`);
      onOpenChange(false);
      return;
    }
    toast.success(t`Deleted ${filePath}`);
    closeTabs(tabIdsForSkillFile(openTabs, skill, filePath), { force: true });
    onOpenChange(false);
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onOpenChange(false);
      }}
    >
      {target ? (
        <DeleteConfirmationDialog
          itemName={t`"${target.filePath}"`}
          isSubmitting={deleting}
          onDelete={() => handleDelete(target)}
          customDescription={t`This permanently removes ${skillDir(target.skill.path)}/${target.filePath} from the "${target.skill.name}" skill. Anything in SKILL.md that points at it will break until it's recreated.`}
        />
      ) : null}
    </AlertDialog>
  );
}
