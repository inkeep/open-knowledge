import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { Dialog } from '@/components/ui/dialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { tabIdsForSkill } from '@/hooks/use-reconcile-skill-tabs';
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
  const { setSkillsSidebar, closeTabs, openTabs } = useDocumentContext();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(target: SkillsListEntry) {
    // Deleting from the Skills sidebar means we're on the Skills surface; pin it
    // up front so the downstream tab eviction (which clears the active skill
    // target) can't let autofollow drop us back to Files. Robust across the
    // project-doc and global managed-artifact deletion paths alike.
    setSkillsSidebar(true);
    setDeleting(true);
    const result = await deleteSkill(target.scope, target.name);
    setDeleting(false);
    if (!result.ok) {
      const { error } = result;
      toast.error(t`Couldn't delete skill: ${error}`);
      return;
    }
    toast.success(t`Skill "${target.name}" deleted`);
    // Evict every tab backed by the deleted copy in one navigation update.
    // `closeDocument` only removes a plain document tab, so it leaves the
    // dedicated bundle-file tab IDs behind.
    closeTabs(tabIdsForSkill(openTabs, target.scope, target.name), { force: true });
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
          customDescription={
            // A copy made from a harness plugin: deleting it doesn't touch the
            // plugin — the read-only original resurfaces as Detected. Saying so
            // here keeps the reappearing row from reading as a failed delete.
            skill.origin?.source && /\/plugins\/(?:cache|marketplaces)\//.test(skill.origin.source)
              ? t`This permanently removes ${skill.path}. The plugin it was copied from is untouched — its read-only version will show up as detected again.`
              : t`This permanently removes ${skill.path}. Agents that invoke this skill by name will fail until it's recreated.`
          }
        />
      ) : null}
    </Dialog>
  );
}
