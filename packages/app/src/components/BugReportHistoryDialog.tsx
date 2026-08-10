/**
 * Bug report history dialog — the command-palette (⌘K) entry point to the
 * persisted report list. A thin transient surface over `BugReportHistoryList`;
 * the list is rendered only while open so each open re-reads the sidecars. The
 * empty-state CTA hands off to the compose "Report a bug" dialog via
 * `onReportABug`. Desktop-only — the mount site gates on the bridge.
 */

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
  /** Opens the compose "Report a bug" dialog from the empty-state CTA. */
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
