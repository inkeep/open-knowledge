import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { tabIdsForSkill } from '@/hooks/use-reconcile-skill-tabs';
import { deleteSkill } from '@/lib/skills-api';

interface Props {
  skills: readonly SkillsListEntry[] | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

export function SkillBulkDeleteDialog({ skills, onOpenChange, onDeleted }: Props) {
  const { t } = useLingui();
  const { closeTabs, openTabs } = useDocumentContext();
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState(0);

  async function handleDelete(targets: readonly SkillsListEntry[]) {
    setDeleting(true);
    setProgress(0);
    let deleted = 0;
    for (const target of targets) {
      setProgress((n) => n + 1);
      const result = await deleteSkill(target.scope, target.name, target.hostQualifier);
      if (!result.ok) {
        const { error } = result;
        toast.error(t`Couldn't delete ${target.name}: ${error}`);
        continue;
      }
      deleted += 1;
      closeTabs(tabIdsForSkill(openTabs, target.scope, target.name), { force: true });
    }
    setDeleting(false);
    if (deleted > 0) toast.success(t`Deleted ${deleted} skills`);
    onDeleted();
    onOpenChange(false);
  }

  const names = (skills ?? []).map((s) => s.name).join(', ');
  const count = skills?.length ?? 0;
  return (
    <AlertDialog
      open={skills !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onOpenChange(false);
      }}
    >
      {skills ? (
        <DeleteConfirmationDialog
          itemName={t`${count} skills`}
          isSubmitting={deleting}
          customConfirmLabelBusy={t`Deleting ${progress} of ${count}`}
          onDelete={() => handleDelete(skills)}
          customDescription={t`This permanently removes ${names}. Agents that invoke these skills by name will fail until they're recreated.`}
        />
      ) : null}
    </AlertDialog>
  );
}
