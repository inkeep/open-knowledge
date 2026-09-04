import type { PullOutcome, ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowDownToLine,
  FilePen,
  FileQuestion,
  FileX2,
  FolderOpen,
  MapPin,
  RefreshCw,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  useEnableSyncWithConfirm,
  useSyncEnabledWriter,
  useSyncModeSelection,
  useSyncModeWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import { type GitSyncStatus, useGitSyncStatus } from '@/hooks/use-git-sync-status';
import type { PendingReceiveNav } from '@/lib/share/pending-receive-nav-store';
import { triggerSync } from '@/lib/trigger-sync';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';
import { syncNowActionable } from './ShareFreshnessWarning';

export type ShareTargetVerdictState =
  | { readonly phase: 'pending' }
  | { readonly phase: 'resolved'; readonly resolution: ShareTargetStatusResponse };

export function parentFolderPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function useShareTargetVerdict(nav: PendingReceiveNav): {
  state: ShareTargetVerdictState;
  refetch: () => void;
} {
  const [state, setState] = useState<ShareTargetVerdictState>({ phase: 'pending' });
  const [epoch, setEpoch] = useState(0);
  const branch = nav.branch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is not read in the body — it exists solely to re-run the probe on refetch()
  useEffect(() => {
    const bridge = window.okDesktop ?? null;
    if (!bridge || branch === null) {
      setState({ phase: 'resolved', resolution: { verdict: 'unknown' } });
      return;
    }
    let cancelled = false;
    void bridge.project
      .fetchTargetStatus({
        projectPath: bridge.config.projectPath,
        branch,
        path: nav.repositoryPath ?? nav.path,
        kind: nav.kind,
        ...(nav.contentRootDepth === undefined ? {} : { contentRootDepth: nav.contentRootDepth }),
      })
      .then((response) => {
        if (!cancelled)
          setState({ phase: 'resolved', resolution: response ?? { verdict: 'unknown' } });
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn(
            '[receive] miss target-status fetch failed',
            err instanceof Error ? err.message : err,
          );
          setState({ phase: 'resolved', resolution: { verdict: 'unknown' } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [branch, nav.kind, nav.path, nav.repositoryPath, nav.contentRootDepth, epoch]);
  return {
    state,
    refetch: () => {
      setState({ phase: 'pending' });
      setEpoch((e) => e + 1);
    },
  };
}

function EnableAutoSyncButton({ onEnabled }: { onEnabled?: () => void }) {
  const enableSyncWriter = useSyncEnabledWriter();
  const { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm } = useEnableSyncWithConfirm(
    enableSyncWriter,
    { onEnabled },
  );
  return (
    <>
      <Button onClick={() => onToggleRequest(true)} data-testid="share-receive-miss-enable-sync">
        <RefreshCw className="size-4" aria-hidden="true" />
        <Trans>Enable Auto (Pull and Push)</Trans>
      </Button>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
    </>
  );
}

function SyncNowButton({
  status,
  onSyncCompleted,
}: {
  status: GitSyncStatus;
  onSyncCompleted?: () => void;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const lastSyncAtClick = useRef<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (status.pushError || status.pushErrorCode) {
      setPending(false);
      return;
    }
    if ((status.lastSyncUtc ?? null) !== lastSyncAtClick.current) {
      setPending(false);
      onSyncCompleted?.();
    }
  }, [pending, status, onSyncCompleted]);

  const handleSyncNow = () => {
    lastSyncAtClick.current = status.lastSyncUtc ?? null;
    setPending(true);
    triggerSync('sync').catch((err) => {
      console.warn('[receive] miss sync trigger failed', err instanceof Error ? err.message : err);
      setPending(false);
      toast.error(t`Couldn't start the sync. Check your connection, then retry.`);
    });
  };

  return (
    <>
      {pending ? (
        <Button disabled aria-busy="true" data-testid="share-receive-miss-sync-now">
          <Spinner icon={RefreshCw} className="size-4" aria-hidden="true" />
          <Trans>Syncing</Trans>
        </Button>
      ) : (
        <Button onClick={handleSyncNow} data-testid="share-receive-miss-sync-now">
          <RefreshCw className="size-4" aria-hidden="true" />
          <Trans>Sync now</Trans>
        </Button>
      )}
      {}
      <span
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="share-receive-miss-sync-status"
      >
        {pending ? <Trans>Syncing your changes</Trans> : null}
      </span>
    </>
  );
}

type PullFailure = Extract<PullOutcome, 'refused' | 'error'>;

let followOfferMade = false;

export function __resetFollowOfferLatchForTests(): void {
  followOfferMade = false;
}

function shouldOfferFollow(status: GitSyncStatus | null): boolean {
  return !followOfferMade && status !== null && status.syncEnabled !== true;
}

function pullActionable(status: GitSyncStatus | null): boolean {
  if (status === null) return false;
  return status.hasRemote && status.lastPullUtc !== undefined && status.state !== 'conflict';
}

function useOneShotPull(
  status: GitSyncStatus | null,
  onApplied?: () => void,
): {
  pending: boolean;
  failure: PullFailure | null;
  offering: boolean;
  start: () => void;
  resolveOffer: () => void;
} {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PullFailure | null>(null);
  const [offering, setOffering] = useState(false);
  const lastPullAtClick = useRef<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    if ((status?.lastPullUtc ?? null) === lastPullAtClick.current) return;
    setPending(false);
    const outcome = status?.lastPullOutcome ?? null;
    if (outcome === null) {
      onApplied?.();
      return;
    }
    switch (outcome) {
      case 'refused':
      case 'error':
        setFailure(outcome);
        return;
      case 'succeeded':
      case 'up-to-date':
        if (shouldOfferFollow(status)) {
          followOfferMade = true;
          setOffering(true);
          return;
        }
        onApplied?.();
        return;
      case 'conflict':
        onApplied?.();
        return;
      default: {
        const _exhaustive: never = outcome;
        void _exhaustive;
        onApplied?.();
        return;
      }
    }
  }, [pending, status, onApplied]);

  return {
    pending,
    failure,
    offering,
    resolveOffer: () => {
      setOffering(false);
      onApplied?.();
    },
    start: () => {
      lastPullAtClick.current = status?.lastPullUtc ?? null;
      setFailure(null);
      setPending(true);
      triggerSync('pull').catch((err) => {
        console.warn(
          '[receive] miss pull trigger failed',
          err instanceof Error ? err.message : err,
        );
        setPending(false);
        setFailure('error');
      });
    },
  };
}

function PullNowButton({ pending, onPull }: { pending: boolean; onPull: () => void }) {
  return (
    <>
      {pending ? (
        <Button disabled aria-busy="true" data-testid="share-receive-miss-pull-now">
          <Spinner icon={RefreshCw} className="size-4" aria-hidden="true" />
          <Trans>Pulling</Trans>
        </Button>
      ) : (
        <Button onClick={onPull} data-testid="share-receive-miss-pull-now">
          <ArrowDownToLine className="size-4" aria-hidden="true" />
          <Trans>Pull latest changes</Trans>
        </Button>
      )}
      {}
      <span
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="share-receive-miss-pull-status"
      >
        {pending ? <Trans>Pulling the latest changes</Trans> : null}
      </span>
    </>
  );
}

function FollowOfferGate({
  onResolve,
  strandedCommitCount,
}: {
  onResolve: () => void;
  strandedCommitCount: number;
}) {
  const modeWriter = useSyncModeWriter();
  const resolved = useRef(false);
  function resolveOnce(): void {
    if (resolved.current) return;
    resolved.current = true;
    onResolve();
  }
  const { confirmOpen, setConfirmOpen, onModeSelect, onConfirm } = useSyncModeSelection(
    modeWriter,
    'off',
    { onApplied: resolveOnce },
  );
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    onModeSelect('follow');
  }, [onModeSelect]);
  return (
    <EnableSyncConfirmDialog
      open={confirmOpen}
      onOpenChange={(open) => {
        setConfirmOpen(open);
        if (!open) resolveOnce();
      }}
      onConfirm={() => {
        onConfirm();
        resolveOnce();
      }}
      variant="follow"
      strandedCommitCount={strandedCommitCount}
    />
  );
}

export function ShareReceiveMissContent({
  nav,
  state,
  onBrowseFolder,
  onOpenRenamed,
  onEnableAutoSync,
  onSyncCompleted,
  onPullApplied,
}: {
  nav: PendingReceiveNav;
  state: ShareTargetVerdictState;
  onBrowseFolder: () => void;
  onOpenRenamed: (renamedTo: string) => void;
  onEnableAutoSync?: () => void;
  onSyncCompleted?: () => void;
  onPullApplied?: () => void;
}) {
  const { t } = useLingui();
  const syncStatus = useGitSyncStatus();
  const pull = useOneShotPull(syncStatus, onPullApplied);
  const branch = nav.branch;
  const targetNoun = nav.kind === 'folder' ? t`folder` : t`document`;

  if (state.phase === 'pending') {
    return (
      <>
        <Spinner className="size-5" aria-hidden="true" />
        <Trans>Checking for updates on GitHub</Trans>
      </>
    );
  }
  const { resolution } = state;

  const browseFolderButton = (
    <Button variant="outline" onClick={onBrowseFolder} data-testid="share-receive-miss-browse">
      <FolderOpen className="size-4" aria-hidden="true" />
      <Trans>Browse folder</Trans>
    </Button>
  );

  let icon: ReactNode;
  let message: ReactNode;
  let actions: ReactNode;
  let failureLine: ReactNode = null;

  if (resolution.verdict === 'renamed') {
    icon = <MapPin className="size-9" aria-hidden="true" />;
    message = (
      <Trans>
        This {targetNoun} moved to{' '}
        <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
          {resolution.renamedTo}
        </code>
        . Open it there?
      </Trans>
    );
    actions = (
      <>
        <Button
          onClick={() => onOpenRenamed(resolution.renamedTo)}
          data-testid="share-receive-miss-open-renamed"
        >
          <MapPin className="size-4" aria-hidden="true" />
          <Trans>Open it there</Trans>
        </Button>
        {browseFolderButton}
      </>
    );
  } else if (resolution.verdict === 'deleted') {
    icon = <FileX2 className="size-9" aria-hidden="true" />;
    message = (
      <Trans>
        This {targetNoun} was removed from branch{' '}
        <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code>.
      </Trans>
    );
    actions = browseFolderButton;
  } else if (resolution.verdict === 'never-on-branch') {
    icon = <FileQuestion className="size-9" aria-hidden="true" />;
    message = (
      <Trans>
        This {targetNoun} isn't on branch{' '}
        <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code>. It may
        not have been pushed yet.
      </Trans>
    );
    actions = browseFolderButton;
  } else if (resolution.verdict === 'changed-locally') {
    icon = <FilePen className="size-9" aria-hidden="true" />;
    const syncOn = syncStatus?.syncEnabled === true;
    const pushDegraded =
      syncStatus?.pushPermission?.checkStatus === 'denied' ||
      Boolean(syncStatus?.pushError || syncStatus?.pushErrorCode);
    if (syncOn) {
      message =
        branch === null ? (
          <Trans>
            This {targetNoun} has been moved, renamed, or deleted in your local copy, and that
            change hasn't synced yet.
          </Trans>
        ) : (
          <Trans>
            This {targetNoun} has been moved, renamed, or deleted in your local copy of branch{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code>,
            and that change hasn't synced yet.
          </Trans>
        );
    } else {
      message =
        branch === null ? (
          <Trans>
            This {targetNoun} has been moved, renamed, or deleted in your local copy. Please commit
            your changes or enable auto-sync.
          </Trans>
        ) : (
          <Trans>
            This {targetNoun} has been moved, renamed, or deleted in your local copy of branch{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code>.
            Please commit your changes or enable auto-sync.
          </Trans>
        );
    }
    let syncAction: ReactNode = null;
    if (syncStatus?.syncEnabled) {
      if (syncNowActionable(syncStatus) && !pushDegraded) {
        syncAction = <SyncNowButton status={syncStatus} onSyncCompleted={onSyncCompleted} />;
      }
    } else if (syncStatus !== null) {
      syncAction = <EnableAutoSyncButton onEnabled={onEnableAutoSync} />;
    }
    actions = (
      <>
        {syncAction}
        {browseFolderButton}
      </>
    );
  } else {
    icon = <ArrowDownToLine className="size-9" aria-hidden="true" />;
    const canPull = pullActionable(syncStatus);
    if (canPull) {
      message =
        branch === null ? (
          <Trans>Your local copy is behind.</Trans>
        ) : (
          <Trans>
            Your local copy of branch{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code> is
            behind.
          </Trans>
        );
    } else {
      message =
        branch === null ? (
          <Trans>
            Your local copy is behind. Pull the latest changes, then open the link again.
          </Trans>
        ) : (
          <Trans>
            Your local copy of branch{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code> is
            behind. Pull the latest changes, then open the link again.
          </Trans>
        );
    }
    failureLine = (
      <p
        role="alert"
        className={
          pull.failure !== null ? 'max-w-md text-balance text-1sm text-destructive' : 'sr-only'
        }
        data-testid="share-receive-miss-pull-error"
      >
        {pull.failure === 'refused' ? (
          <Trans>Another sync operation is in progress. Try again in a moment.</Trans>
        ) : pull.failure === 'error' ? (
          <Trans>Couldn't pull from GitHub. Check your connection and sign-in, then retry.</Trans>
        ) : null}
      </p>
    );
    actions = (
      <>
        {canPull ? <PullNowButton pending={pull.pending} onPull={pull.start} /> : null}
        {browseFolderButton}
        {pull.offering ? (
          <FollowOfferGate
            onResolve={pull.resolveOffer}
            strandedCommitCount={syncStatus?.ahead ?? 0}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex size-16 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
        {icon}
      </div>
      <p className="max-w-md text-balance text-base leading-6 text-foreground/90">{message}</p>
      {failureLine}
      {}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
        {actions}
      </div>
    </>
  );
}
