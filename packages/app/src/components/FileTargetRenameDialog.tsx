import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { isValidNodeName } from '@/components/file-tree-operations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

interface FileTargetRenameDialogProps {
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (nextName: string) => void;
}

export function FileTargetRenameDialog({
  currentName,
  open,
  onOpenChange,
  onSave,
}: FileTargetRenameDialogProps) {
  const [name, setName] = useState(currentName);
  const normalizedName = name.trim();
  const canSave = isValidNodeName(normalizedName) && normalizedName !== currentName;

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    onOpenChange(false);
    onSave(normalizedName);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename</Trans>
            </DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="file-target-rename-name">
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id="file-target-rename-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!canSave}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
