import { Trans } from '@lingui/react/macro';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  Eye,
  GitCommitVertical,
  GitMerge,
  Laptop,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { AutoSyncOnboardingVariant } from '@/components/auto-sync-onboarding-gate';
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
    <div role="note" className="text-sm space-y-5">
      <p className="flex items-center gap-1.5 text-xs font-semibold font-mono uppercase tracking-wider text-primary">
        <span aria-hidden="true" className="mb-[3px] flex items-center justify-center">
          ◇
        </span>
        <Trans>Heads up</Trans>
      </p>
      <div className="space-y-5">
        {variant === 'follow' ? <PullOnlyBullets /> : <FullSyncBullets />}
      </div>
    </div>
  );
}

function FullSyncBullets() {
  return (
    <>
      <WarningBullet
        icon={
          <ArrowRightLeft
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        }
        title={<Trans>Uncommitted changes</Trans>}
        body={<Trans>Pulls may overwrite uncommitted edits in your local files.</Trans>}
      />
      <WarningBullet
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
      <WarningBullet
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
      <WarningBullet
        icon={
          <ArrowDownToLine
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        }
        title={<Trans>Updates flow in</Trans>}
        body={<Trans>New changes from your remote appear in your copy automatically.</Trans>}
      />
      <WarningBullet
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
      <WarningBullet
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

function WarningBullet({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
