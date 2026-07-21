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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which in-app surface opened the form; forwarded for analytics attribution. */
  source?: string;
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
          <FeedbackForm source={source} onSuccess={() => onOpenChange(false)} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
};
