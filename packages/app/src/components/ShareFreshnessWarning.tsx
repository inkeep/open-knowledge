/**
 * Non-blocking freshness warning row for the share popover. Renders only when
 * the minted link won't reflect what the sender sees — a stale or absent
 * target — and stays silent otherwise, including the auto-sync-on + stale cell
 * that self-heals within the push cadence.
 *
 * The row is icon + text (never color-only): the fact line always states the
 * problem in words, so a screen reader (and a user who can't perceive the tint)
 * gets the full signal. It also carries the recovery CTAs — enable auto-sync,
 * push manually, or Sync now — except where a denied push probe or an active
 * push error would make those CTAs wrong.
 */

import type { ShareFreshness } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  useEnableSyncWithConfirm,
  useSyncEnabledWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { triggerSync } from '@/lib/trigger-sync';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';

type ShareKind = 'doc' | 'folder';

/** Official git-push documentation the "push manually" CTA links out to. */
const PUSH_DOCS_URL = 'https://git-scm.com/docs/git-push';

/**
 * Whether the warning row renders for `(freshness, status)`. The share popover
 * reads this to size itself before the row mounts. `current` / omitted freshness
 * never warns; `stale` with auto-sync ON is the ratified silent cell.
 */
export function shareFreshnessRowVisible(
  freshness: ShareFreshness | undefined,
  status: GitSyncStatus | null,
): boolean {
  if (freshness !== 'stale' && freshness !== 'absent') return false;
  if (freshness === 'stale' && status?.syncEnabled === true) return false;
  return true;
}

/**
 * "Sync now" mirrors the sync badge's own visibility: it is hidden in the
 * states where a manual trigger is meaningless or handled elsewhere (no engine,
 * turned off, needs re-auth, or blocked on a conflict).
 */
function syncNowActionable(status: GitSyncStatus | null): boolean {
  if (!status) return false;
  return (
    status.state !== 'dormant' &&
    status.state !== 'disabled' &&
    status.state !== 'auth-error' &&
    status.state !== 'conflict'
  );
}

export interface ShareFreshnessWarningProps {
  freshness: ShareFreshness | undefined;
  status: GitSyncStatus | null;
  kind: ShareKind;
}

export function ShareFreshnessWarning({ freshness, status, kind }: ShareFreshnessWarningProps) {
  const { t } = useLingui();
  // "Enable auto-sync" runs the same guarded off → on flow as the sync badge and
  // the settings toggle — the EnableSyncConfirmDialog is the sanctioned gate for
  // a transition that starts pushing the repo. It enables sync in place rather
  // than sending the sender off to the settings surface to find the toggle.
  const enableSyncWriter = useSyncEnabledWriter();
  const { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm } =
    useEnableSyncWithConfirm(enableSyncWriter);
  const [syncNow, setSyncNow] = useState<'idle' | 'pending' | 'synced'>('idle');
  // The `lastSyncUtc` at click time; a later value means a sync completed since,
  // which is our "the push landed" signal over the CC1-refreshed status.
  const lastSyncAtClick = useRef<string | null>(null);

  useEffect(() => {
    if (syncNow !== 'pending' || !status) return;
    if (status.pushError || status.pushErrorCode) {
      // The manual sync failed — drop the in-flight state so the warning (now
      // showing the sync-failing line) stands rather than spinning forever.
      setSyncNow('idle');
      return;
    }
    if ((status.lastSyncUtc ?? null) !== lastSyncAtClick.current) {
      setSyncNow('synced');
    }
  }, [syncNow, status]);

  if (!shareFreshnessRowVisible(freshness, status)) return null;

  const rowClass =
    'flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/40 p-2 text-xs text-muted-foreground';

  if (syncNow === 'synced') {
    return (
      <div className={rowClass} data-testid="share-freshness-row">
        <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <Trans>Synced. The link is up to date.</Trans>
        </span>
      </div>
    );
  }

  const syncEnabled = status?.syncEnabled === true;
  const pushDenied = status?.pushPermission?.checkStatus === 'denied';
  const activePushError = Boolean(status?.pushError || status?.pushErrorCode);
  const degraded = pushDenied || activePushError;
  // A never-pushed target with sync off is the only strong (dead-link) warning;
  // the rest are soft notes.
  const strong = freshness === 'absent' && !syncEnabled;

  let factLine: string;
  if (freshness === 'absent' && !syncEnabled) {
    factLine =
      kind === 'folder'
        ? t`This folder isn't on GitHub yet. The link won't work until it's pushed.`
        : t`This doc isn't on GitHub yet. The link won't work until it's pushed.`;
  } else if (freshness === 'stale') {
    factLine =
      kind === 'folder'
        ? t`This folder has unpushed changes. Recipients will see the last pushed version.`
        : t`This doc has unpushed changes. Recipients will see the last pushed version.`;
  } else {
    factLine =
      kind === 'folder'
        ? t`This folder hasn't synced to GitHub yet. The link will work after the next sync.`
        : t`This doc hasn't synced to GitHub yet. The link will work after the next sync.`;
  }

  // A denied push probe or an active push error makes the recovery CTAs wrong
  // (the sender can't push), so the row states the blocker instead.
  const degradedLine = pushDenied
    ? t`You don't have write access to this repo.`
    : activePushError
      ? t`Sync is failing. See the sync status for details.`
      : null;

  const handleSyncNow = () => {
    lastSyncAtClick.current = status?.lastSyncUtc ?? null;
    setSyncNow('pending');
    // On a trigger that never lands (offline / server down / non-2xx) no CC1
    // status update follows, so drop out of the in-flight state rather than
    // spin forever — the user can retry, and the row falls back to its fact
    // line. Success stays 'pending' until the status effect sees the push land.
    triggerSync('sync').catch((err) => {
      console.warn(
        '[share-freshness] sync trigger failed',
        err instanceof Error ? err.message : err,
      );
      setSyncNow('idle');
    });
  };

  const Icon = strong ? TriangleAlert : Info;

  return (
    <>
      <div className={rowClass} data-testid="share-freshness-row">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span>{factLine}</span>
          {degradedLine ? <span>{degradedLine}</span> : null}
          {degraded ? null : syncEnabled ? (
            syncNowActionable(status) ? (
              <div>
                {syncNow === 'pending' ? (
                  <Button variant="outline" size="xs" disabled>
                    <RefreshCw className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                    <Trans>Syncing</Trans>
                  </Button>
                ) : (
                  <Button variant="outline" size="xs" onClick={handleSyncNow}>
                    <Trans>Sync now</Trans>
                  </Button>
                )}
              </div>
            ) : null
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button variant="outline" size="xs" onClick={() => onToggleRequest(true)}>
                <Trans>Enable auto-sync</Trans>
              </Button>
              <a
                href={PUSH_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => dispatchExternalLinkClick(e, PUSH_DOCS_URL)}
                onAuxClick={(e) => dispatchExternalLinkClick(e, PUSH_DOCS_URL)}
                className="inline-flex items-center gap-1 transition-colors hover:text-primary"
              >
                <Trans>How to push manually</Trans>
                <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
              </a>
            </div>
          )}
        </div>
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
    </>
  );
}
