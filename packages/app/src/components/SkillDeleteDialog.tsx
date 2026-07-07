import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { Dialog } from '@/components/ui/dialog';
import { deleteSkill } from '@/lib/skills-api';

interface Props {
  /** The skill to delete; `null` keeps the dialog closed. */
  skill: SkillsListEntry | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete so the parent re-fetches. */
  onDeleted: () => void;
}

/**
 * Confirm and delete a skill. Deleting removes the source under
 * `.ok/skills/<name>/` and reverse-projects: the editor host dirs it was
 * installed into are uninstalled in the same operation (reverse-projection
 * folds into delete server-side). The confirmation names the consequence for
 * agents that resolve the skill by name.
 */
export function SkillDeleteDialog({ skill, onOpenChange, onDeleted }: Props) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(target: SkillsListEntry) {
    setDeleting(true);
    const result = await deleteSkill(target.scope, target.name);
    setDeleting(false);
    if (!result.ok) {
      const { error } = result;
      toast.error(t`Couldn't delete skill: ${error}`);
      return;
    }
    toast.success(t`Skill "${target.name}" deleted`);
    onDeleted();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={skill !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onOpenChange(false);
      }}
    >
      {skill ? (
        <DeleteConfirmationDialog
          itemName={t`skill "${skill.name}"`}
          isSubmitting={deleting}
          onDelete={() => handleDelete(skill)}
          customDescription={t`This permanently removes ${skill.path}. Agents that invoke this skill by name will fail until it's recreated.`}
        />
      ) : null}
    </Dialog>
  );
}
