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
  /** The skills to delete; `null` keeps the dialog closed. */
  skills: readonly SkillsListEntry[] | null;
  onOpenChange: (open: boolean) => void;
  /** Called after the run finishes (even partially) so the parent clears its selection. */
  onDeleted: () => void;
}

/**
 * One confirmation for a multi-selection delete. Deletes run sequentially —
 * each is a server-side delete + reverse-projection, and the shared placements
 * ledger is a read-modify-write that concurrent deletes would clobber (the
 * same reason bulk install projects sequentially). Failures don't stop the
 * run: each failed name gets its own toast, the successes are already gone
 * either way, and one aggregate toast closes the run.
 */
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
      // Evict every tab backed by the deleted copy in one navigation update
      // per skill (same eviction the single-skill dialog performs).
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
          // Sequential deletes over a big selection take real time; a bare
          // "Deleting" spinner reads as hung ("it did not delete").
          customConfirmLabelBusy={t`Deleting ${progress} of ${count}`}
          onDelete={() => handleDelete(skills)}
          customDescription={t`This permanently removes ${names}. Agents that invoke these skills by name will fail until they're recreated.`}
        />
      ) : null}
    </AlertDialog>
  );
}
