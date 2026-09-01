import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import {
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

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
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{customTitle ?? t`Delete ${itemName}`}</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-wrap">
          {customDescription ??
            t`Are you sure you want to delete ${itemName}? This action cannot be undone.`}
        </AlertDialogDescription>
        {customDetail ? (
          <p className="text-muted-foreground text-sm" data-testid="delete-confirmation-detail">
            {customDetail}
          </p>
        ) : null}
      </AlertDialogHeader>
      {children ? <AlertDialogBody>{children}</AlertDialogBody> : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isSubmitting}>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        {}
        <Button variant="destructive" onClick={onDelete} disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner aria-hidden="true" className="size-4" /> {confirmLabelBusy}
            </>
          ) : (
            confirmLabel
          )}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
