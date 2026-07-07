/**
 * SyncStatusBadge — displays the git sync engine state in the editor header.
 *
 * States: dormant (hidden) | idle/synced | fetching/pulling/pushing (syncing) |
 * conflict | offline | auth-error | disabled | available (sync off, remote present)
 *
 * Click opens a popover with last-sync details and action buttons.
 */

import type { PushPermissionWire, SyncErrorCode } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangle,
  ArrowUpRight,
  Cloud,
  CloudOff,
  LogIn,
  RefreshCw,
  UserCog,
} from 'lucide-react';
import { useConflicts } from '@/hooks/use-conflicts';
import {
  useEnableSyncWithConfirm,
  useSyncEnabledWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import { triggerSync } from '@/lib/trigger-sync';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Switch } from './ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget manual sync from a badge button. The badge's own status
 * stream drives the visible state, so a rejected trigger (offline / server
 * down) needs no UI handling — but it gets a breadcrumb rather than being
 * swallowed silently, so a "Sync now did nothing" report is triageable.
 */
function triggerSyncFromBadge(): void {
  triggerSync('sync').catch((err) => {
    console.warn(
      '[sync-badge] manual sync trigger failed',
      err instanceof Error ? err.message : err,
    );
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return t`never`;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t`just now`;
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    return t`${minutes} min ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return t`${hours}h ago`;
  }
  return new Date(iso).toLocaleDateString();
}

// ── inner: icon + color per state ────────────────────────────────────────────

interface BadgeIconProps {
  status: GitSyncStatus;
}

function BadgeIcon({ status }: BadgeIconProps) {
  const cls = 'size-3.5';
  switch (status.state) {
    case 'dormant':
      // Available: remote exists but sync not yet enabled
      return <Cloud className={`${cls} text-muted-foreground`} />;
    case 'idle':
      if (status.ahead > 0 || status.behind > 0) {
        return <RefreshCw className={`${cls} text-muted-foreground`} />;
      }
      return <Cloud className={`${cls} text-muted-foreground`} />;
    case 'fetching':
    case 'pulling':
    case 'pushing':
      return <RefreshCw className={`${cls} text-muted-foreground animate-spin`} />;
    case 'conflict':
      return <AlertTriangle className={`${cls} text-amber-500`} />;
    case 'offline':
      return <CloudOff className={`${cls} text-muted-foreground`} />;
    case 'auth-error':
      return <LogIn className={`${cls} text-destructive`} />;
    case 'disabled':
      // Reachable only when an auto-disable carries a pausedReason
      // (manual user disable hides the badge via early return below).
      return <AlertTriangle className={`${cls} text-amber-500`} />;
    default:
      return <Cloud className={`${cls} text-muted-foreground`} />;
  }
}

function badgeLabel(status: GitSyncStatus): string {
  switch (status.state) {
    case 'idle':
      if (status.ahead > 0) return `↑${status.ahead}`;
      if (status.behind > 0) return `↓${status.behind}`;
      return '';
    case 'fetching':
    case 'pulling':
    case 'pushing':
      return '';
    case 'conflict':
      return status.conflictCount > 0 ? `${status.conflictCount}` : '';
    case 'offline':
      return '';
    case 'auth-error':
      return '';
    default:
      return '';
  }
}

// ── popover content ───────────────────────────────────────────────────────────

function stateLabel(state: GitSyncStatus['state']): string {
  switch (state) {
    case 'dormant':
      return t`No git remote`;
    case 'idle':
      return t`Synced`;
    case 'fetching':
      return t`Fetching`;
    case 'pulling':
      return t`Pulling`;
    case 'pushing':
      return t`Pushing`;
    case 'conflict':
      return t`Conflict`;
    case 'offline':
      return t`Offline`;
    case 'auth-error':
      return t`Reconnect required`;
    case 'disabled':
      return t`Sync disabled`;
    default:
      return state;
  }
}

export function formatPausedReason(reason: string): string {
  switch (reason) {
    case 'external-changes-pending':
      return t`Local changes overlap with incoming sync`;
    case 'dirty-tree':
      return t`Local changes blocked the merge`;
    case 'non-content-merge-failure':
      return t`Resolve conflict in your terminal`;
    case 'detached-head':
      return t`Detached HEAD — checkout a branch to resume`;
    case 'auth-error':
      return t`Reconnect required`;
    case 'protected-branch':
      return t`Protected branch — cannot push`;
    case 'no-push-permission':
      return t`You don't have permission to push to this repo`;
    default:
      return reason;
  }
}

/**
 * Format the cause-specific message for a `denied` push-permission probe.
 * Used when the user has not enabled sync yet (so `pausedReason` is unset)
 * but the probe says they can't push — they should see the same actionable
 * copy as a user whose engine paused after enabling sync.
 */
export function formatPushPermissionDenied(
  reason: 'no-collaborator' | 'private-no-access' | 'repo-not-found' | undefined,
): string {
  switch (reason) {
    case 'no-collaborator':
      return t`You don't have permission to push to this repo`;
    case 'private-no-access':
      return t`You don't have access to this private repo. Sign in with an account that does.`;
    case 'repo-not-found':
      return t`Repository not found. It may have been renamed, deleted, or moved.`;
    default:
      return t`You don't have permission to push to this repo`;
  }
}

/**
 * Map a server-emitted `errorCode` to a Lingui-localized string. The server
 * never carries English in `errorCode`; the wire payload is the bounded
 * `SyncErrorCode` enum (single-sourced in `@inkeep/open-knowledge-core`).
 * Callers fall back to `status.pushError` (developer-facing raw message) when
 * `pushErrorCode` is undefined.
 */
export function formatPushFailureCode(code: SyncErrorCode): string {
  switch (code) {
    case 'auth-403':
      return t`You don't have permission to push to this repo.`;
    case 'auth-401':
      return t`GitHub authentication failed. Try signing in again.`;
    case 'auth-scope-mismatch':
      return t`Your GitHub token is missing required scopes. Try signing in again.`;
    case 'auth-no-credential':
      return t`GitHub sign-in is missing or expired. Reconnect to resume syncing.`;
    case 'semantic-protected-branch':
      return t`The default branch is protected — pushes need a pull request.`;
    default:
      // Forward-compat: if a future server emits a code this client doesn't
      // recognize (server-client version skew, even though OK ships as a
      // monolith), the errorCode-first render branch would otherwise produce
      // a styled-red empty paragraph. Generic copy keeps the slot meaningful.
      return t`Push failed — check the server logs for details.`;
  }
}

/**
 * Pull-side (fetch + merge) counterpart to {@link formatPushFailureCode}. Same
 * bounded enum, but the copy is framed around reading from the remote rather
 * than pushing. `semantic-protected-branch` is push-only, so it can't reach
 * this path under current classification — it maps to the generic fallback
 * alongside any future unrecognized code.
 */
export function formatPullFailureCode(code: SyncErrorCode): string {
  switch (code) {
    case 'auth-403':
      return t`You don't have access to this repository.`;
    case 'auth-401':
      return t`GitHub authentication failed. Try signing in again.`;
    case 'auth-scope-mismatch':
      return t`Your GitHub token is missing required scopes. Try signing in again.`;
    case 'auth-no-credential':
      return t`GitHub sign-in is missing or expired. Reconnect to resume syncing.`;
    default:
      return t`Fetch failed — check the server logs for details.`;
  }
}

/**
 * Neutral (direction-agnostic) copy for a failure code, used when push and pull
 * failed with the same root cause and collapse into a single line. The push- and
 * pull-specific framings live in {@link formatPushFailureCode} /
 * {@link formatPullFailureCode}; this is the shared-cause variant so the popover
 * doesn't repeat one auth failure as two near-identical lines.
 */
export function formatSyncFailureCode(code: SyncErrorCode): string {
  switch (code) {
    case 'auth-403':
      return t`You don't have access to this repository.`;
    case 'auth-401':
      return t`GitHub authentication failed. Try signing in again.`;
    case 'auth-scope-mismatch':
      return t`Your GitHub token is missing required scopes. Try signing in again.`;
    case 'auth-no-credential':
      return t`GitHub sign-in is missing or expired. Reconnect to resume syncing.`;
    case 'semantic-protected-branch':
      return t`The default branch is protected — pushes need a pull request.`;
    default:
      return t`Sync failed — check the server logs for details.`;
  }
}

type SyncErrorDirection = 'push' | 'pull';

export interface SyncErrorLine {
  /** Stable React key — also the structural identity of the line. */
  key: 'sync' | 'push' | 'pull';
  /** Direction label to render; null when collapsed or a lone error. */
  direction: SyncErrorDirection | null;
  message: string;
}

/**
 * Build the destructive error line(s) for the popover from the per-direction
 * error surfaces:
 *
 * - both legs failed with the same root cause (identical `*ErrorCode`, or
 *   identical raw `*Error` when uncoded) → one neutral, unlabeled line;
 * - both failed with different causes → two lines, each labeled with its
 *   direction so the user can tell push from pull;
 * - one leg failed → a single unlabeled line (its copy already implies the
 *   direction).
 *
 * Pure so the render cascade can't drift from the collapse/label rules without
 * the truth table failing too.
 */
export function computeSyncErrorLines(
  status: Pick<GitSyncStatus, 'pushError' | 'pushErrorCode' | 'pullError' | 'pullErrorCode'>,
): SyncErrorLine[] {
  const pushPresent = status.pushErrorCode != null || status.pushError != null;
  const pullPresent = status.pullErrorCode != null || status.pullError != null;

  if (pushPresent && pullPresent) {
    // Codes are the authoritative root-cause key; fall back to raw-message
    // equality only when neither leg carried a code.
    const sameRootCause =
      status.pushErrorCode != null
        ? status.pushErrorCode === status.pullErrorCode
        : status.pullErrorCode == null && status.pushError === status.pullError;
    if (sameRootCause) {
      return [
        {
          key: 'sync',
          direction: null,
          message:
            status.pushErrorCode != null
              ? formatSyncFailureCode(status.pushErrorCode)
              : (status.pushError as string),
        },
      ];
    }
  }

  const labelDirections = pushPresent && pullPresent;
  const lines: SyncErrorLine[] = [];
  if (pushPresent) {
    lines.push({
      key: 'push',
      direction: labelDirections ? 'push' : null,
      message: status.pushErrorCode
        ? formatPushFailureCode(status.pushErrorCode)
        : (status.pushError as string),
    });
  }
  if (pullPresent) {
    lines.push({
      key: 'pull',
      direction: labelDirections ? 'pull' : null,
      message: status.pullErrorCode
        ? formatPullFailureCode(status.pullErrorCode)
        : (status.pullError as string),
    });
  }
  return lines;
}

/**
 * Decide whether the popover/settings should surface a "Sign in again"
 * affordance for the probe-401 case. Returns true ONLY when the probe
 * itself returned 401 (`unknown/token-invalid`) — never on `denied`
 * (which has its own affordance) or other `unknown` causes (network /
 * rate-limit / malformed-response) where re-auth is not the remedy.
 *
 * Sync stays enabled; only the affordance surfaces. The Switch is NOT
 * disabled in this case — `shouldDisableSyncSwitch` keys off `'denied'`
 * only. The probe couldn't reach a verdict, so the user's existing sync
 * preference is preserved while they re-authenticate.
 */
export function shouldOfferSignInAgain(pushPermission: PushPermissionWire | undefined): boolean {
  return (
    pushPermission?.checkStatus === 'unknown' && pushPermission.unknownError === 'token-invalid'
  );
}

/**
 * Pure helper: decide whether the sync Switch should be disabled given the
 * Hocuspocus-synced flag and the push-permission probe outcome. Extracted so
 * a unit test can pin the truth table without touching React rendering.
 *
 * Returns true when the local config binding hasn't hydrated yet (cold start)
 * or the probe explicitly reports `denied`. Other probe states — `'allowed'`,
 * `'unknown'`, and missing entirely — preserve the existing gating behavior
 * (Switch enabled when synced). This is the read+write parity invariant:
 * a slow / failed / not-yet-resolved probe must never disable the toggle
 * for an `allowed`-historical user.
 */
export function shouldDisableSyncSwitch(
  projectLocalSynced: boolean | undefined,
  pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined,
): boolean {
  if (!projectLocalSynced) return true;
  if (pushPermissionCheckStatus === 'denied') return true;
  return false;
}

function tooltipLabel(status: GitSyncStatus): string {
  if (!status.syncEnabled) return t`Sync off`;
  if (status.state === 'idle') {
    const { ahead, behind } = status;
    if (ahead > 0 && behind > 0) {
      return t`${ahead} ahead, ${behind} behind`;
    }
    if (ahead > 0) return t`${ahead} ahead`;
    if (behind > 0) return t`${behind} behind`;
    return t`Synced`;
  }
  if (status.state === 'conflict' && status.conflictCount > 0) {
    const { conflictCount } = status;
    return plural(conflictCount, { one: '# conflict', other: '# conflicts' });
  }
  return stateLabel(status.state);
}

interface PopoverBodyProps {
  status: GitSyncStatus;
  onSignIn?: () => void;
  onSetIdentity?: () => void;
}

function PopoverBody({ status, onSignIn, onSetIdentity }: PopoverBodyProps) {
  const { t } = useLingui();
  const { ahead, behind, conflictCount } = status;
  const { projectLocalConfig, projectLocalSynced } = useConfigContext();
  const enabled = projectLocalConfig?.autoSync?.enabled ?? false;
  const lastSyncedRelative = formatRelative(status.lastSyncUtc);
  const writer = useSyncEnabledWriter();
  const { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm } =
    useEnableSyncWithConfirm(writer);
  // The "Review conflicts" affordance navigates to the first conflicted file
  // (so the editor-area DiffViewBoundary mounts via the lifecycle observer).
  // There is no side-sheet to open — the sidebar Conflicts section is the
  // project-level list, the editor-area DiffView is the resolution surface.
  const { conflicts } = useConflicts();
  const firstConflict = conflicts[0] ?? null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <BadgeIcon status={status} />
          <span className="text-1sm font-medium truncate">{stateLabel(status.state)}</span>
        </div>
        <Switch
          checked={enabled}
          disabled={shouldDisableSyncSwitch(projectLocalSynced, status.pushPermission?.checkStatus)}
          onCheckedChange={onToggleRequest}
          aria-label={
            status.pushPermission?.checkStatus === 'denied'
              ? t`Sync disabled — you don't have permission to push`
              : enabled
                ? t`Disable sync`
                : t`Enable sync`
          }
        />
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />

      {computeSyncErrorLines(status).map((line) => (
        <p key={line.key} className="text-xs text-destructive">
          {line.direction === 'push' ? (
            <>
              <span className="font-medium">{t`Push`}: </span>
              {line.message}
            </>
          ) : line.direction === 'pull' ? (
            <>
              <span className="font-medium">{t`Pull`}: </span>
              {line.message}
            </>
          ) : (
            line.message
          )}
        </p>
      ))}
      {status.pausedReason ? (
        <p className="text-xs text-muted-foreground">{formatPausedReason(status.pausedReason)}</p>
      ) : status.pushPermission?.checkStatus === 'denied' ? (
        <p className="text-xs text-muted-foreground">
          {formatPushPermissionDenied(status.pushPermission.deniedReason)}
        </p>
      ) : shouldOfferSignInAgain(status.pushPermission) ? (
        // Probe-401 branch: surface a "Sign in again" affordance without
        // disabling sync — the probe couldn't reach a verdict, so the user's
        // existing sync preference is preserved while they re-authenticate.
        // The button reuses `onSignIn`, the same handler wired for the
        // `auth-error` state below.
        <div className="flex items-start gap-2">
          <p className="text-xs text-muted-foreground flex-1 min-w-0">
            <Trans>Your GitHub session expired — sign in again to verify push access.</Trans>
          </p>
          {onSignIn && (
            <Button variant="outline" size="xs" className="self-start" onClick={onSignIn}>
              <Trans>Sign in</Trans>
            </Button>
          )}
        </div>
      ) : null}

      {status.state === 'conflict' && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          <Trans>Sync paused — resolve conflicts to resume.</Trans>
        </p>
      )}

      <div className="text-xs text-muted-foreground space-y-2">
        {status.remote && (
          <div className="flex items-baseline gap-2">
            <span className="w-20 shrink-0 font-mono uppercase tracking-wide text-2xs">
              <Trans>Repository</Trans>
            </span>
            {status.remote.webUrl ? (
              <a
                href={status.remote.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-0.5 text-foreground hover:text-primary hover:underline"
                aria-label={t`Open ${status.remote.label} on GitHub (opens in a new tab)`}
              >
                <span className="truncate">{status.remote.label}</span>
                <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
              </a>
            ) : (
              <span className="min-w-0 truncate text-foreground">{status.remote.label}</span>
            )}
          </div>
        )}
        {enabled && status.state !== 'dormant' && (
          <div className="flex items-baseline gap-2">
            <span className="w-20 shrink-0 font-mono uppercase tracking-wide text-2xs">
              <Trans>Last sync</Trans>
            </span>
            <span className="text-foreground">{lastSyncedRelative}</span>
          </div>
        )}
        {status.ahead > 0 && (
          <div>
            <Plural value={ahead} one="# commit ahead" other="# commits ahead" />
          </div>
        )}
        {status.behind > 0 && (
          <div>
            <Plural value={behind} one="# commit behind" other="# commits behind" />
          </div>
        )}
        {status.conflictCount > 0 && (
          <div>
            <Plural value={conflictCount} one="# file conflicted" other="# files conflicted" />
          </div>
        )}
        {!enabled && (
          <div>
            <Trans>Sync is off — your edits will not sync to the remote repository.</Trans>
          </div>
        )}
      </div>

      {status.identityUnresolved && onSetIdentity && (
        <div className="flex items-start gap-2 rounded-md border border-dashed p-2">
          <UserCog className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex flex-col gap-1.5 min-w-0">
            <p className="text-xs text-muted-foreground leading-snug">
              <Trans>
                Git identity isn't set — commits use a default author. Set yours so teammates see
                your name.
              </Trans>
            </p>
            <Button variant="outline" size="xs" className="self-start" onClick={onSetIdentity}>
              <Trans>Set identity</Trans>
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1 pt-1">
        {enabled &&
          status.state !== 'dormant' &&
          status.state !== 'disabled' &&
          status.state !== 'auth-error' &&
          status.state !== 'conflict' && (
            <Button variant="outline" size="xs" onClick={triggerSyncFromBadge}>
              <Trans>Sync now</Trans>
            </Button>
          )}
        {enabled && status.state === 'auth-error' && (
          <Button variant="outline" size="xs" onClick={onSignIn}>
            <Trans>Connect GitHub</Trans>
          </Button>
        )}
        {enabled && status.state === 'offline' && (
          <Button variant="outline" size="xs" onClick={triggerSyncFromBadge}>
            <Trans>Retry</Trans>
          </Button>
        )}
        {enabled && status.state === 'conflict' && firstConflict && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              if (typeof window === 'undefined') return;
              const nextHash = hashFromDocName(filePathToDocName(firstConflict.file));
              if (window.location.hash !== nextHash) {
                window.location.hash = nextHash;
              }
            }}
          >
            <Trans>Review conflicts</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}

// ── public component ──────────────────────────────────────────────────────────

interface SyncStatusBadgeProps {
  /** Called when "Connect GitHub" is clicked in the auth-error popover or enable-sync prompt. */
  onSignIn?: () => void;
  /** Called when "Set identity" is clicked in the identity-unresolved nudge. */
  onSetIdentity?: () => void;
}

export function SyncStatusBadge({ onSignIn, onSetIdentity }: SyncStatusBadgeProps = {}) {
  const { t } = useLingui();
  const { status, fetchError } = useGitSyncStatusDetailed();

  // Surface a lightweight connectivity warning when the server has been
  // reachable before (we have a prior status) but the last refresh failed.
  // Before first successful fetch we stay hidden so the badge doesn't flash
  // on every reload.
  if (!status) {
    if (fetchError) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Sync status unavailable`}
              disabled
            >
              <CloudOff className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {fetchError === 'network' ? (
              <Trans>Sync status unavailable — server unreachable.</Trans>
            ) : (
              <Trans>Sync status unavailable — server error.</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      );
    }
    return null;
  }

  // Hide when dormant with no remote (truly no git remote)
  if (status.state === 'dormant' && !status.hasRemote) return null;

  // Hide when sync is explicitly disabled by the user — they opted out, so
  // there's nothing actionable to surface in the header. Re-enabling goes
  // through Settings → Sync, which gates with a confirmation dialog. Keep
  // the badge visible when an auto-disable carries a `pausedReason` (e.g.
  // protected-branch) so the user can see *why* sync stopped — without it,
  // the only signal would be a missing badge. Manual disable clears
  // `pausedReason`; auto-disable sets it. (Unsafe states like auth-error /
  // conflict / offline already render — they need attention.)
  if (status.state === 'disabled' && !status.pausedReason) return null;

  const label = badgeLabel(status);
  const syncStateLabel = stateLabel(status.state);
  const showIdentityDot = Boolean(status.identityUnresolved);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground relative"
              aria-label={
                showIdentityDot
                  ? t`Sync status: ${syncStateLabel} — git identity unset`
                  : t`Sync status: ${syncStateLabel}`
              }
            >
              <BadgeIcon status={status} />
              {label && (
                <span className="absolute -top-0.5 -right-0.5 text-[9px] leading-none font-medium bg-background border rounded-full px-0.5">
                  {label}
                </span>
              )}
              {!label && showIdentityDot && (
                <span
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-500 ring-2 ring-background"
                  aria-hidden
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipLabel(status)}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-3">
        <PopoverBody status={status} onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
      </PopoverContent>
    </Popover>
  );
}
