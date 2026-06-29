import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DeleteConfirmationProps {
  itemName?: string;
  isSubmitting: boolean;
  onDelete: () => Promise<void> | void;
  customTitle?: string;
  customDescription?: string;
  customDetail?: string;
  customConfirmLabel?: string;
  customConfirmLabelBusy?: string;
  children?: ReactNode;
}

export function DeleteConfirmationDialog({
  itemName: itemNameProp,
  isSubmitting,
  onDelete,
  customTitle,
  customDescription,
  customDetail,
  customConfirmLabel,
  customConfirmLabelBusy,
  children,
}: DeleteConfirmationProps) {
  const { t } = useLingui();
  const itemName = itemNameProp ?? t`this item`;
  const confirmLabel = customConfirmLabel ?? t`Delete`;
  const confirmLabelBusy = customConfirmLabelBusy ?? customConfirmLabel ?? t`Deleting`;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{customTitle ?? t`Delete ${itemName}`}</DialogTitle>
        <DialogDescription
          className="whitespace-pre-wrap"
        >
          {customDescription ??
            t`Are you sure you want to delete ${itemName}? This action cannot be undone.`}
        </DialogDescription>
        {customDetail ? (
          <p className="text-muted-foreground text-sm" data-testid="delete-confirmation-detail">
            {customDetail}
          </p>
        ) : null}
      </DialogHeader>
      {children ? <DialogBody>{children}</DialogBody> : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline" disabled={isSubmitting}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogClose>
        <Button variant="destructive" onClick={onDelete} disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="size-4 animate-spin" /> {confirmLabelBusy}
            </>
          ) : (
            confirmLabel
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
