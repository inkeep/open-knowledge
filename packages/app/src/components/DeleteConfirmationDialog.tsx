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
  /**
   * Optional sub-text rendered below the description in a muted paragraph.
   * Used by the Trash flow to surface the macOS-verbatim
   * "You can restore this file from the Trash." detail line without
   * inlining it into the description.
   */
  customDetail?: string;
  /**
   * Override the primary destructive button label. Defaults to `Delete`.
   * The Trash flow passes `Move to Trash`; the trash-failure fallback modal
   * owns its own button copy via `TrashFailureModal`.
   */
  customConfirmLabel?: string;
  /**
   * Override the primary button label while `isSubmitting`. When omitted,
   * falls back to `customConfirmLabel` (if provided) — the spinner already
   * signals in-flight state, so re-displaying the action label keeps the
   * busy frame coherent with the rest frame (`Move to Trash` ↔ `Move to
   * Trash`). The legacy `'Deleting'` default only applies when neither
   * `customConfirmLabel` nor `customConfirmLabelBusy` is provided. This
   * derivation eliminates the historical mismatch hazard where a caller
   * passed `customConfirmLabel: 'Move to Trash'` but forgot the busy
   * variant and the button displayed `'Deleting'` mid-flight.
   */
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
        <AlertDialogDescription
          // respect \n in message
          className="whitespace-pre-wrap"
        >
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
        {/* Deliberately a plain Button rather than AlertDialogAction: the action
            is awaited and reports its in-flight state in this button's own
            label, and AlertDialogAction closes the dialog the moment it is
            activated. The owner closes the dialog once the work settles. */}
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
