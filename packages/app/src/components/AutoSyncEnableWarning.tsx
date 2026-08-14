import { Trans } from '@lingui/react/macro';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  Eye,
  GitCommitVertical,
  GitMerge,
  Laptop,
} from 'lucide-react';
import type { AutoSyncOnboardingVariant } from '@/components/auto-sync-onboarding-gate';
import { DisclosureWarning, DisclosureWarningItem } from '@/components/DisclosureWarning';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface SyncVariantProps {
  /** 'full' = bidirectional sync copy (default); 'pull' = one-directional. */
  variant?: AutoSyncOnboardingVariant;
}

export function AutoSyncEnableDialogIntro({ variant = 'full' }: SyncVariantProps) {
  if (variant === 'follow') {
    return (
      <>
        <DialogTitle>
          <Trans>Enable Follow?</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Follow fetches updates from your remote git repository and fast-forwards your copy
            automatically. Your local edits stay on this computer and are never pushed.
          </Trans>
        </DialogDescription>
      </>
    );
  }
  return (
    <>
      <DialogTitle>
        <Trans>Enable git auto-sync?</Trans>
      </DialogTitle>
      <DialogDescription>
        <Trans>
          Auto-sync periodically fetches, pulls, and pushes commits to your remote git repository so
          your edits stay in sync across machines.
        </Trans>
      </DialogDescription>
    </>
  );
}

export function AutoSyncEnableWarning({ variant = 'full' }: SyncVariantProps) {
  return (
    <DisclosureWarning>
      {variant === 'follow' ? <PullOnlyBullets /> : <FullSyncBullets />}
    </DisclosureWarning>
  );
}

function FullSyncBullets() {
  return (
    <>
      <DisclosureWarningItem
        icon={
          <ArrowRightLeft
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        }
        title={<Trans>Uncommitted changes</Trans>}
        body={<Trans>Pulls may overwrite uncommitted edits in your local files.</Trans>}
      />
      <DisclosureWarningItem
        icon={
          <GitCommitVertical
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        }
        title={<Trans>Commits happen automatically</Trans>}
        body={
          <Trans>
            OpenKnowledge will create commits and push them to your remote automatically. If you do
            not want automatic commits in your git history, you should not enable auto-sync.
          </Trans>
        }
      />
      <DisclosureWarningItem
        icon={<Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        title={<Trans>Shared repositories</Trans>}
        body={<Trans>Collaborators see your in-progress edits as soon as they sync.</Trans>}
      />
    </>
  );
}

function PullOnlyBullets() {
  return (
    <>
      <DisclosureWarningItem
        icon={
          <ArrowDownToLine
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        }
        title={<Trans>Updates flow in</Trans>}
        body={<Trans>New changes from your remote appear in your copy automatically.</Trans>}
      />
      <DisclosureWarningItem
        icon={
          <Laptop aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        }
        title={<Trans>Your edits stay on this computer</Trans>}
        body={
          <Trans>
            Follow never pushes or commits your local changes. They stay only on this machine.
          </Trans>
        }
      />
      <DisclosureWarningItem
        icon={
          <GitMerge aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        }
        title={<Trans>Overlapping edits</Trans>}
        body={
          <Trans>
            If an update arrives for something you are editing, you choose which version to keep,
            like a merge conflict.
          </Trans>
        }
      />
    </>
  );
}
