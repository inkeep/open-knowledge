/**
 * Shared content for the share-receive miss surface — the target-status verdict
 * fetch plus the icon / message / actions rendering. Consumed by two shells:
 *
 *   - `ShareReceiveMissDialog` (primary) — a modal shown WITHOUT navigating to
 *     the dead path, so a deleted / renamed / never-pushed target never opens a
 *     phantom tab.
 *   - `ShareReceiveMissPanel` (backstop) — the in-tab surface for the rare case
 *     where the miss is only discovered after navigation (main's pre-nav probe
 *     said the target existed, but the receiver's local ref no longer carries
 *     it). Kept so the create-mode fork trap stays mechanically closed.
 *
 * Fail-open: no desktop bridge, no branch, or a failed fetch resolves to
 * `unknown` (the honest "your checkout is behind — pull" guidance).
 */
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

/** Parent folder of a target path — the browse-folder escape destination. */
export function parentFolderPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Fetch the target-status verdict for a share-receive miss. Fail-open: no
 * bridge / no branch / failed fetch → `unknown`.
 *
 * `refetch` re-runs the probe for the SAME target — used after a "Sync now"
 * push lands, when the just-pushed local delete/rename means the honest
 * verdict has changed (typically to `deleted` or `renamed`).
 */
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
    // No desktop bridge (web host) or a branch-less legacy share → skip the
    // fetch and fall back to today's pull guidance rather than a bare spinner.
    if (!bridge || branch === null) {
      setState({ phase: 'resolved', resolution: { verdict: 'unknown' } });
      return;
    }
    let cancelled = false;
    void bridge.project
      .fetchTargetStatus({
        projectPath: bridge.config.projectPath,
        branch,
        path: nav.path,
        kind: nav.kind,
      })
      .then((response) => {
        // `null` is a transport failure; the proxy already coerces a skewed 200
        // to `unknown`. Both degrade to today's guidance (fail-open).
        if (!cancelled)
          setState({ phase: 'resolved', resolution: response ?? { verdict: 'unknown' } });
      })
      .catch((err) => {
        if (!cancelled) {
          // Keep the error identity for triage (a bare `unknown` verdict hides
          // whether the IPC bridge, the fetch, or the server was the cause).
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
  }, [branch, nav.kind, nav.path, epoch]);
  return {
    state,
    refetch: () => {
      setState({ phase: 'pending' });
      setEpoch((e) => e + 1);
    },
  };
}

/**
 * "Enable auto-sync" recovery action for the `changed-locally` cell — mounted
 * ONLY for that verdict, so the shared miss content stays free of config
 * context for every other verdict (and every other surface that renders it).
 * Runs the same guarded off → on flow as the sync badge, the settings toggle,
 * and the share popover's freshness row: `EnableSyncConfirmDialog` is the
 * sanctioned gate for a transition that starts pushing the repo. Reuses the
 * canonical hook so the safety gate can't be bypassed, and enables in place
 * rather than sending the user off to the settings surface.
 */
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
        <Trans>Enable auto-sync</Trans>
      </Button>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
    </>
  );
}

/**
 * "Sync now" recovery action for the `changed-locally` cell when auto-sync is
 * ALREADY on — the counterpart to `EnableAutoSyncButton` (sync off). Mirrors
 * the share popover's Sync-now: trigger the engine, hold an in-flight state
 * until the push lands (a `lastSyncUtc` advance over the CC1-refreshed
 * status), then hand control back via `onSyncCompleted` so the host re-probes
 * the verdict — the just-pushed local delete/rename means the honest cell is
 * now `deleted` or `renamed` (with its redirect offer), not this one.
 */
function SyncNowButton({
  status,
  onSyncCompleted,
}: {
  status: GitSyncStatus;
  onSyncCompleted?: () => void;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  // The `lastSyncUtc` at click time; a later value means a sync completed
  // since — the "push landed" signal.
  const lastSyncAtClick = useRef<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (status.pushError || status.pushErrorCode) {
      // The manual sync failed — drop the in-flight state so the user can
      // retry (the sync badge carries the error detail).
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
    // A trigger that never lands (offline / server down / non-2xx) gets no CC1
    // status update, so drop out of the in-flight state rather than spin
    // forever — the user can retry.
    triggerSync('sync').catch((err) => {
      console.warn('[receive] miss sync trigger failed', err instanceof Error ? err.message : err);
      setPending(false);
      // Silent re-enable reads as a broken button; say why, like the pull CTA's
      // inline failure line does for its trigger-failure arm.
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
      {/* Same announcement contract as the pull button below: a disabled
          control's silent label swap is invisible to screen readers, so an
          always-mounted region populating on start is what carries the news. */}
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

/** Pull outcomes the surface reports itself; the rest resolve the miss instead. */
type PullFailure = Extract<PullOutcome, 'refused' | 'error'>;

/**
 * Whether the follow offer has already been made in this app session. A receiver
 * who declined once should not be asked again on every later pull, and the
 * decline is deliberately not persisted — a fresh session is a fresh chance to
 * offer, which is cheap because the offer only ever follows a pull they asked
 * for.
 */
let followOfferMade = false;

/** Test-only: clear the once-per-session offer latch. Production never resets it. */
export function __resetFollowOfferLatchForTests(): void {
  followOfferMade = false;
}

/**
 * Whether a landed pull should be followed by the keep-this-copy-updated offer.
 * Someone already syncing has nothing to enable, and a status the surface never
 * received says nothing about their mode.
 */
function shouldOfferFollow(status: GitSyncStatus | null): boolean {
  return !followOfferMade && status !== null && status.syncEnabled !== true;
}

/**
 * Whether a one-shot pull can be offered for this project. An absent (as opposed
 * to null) `lastPullUtc` means the engine predates the pull-outcome contract, so
 * a triggered pull would never report back and the CTA would spin forever; the
 * engine refuses one-shot pulls while conflicted; and there is nothing to pull
 * without a remote.
 */
function pullActionable(status: GitSyncStatus | null): boolean {
  if (status === null) return false;
  return status.hasRemote && status.lastPullUtc !== undefined && status.state !== 'conflict';
}

/**
 * Drives a one-shot pull for the behind cells. The engine runs a one-shot pull
 * in ANY sync mode, including off, and it only ever fetches + fast-forwards
 * (never commits or pushes), so an explicit click is the whole consent needed.
 *
 * Completion is a CHANGE in `lastPullUtc`, which the engine bumps at every pull
 * completion — including `up-to-date` and `error`. Watching `lastSyncUtc` (as
 * the sibling push CTAs do) cannot work here: an up-to-date pull never advances
 * it, so the surface would hang on the most common outcome.
 *
 * A clean pull can hand off to the follow offer instead of resolving straight
 * away (`offering`); resolution then waits for the receiver's answer.
 */
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
    // A completion with no recorded outcome resolves optimistically: the pull
    // bumped `lastPullUtc`, so it ran, and there is nothing to report on.
    if (outcome === null) {
      onApplied?.();
      return;
    }
    // Exhaustive over `PullOutcome` so a new variant can't silently fall through
    // to opening the target — the first consumer of the outcome contract, so it
    // sets the precedent that every future outcome makes a deliberate choice.
    switch (outcome) {
      case 'refused':
      case 'error':
        setFailure(outcome);
        return;
      case 'succeeded':
      case 'up-to-date':
        // Only a clean pull earns the follow offer; a receiver already syncing
        // has nothing to enable.
        if (shouldOfferFollow(status)) {
          followOfferMade = true;
          setOffering(true);
          return;
        }
        onApplied?.();
        return;
      case 'conflict':
        // Resolves the miss like a plain success: the fast-forward has already
        // landed (branch at the origin tip, target materialized), and the
        // locked-editor conflict resolver owns the conflict signal from here.
        onApplied?.();
        return;
      default: {
        // Optimistic resolution stays the default for an unknown outcome, but a
        // new `PullOutcome` fails the build here until it is handled on purpose.
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
      // A trigger that never lands (offline / server down / non-2xx) gets no CC1
      // status update, so report it here rather than waiting forever.
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

/**
 * "Pull latest changes" recovery for the behind cells — an in-product
 * alternative to running `git pull` in a terminal. Presentational: the pull
 * state lives in `useOneShotPull` on the host so the failure line can read it
 * too.
 */
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
      {/* A disabled control is skipped by the virtual cursor and its silent
          label swap fires no announcement, so this always-mounted region is
          what tells a screen-reader user the pull actually started. Populating
          an existing region (not inserting one) is what makes the announcement
          reliable across screen readers. */}
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

/**
 * The keep-this-copy-updated offer: follow mode — the one-directional sync that
 * keeps pulling origin without ever pushing this receiver's copy — proposed
 * right after a pull the receiver asked for, when its worth has just been shown,
 * rather than as a second button competing with the pull itself.
 *
 * Mounted only while the offer stands, so the shared miss content reads config
 * context at the one moment it can act on it. Either answer resolves the miss:
 * declining must never cost the receiver the document they followed the link
 * for, and a failed write is the toast's problem, not a reason to strand them.
 */
function FollowOfferGate({
  onResolve,
  strandedCommitCount,
}: {
  onResolve: () => void;
  /** Unpushed local commits follow mode would strand — drives the same consent disclosure every sibling enable surface shows. */
  strandedCommitCount: number;
}) {
  const modeWriter = useSyncModeWriter();
  const resolved = useRef(false);
  function resolveOnce(): void {
    if (resolved.current) return;
    resolved.current = true;
    onResolve();
  }
  // Mounted only when sync is off, so `off` is the mode being moved away from.
  const { confirmOpen, setConfirmOpen, onModeSelect, onConfirm } = useSyncModeSelection(
    modeWriter,
    'off',
    { onApplied: resolveOnce },
  );
  // Selecting follow is what opens the consent gate, and mounting is this
  // component's whole trigger — there is no click to hang it off. Latched so the
  // gate can't reopen itself as the answered dialog closes.
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

/**
 * Inner content for the miss surface — spinner while pending, else the icon +
 * cause-specific message + escape actions. The OUTER container (with its
 * `data-testid` / `data-phase` / `data-verdict`) is owned by each shell so the
 * DOM node stays stable across the pending → resolved transition (a type swap
 * here would remount the node). Callbacks let each shell decide what "browse
 * folder" / "open renamed" do (the dialog dismisses itself; the panel re-arms
 * for a chained miss).
 */
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
  /** Called after a successful in-place Enable auto-sync (changed-locally cell) — the shell dismisses or navigates away. */
  onEnableAutoSync?: () => void;
  /** Called after a "Sync now" push lands (changed-locally cell) — the shell re-probes the verdict, which the push has changed. */
  onSyncCompleted?: () => void;
  /** Called when a pull completed in a state that can resolve the miss (behind cells) — the shell navigates to the target or re-probes. */
  onPullApplied?: () => void;
}) {
  const { t } = useLingui();
  // Sync state feeds the changed-locally cell (Enable auto-sync vs Sync now) and
  // the behind cells' pull CTA; for the other verdicts it is read and unused.
  // Null until the first status response — no CTA renders on an unknown state.
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
    // The target is still on origin and in the receiver's committed HEAD, but
    // they removed/renamed it in their own working tree without syncing. This is
    // NOT "behind — pull": pulling can't reconcile an uncommitted local change.
    //
    // The recovery CTA depends on the sync toggle: OFF gets the guarded Enable
    // auto-sync flow; ON gets Sync now (pushing the local change, after which
    // the re-probed verdict lands on the honest deleted/renamed cell). A
    // degraded engine (denied push, active push error, non-actionable state)
    // or an unknown sync state gets neither — Browse folder stays.
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
    // on-origin (local ref behind) and unknown (fetch failed / no bridge) both
    // land on the honest stale-local pull guidance. When the engine can run a
    // one-shot pull the surface offers it instead of telling the receiver to go
    // do it by hand, so the copy drops the manual instruction.
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
    // Pre-mounted like the progress regions: populating an existing alert is
    // what screen readers reliably announce — one inserted already-full is
    // skipped by some (NVDA + Chrome). Kept sr-only while empty so the blank
    // region neither shows nor consumes a flex gap.
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
      {/* Wraps so a pair of long action labels (translations run much longer
          than the English) stacks instead of overflowing the narrow dialog. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
        {actions}
      </div>
    </>
  );
}
