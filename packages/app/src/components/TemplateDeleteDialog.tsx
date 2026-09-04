import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import type { TemplateMenuEntry } from '@/hooks/use-folder-config';
import { deleteTemplate } from '@/lib/folder-config-api';

interface Props {
  template: TemplateMenuEntry | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

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
    <AlertDialog
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
    </AlertDialog>
  );
}
