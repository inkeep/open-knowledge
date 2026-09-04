import { Trans } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

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
  source?: string;
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
