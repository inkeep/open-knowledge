import { Trans } from '@lingui/react/macro';
import { BugReportHistoryList } from '@/components/BugReportHistory';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface BugReportHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReportABug: () => void;
}

function BugReportHistoryDialog({ open, onOpenChange, onReportABug }: BugReportHistoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Bug report history</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Reports you've generated on this computer. Retry a send, reveal a file, or delete one
              you no longer need.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] overflow-y-auto">
          {open ? <BugReportHistoryList onReportABug={onReportABug} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export default BugReportHistoryDialog;
