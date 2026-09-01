import { Trans } from '@lingui/react/macro';
import { TemplateFormFields, useTemplateForm } from '@/components/TemplateForm';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  folderPath: string;
  existingNames: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (createdName: string) => void;
}

const EMPTY_INITIAL = {
  name: '',
  title: '',
  description: '',
  body: '',
} as const;

const BODY_PLACEHOLDER = '## Overview\n\n(Replace with the starting content for new documents.)\n';

export function NewTemplateDialog({
  folderPath,
  existingNames,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        {open ? (
          <Body
            folderPath={folderPath}
            existingNames={existingNames}
            onOpenChange={onOpenChange}
            onCreated={onCreated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  folderPath,
  existingNames,
  onOpenChange,
  onCreated,
}: {
  folderPath: string;
  existingNames: ReadonlySet<string>;
  onOpenChange: (open: boolean) => void;
  onCreated: (createdName: string) => void;
}) {
  const form = useTemplateForm({
    mode: 'create',
    folderPath,
    initial: EMPTY_INITIAL,
    existingNames,
    onCommitted: (createdName) => {
      onCreated(createdName);
      onOpenChange(false);
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Trans>New template</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>A reusable starting point for new documents in this folder.</Trans>
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <TemplateFormFields form={form} bodyPlaceholder={BODY_PLACEHOLDER} />
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="font-mono uppercase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(false)}
          disabled={form.isSaving}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button onClick={() => void form.submit()} disabled={form.isSaving}>
          {form.isSaving ? <Trans>Creating</Trans> : <Trans>Create template</Trans>}
        </Button>
      </DialogFooter>
    </>
  );
}
