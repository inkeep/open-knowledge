import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { Dialog } from '@/components/ui/dialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { tabIdsForSkillFile } from '@/hooks/use-reconcile-skill-tabs';
import { skillDir } from '@/lib/skill-scope';
import { deleteSkillFile } from '@/lib/skills-api';

export interface SkillFileDeleteTarget {
  skill: SkillsListEntry;
  filePath: string;
}

/**
 * Confirm and delete ONE bundle file inside a skill (`references/**`,
 * `scripts/**`, …). The skill itself survives; only the named file goes, so the
 * confirmation names the file rather than the skill. Deleting an editable `.md`
 * reference also tears down its live doc server-side, so the open tab is evicted
 * here rather than left pointing at a doc that no longer exists.
 */
export function SkillFileDeleteDialog({
  target,
  onOpenChange,
}: {
  target: SkillFileDeleteTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { setSkillsSidebar, closeTabs, openTabs } = useDocumentContext();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete({ skill, filePath }: SkillFileDeleteTarget) {
    // Pin the Skills surface before the tab eviction, for the same reason the
    // skill-level delete does: closing the active tab can otherwise let
    // autofollow drop the sidebar back to Files.
    setSkillsSidebar(true);
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
    // The endpoint reports a miss rather than failing, so a path that addressed
    // nothing would otherwise read as a successful delete while the file is
    // still on disk. Say so instead, and leave the tab alone.
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
    <Dialog
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
    </Dialog>
  );
}
