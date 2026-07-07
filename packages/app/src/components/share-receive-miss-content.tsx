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
import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowDownToLine,
  FilePen,
  FileQuestion,
  FileX2,
  FolderOpen,
  Loader2,
  MapPin,
  RefreshCw,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  useEnableSyncWithConfirm,
  useSyncEnabledWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import type { PendingReceiveNav } from '@/lib/share/pending-receive-nav-store';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';

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
 */
export function useShareTargetVerdict(nav: PendingReceiveNav): ShareTargetVerdictState {
  const [state, setState] = useState<ShareTargetVerdictState>({ phase: 'pending' });
  const branch = nav.branch;
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
  }, [branch, nav.kind, nav.path]);
  return state;
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
}: {
  nav: PendingReceiveNav;
  state: ShareTargetVerdictState;
  onBrowseFolder: () => void;
  onOpenRenamed: (renamedTo: string) => void;
  /** Called after a successful in-place Enable auto-sync (changed-locally cell) — the shell dismisses or navigates away. */
  onEnableAutoSync?: () => void;
}) {
  const { t } = useLingui();
  const branch = nav.branch;
  const targetNoun = nav.kind === 'folder' ? t`folder` : t`document`;

  if (state.phase === 'pending') {
    return (
      <>
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
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
    icon = <FilePen className="size-9" aria-hidden="true" />;
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
    actions = (
      <>
        <EnableAutoSyncButton onEnabled={onEnableAutoSync} />
        {browseFolderButton}
      </>
    );
  } else {
    // on-origin (local ref behind) and unknown (fetch failed / no bridge) both
    // land on the honest stale-local pull guidance.
    icon = <ArrowDownToLine className="size-9" aria-hidden="true" />;
    message =
      branch === null ? (
        <Trans>Your local copy is behind. Pull the latest changes, then open the link again.</Trans>
      ) : (
        <Trans>
          Your local copy of branch{' '}
          <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">{branch}</code> is
          behind. Pull the latest changes, then open the link again.
        </Trans>
      );
    actions = browseFolderButton;
  }

  return (
    <>
      <div className="flex size-16 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
        {icon}
      </div>
      <p className="max-w-md text-balance text-base leading-6 text-foreground/90">{message}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">{actions}</div>
    </>
  );
}
