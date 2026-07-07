import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { Dialog } from '@/components/ui/dialog';
import type { TemplateMenuEntry } from '@/hooks/use-folder-config';
import { deleteTemplate } from '@/lib/folder-config-api';

interface Props {
  /** The template to delete; `null` keeps the dialog closed. */
  template: TemplateMenuEntry | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete so the parent re-fetches. */
  onDeleted: () => void;
}

/**
 * Confirm and delete a template. The delete targets the template's owning
 * folder (`source_folder`) — which, for an `inherited` template, is an
 * ancestor; the confirmation calls that consequence out. Shared by the
 * folder-overview card and the Settings template manager.
 */
export function TemplateDeleteDialog({ template, onOpenChange, onDeleted }: Props) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(target: TemplateMenuEntry) {
    setDeleting(true);
    const result = await deleteTemplate(target.source_folder, target.name);
    setDeleting(false);
    if (!result.ok) {
      const { error } = result;
      toast.error(t`Couldn't delete template: ${error}`);
      return;
    }
    const label = target.title ?? target.name;
    toast.success(t`Template "${label}" deleted`);
    onDeleted();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={template !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onOpenChange(false);
      }}
    >
      {template
        ? (() => {
            const { name, path, scope } = template;
            const ancestorNote =
              scope === 'inherited'
                ? `\n\n${t`This template lives in a parent folder — deleting it affects every folder beneath it that doesn't define its own version.`}`
                : '';
            return (
              <DeleteConfirmationDialog
                itemName={t`template "${name}"`}
                isSubmitting={deleting}
                onDelete={() => handleDelete(template)}
                customDescription={`${t`This permanently removes ${path}. Agents that reference this template by name will fail until it's recreated or replaced by one in a parent folder.`}${ancestorNote}`}
              />
            );
          })()
        : null}
    </Dialog>
  );
}
