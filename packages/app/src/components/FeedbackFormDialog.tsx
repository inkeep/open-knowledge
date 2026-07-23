import { Trans } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

// Lazy so the form's deps (zod schema, react-hook-form, the attachment UI, its
// icons) only enter the bundle graph the first time the dialog opens — mirrors
// ReportBugDialog's lazy-body split. The header renders immediately; only the
// form body suspends.
const FeedbackForm = lazy(() =>
  import('./FeedbackForm').then((m) => ({ default: m.FeedbackForm })),
);

export const FeedbackFormDialog = ({
  open,
  onOpenChange,
  source,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which in-app surface opened the form; forwarded for analytics attribution. */
  source?: string;
  /**
   * Fired after a confirmed submit, in addition to closing the dialog. Lets a
   * caller record that feedback was given from this surface — see the
   * proactive card's suppression in HelpPopover.
   */
  onSuccess?: () => void;
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>How do you like OpenKnowledge?</Trans>
          </DialogTitle>
        </DialogHeader>
        <Suspense fallback={null}>
          <FeedbackForm
            source={source}
            onSuccess={() => {
              onOpenChange(false);
              onSuccess?.();
            }}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
};
