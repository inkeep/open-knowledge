/**
 * EnableSyncConfirmDialog — guards every off → on transition of the git sync
 * toggle (the SyncStatusBadge popover Switch + the SettingsDialog Sync section)
 * and the full → follow downgrade.
 *
 * Off → on is the dangerous direction (push to remote, pull may overwrite
 * local). On → off is safe and skips this dialog. `variant` selects the copy:
 * 'full' (default) keeps today's bidirectional warning; 'follow' explains
 * one-directional sync. When switching an already-synced project down to
 * follow leaves unpushed local commits behind, `strandedCommitCount` drives
 * the one-sentence disclosure that those changes stay local.
 */
import { Plural, Trans } from '@lingui/react/macro';
import {
  AutoSyncEnableDialogIntro,
  AutoSyncEnableWarning,
} from '@/components/AutoSyncEnableWarning';
import type { AutoSyncOnboardingVariant } from '@/components/auto-sync-onboarding-gate';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
} from '@/components/ui/dialog';

interface EnableSyncConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  variant?: AutoSyncOnboardingVariant;
  /** Unpushed local commits that switching to follow will strand locally. */
  strandedCommitCount?: number;
}

export function EnableSyncConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  variant = 'full',
  strandedCommitCount = 0,
}: EnableSyncConfirmDialogProps) {
  const showStrandedDisclosure = variant === 'follow' && strandedCommitCount > 0;
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <AutoSyncEnableDialogIntro variant={variant} />
        </DialogHeader>
        <DialogBody>
          <AutoSyncEnableWarning variant={variant} />
          {showStrandedDisclosure && (
            <p className="mt-4 text-sm text-muted-foreground">
              <Plural
                value={strandedCommitCount}
                one="You have 1 change you haven't shared. It will stay on this computer."
                other="You have # changes you haven't shared. They will stay on this computer."
              />
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={onConfirm}>
            {variant === 'follow' ? (
              <Trans>Enable Auto (Pull only)</Trans>
            ) : (
              <Trans>Enable Auto (Pull and Push)</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
