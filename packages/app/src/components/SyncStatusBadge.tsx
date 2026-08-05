/**
 * SyncStatusBadge — displays the git sync engine state in the editor header.
 *
 * States: dormant (hidden) | idle/synced | fetching/pulling/pushing (syncing) |
 * conflict | offline | auth-error | disabled | available (sync off, remote present)
 *
 * Click opens a popover with last-sync details and action buttons.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  isSyncActiveMode,
  isSyncPaused,
  type PushPermissionWire,
  resolveLocalAutoSyncMode,
  type SyncErrorCode,
  type SyncMode,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangle,
  ArrowUpRight,
  Cloud,
  CloudOff,
  LogIn,
  Pause,
  RefreshCw,
  UserCog,
} from 'lucide-react';
import { useConflicts } from '@/hooks/use-conflicts';
import { useBadgeSyncControls } from '@/hooks/use-enable-sync-with-confirm';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import { triggerSync } from '@/lib/trigger-sync';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget manual sync from a badge button. The badge's own status
 * stream drives the visible state, so a rejected trigger (offline / server
 * down) needs no UI handling — but it gets a breadcrumb rather than being
 * swallowed silently, so a "Sync now did nothing" report is triageable.
 *
 * A following (pull-only) project uses the `pull` op so the trigger runs the
 * one-directional cycle; full sync uses `sync` (fetch + merge + push).
 */
function triggerSyncFromBadge(op: 'sync' | 'pull' = 'sync'): void {
  triggerSync(op).catch((err) => {
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

// ── mode-aware state derivation ───────────────────────────────────────────────

/** True when the project follows upstream one-directionally (pull-only). */
function isFollowingMode(status: GitSyncStatus): boolean {
  return status.syncMode === 'follow';
}

/**
 * The state the badge renders. A pull-only engine deliberately holds `idle`
 * while a same-line collision waits in the conflict ledger — that keeps the rest
 * of the repo fast-forwarding, but a following project must still surface the
 * collision, so promote it to `conflict` on the badge. Full sync sets the
 * `conflict` state directly, so this never changes what it renders.
 */
export function displayState(status: GitSyncStatus): GitSyncStatus['state'] {
  if (isFollowingMode(status) && status.state === 'idle' && status.conflictCount > 0) {
    return 'conflict';
  }
  return status.state;
}

// ── inner: icon + color per state ────────────────────────────────────────────

interface BadgeIconProps {
  status: GitSyncStatus;
  /** True when the user paused a previously-enabled project (config-driven). */
  paused?: boolean;
}

function BadgeIcon({ status, paused }: BadgeIconProps) {
  const cls = 'size-3.5';
  // Paused is a config state the engine's `state` can't express (it reads as
  // disabled/dormant), so it wins the icon.
  if (paused) return <Pause className={`${cls} text-muted-foreground`} />;
  switch (displayState(status)) {
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
  switch (displayState(status)) {
    case 'idle':
      // A following project never pushes, so "ahead" is not an actionable
      // signal — only surface how far behind upstream the copy is.
      if (!isFollowingMode(status) && status.ahead > 0) return `↑${status.ahead}`;
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

function stateLabel(state: GitSyncStatus['state'], following = false): string {
  switch (state) {
    case 'dormant':
      return t`No git remote`;
    case 'idle':
      // A following project tracks upstream one-directionally, so "Synced"
      // (which implies a two-way exchange) would overstate what happened.
      return following ? t`Up to date` : t`Synced`;
    case 'fetching':
      return following ? t`Checking for updates` : t`Fetching`;
    case 'pulling':
      return following ? t`Updating` : t`Pulling`;
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
    case 'diverged-local-commits':
      // Pull-only reaches this when local commits sit ahead of origin: it never
      // pushes or merges to reconcile them, so updates stall until they're gone.
      return t`Local commits are keeping this copy from updating`;
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
  reason:
    | 'no-collaborator'
    | 'private-no-access'
    | 'repo-not-found'
    | 'not-authenticated'
    | undefined,
): string {
  switch (reason) {
    case 'not-authenticated':
      return t`You're signed out — sign in to resume syncing.`;
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
 * Whether the push-permission denial is a *signed-out* one (no credential
 * resolved), which a reconnect fixes — as opposed to a genuine read-only
 * collaborator, where re-auth won't help. Drives the "Connect" affordance on
 * the otherwise button-less denied surfaces.
 */
export function shouldOfferReconnect(pushPermission: PushPermissionWire | undefined): boolean {
  return (
    pushPermission?.checkStatus === 'denied' && pushPermission.deniedReason === 'not-authenticated'
  );
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
  currentMode?: SyncMode,
): boolean {
  if (!projectLocalSynced) return true;
  // A following (pull-only) project never pushes, so a denied push probe is
  // irrelevant to it — the toggle (whose only action is turning sync off) stays
  // enabled. A denied probe still disables an off/full project, where enabling
  // reaches the push-requiring full mode.
  if (currentMode === 'follow') return false;
  if (pushPermissionCheckStatus === 'denied') return true;
  return false;
}

export function tooltipLabel(status: GitSyncStatus, paused = false): string {
  if (paused) return t`Sync paused`;
  const following = isFollowingMode(status);
  // A following project is always on, so it never reads as "Sync off" — that
  // label is reserved for a genuinely disabled (mode off) project.
  if (!status.syncEnabled && !following) return t`Sync off`;
  const state = displayState(status);
  if (state === 'conflict' && status.conflictCount > 0) {
    const { conflictCount } = status;
    return plural(conflictCount, { one: '# conflict', other: '# conflicts' });
  }
  if (state === 'idle') {
    const { ahead, behind } = status;
    if (following) {
      // "ahead" is not actionable for a project that never pushes; only how far
      // behind upstream it is (before a pull completes) is worth surfacing.
      if (behind > 0) return t`${behind} behind`;
      return t`Up to date`;
    }
    if (ahead > 0 && behind > 0) {
      return t`${ahead} ahead, ${behind} behind`;
    }
    if (ahead > 0) return t`${ahead} ahead`;
    if (behind > 0) return t`${behind} behind`;
    return t`Synced`;
  }
  return stateLabel(state, following);
}

interface PopoverBodyProps {
  status: GitSyncStatus;
  onSignIn?: () => void;
  onSetIdentity?: () => void;
}

function PopoverBody({ status, onSignIn, onSetIdentity }: PopoverBodyProps) {
  const { t } = useLingui();
  const { behind, conflictCount } = status;
  const { projectLocalConfig, projectLocalSynced } = useConfigContext();
  const autoSync = projectLocalConfig?.autoSync;
  const {
    active,
    paused,
    everEnabled,
    toggleMode,
    confirmOpen,
    setConfirmOpen,
    pendingMode,
    strandedCommitCount,
    onToggleActive,
    onModeSelect,
    onConfirm,
  } = useBadgeSyncControls(autoSync, status.ahead);
  const localMode = resolveLocalAutoSyncMode(autoSync) ?? 'off';
  // `following` (status-driven) is the ACTIVE pull state; the paused branch is
  // config-driven since the engine reports a paused project as disabled.
  const following = isFollowingMode(status);
  const state = displayState(status);
  const lastSyncedRelative = formatRelative(status.lastSyncUtc);
  // The Full/Follow control appears only for a user who can actually choose —
  // a genuine read-only collaborator can only follow, so it's hidden for them
  // (a signed-out user may gain push after auth, so they keep it).
  const genuineReadOnly =
    status.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated';
  const canChooseMode = !genuineReadOnly;
  // The "Review conflicts" affordance navigates to the first conflicted file
  // (so the editor-area DiffViewBoundary mounts via the lifecycle observer).
  const { conflicts } = useConflicts();
  const firstConflict = conflicts[0] ?? null;

  const showConflictButton = !paused && state === 'conflict' && firstConflict !== null;
  const showAuthButton = !paused && state === 'auth-error';
  const showSyncButton =
    everEnabled && !showConflictButton && !showAuthButton && (paused || state !== 'dormant');
  // A manual sync from a full-active project pushes too; every other case
  // (following, or paused) pulls only.
  const manualSyncOp: 'sync' | 'pull' = active && localMode === 'full' ? 'sync' : 'pull';

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <BadgeIcon status={status} paused={paused} />
          <span className="text-1sm font-medium truncate">
            {paused ? t`Sync paused` : stateLabel(state, following)}
          </span>
        </div>
        <Switch
          checked={active}
          disabled={!projectLocalSynced}
          onCheckedChange={onToggleActive}
          aria-label={active ? t`Pause sync` : t`Resume sync`}
        />
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
        variant={pendingMode ?? 'full'}
        strandedCommitCount={strandedCommitCount}
      />

      {paused ? (
        <p className="text-xs text-muted-foreground" data-testid="sync-popover-paused-line">
          <Trans>Sync is paused. Turn it back on to resume.</Trans>
        </p>
      ) : (
        <>
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
          {!following && shouldOfferReconnect(status.pushPermission) ? (
            // Signed-out denial (no credential resolved) — reconnecting resumes
            // sync, so offer it here. Takes precedence over the button-less
            // `pausedReason`/`denied` branches below.
            <div className="flex items-start gap-2">
              <p className="text-xs text-muted-foreground flex-1 min-w-0">
                <Trans>You're signed out — sign in to resume syncing.</Trans>
              </p>
              {onSignIn && (
                <Button variant="outline" size="xs" className="self-start" onClick={onSignIn}>
                  <Trans>Sign in</Trans>
                </Button>
              )}
            </div>
          ) : status.pausedReason ? (
            <p className="text-xs text-muted-foreground">
              {formatPausedReason(status.pausedReason)}
            </p>
          ) : following ? (
            // A follower never pushes, so the push-permission verdict is
            // irrelevant — say what the project IS (the mode).
            <p className="text-xs text-muted-foreground" data-testid="sync-popover-mode-line">
              <Trans>
                Follow — updates flow in from your remote; your edits stay on this computer.
              </Trans>
            </p>
          ) : active ? (
            <p className="text-xs text-muted-foreground" data-testid="sync-popover-mode-line">
              <Trans>
                Full sync — your edits are committed and pushed to your remote automatically.
              </Trans>
            </p>
          ) : status.pushPermission?.checkStatus === 'denied' ? (
            <p className="text-xs text-muted-foreground">
              {formatPushPermissionDenied(status.pushPermission.deniedReason)}
            </p>
          ) : shouldOfferSignInAgain(status.pushPermission) ? (
            // Probe-401 branch: surface a "Sign in again" affordance without
            // disabling sync — the probe couldn't reach a verdict.
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
        </>
      )}

      {!paused && state === 'conflict' && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {following ? (
            // A follower keeps fast-forwarding the rest of the repo while a single
            // document waits on resolution, so it is never globally "paused".
            <Trans>A document has a conflict — resolve it to keep it up to date.</Trans>
          ) : (
            <Trans>Sync paused — resolve conflicts to resume.</Trans>
          )}
        </p>
      )}

      <div className="text-xs text-muted-foreground space-y-2 border-t pt-3">
        {status.remote && (
          <div className="flex items-baseline justify-between gap-2">
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
        {active && !following && status.behind > 0 && (
          <div>
            <Plural value={behind} one="# commit behind" other="# commits behind" />
          </div>
        )}
        {status.conflictCount > 0 && (
          <div>
            <Plural value={conflictCount} one="# file conflicted" other="# files conflicted" />
          </div>
        )}
        {canChooseMode && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="w-20 shrink-0 font-mono uppercase tracking-wide text-2xs">
              <Trans>Mode</Trans>
            </span>
            <ToggleGroup
              type="single"
              variant="segmented"
              size="sm"
              spacing={1}
              className="bg-muted p-0.5 data-[size=sm]:rounded-[10px]"
              value={toggleMode}
              onValueChange={(v) => {
                // Radix emits '' on re-press (deselect) — keep exactly one mode.
                if (isSyncActiveMode(v)) onModeSelect(v);
              }}
              aria-label={t`Sync mode`}
              data-testid="sync-popover-mode-toggle"
            >
              <ToggleGroupItem value="full" data-testid="sync-popover-mode-full">
                <Trans>Full</Trans>
              </ToggleGroupItem>
              <ToggleGroupItem value="follow" data-testid="sync-popover-mode-follow">
                <Trans>Follow</Trans>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
      </div>

      {!paused && status.identityUnresolved && onSetIdentity && (
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

      {(showSyncButton ||
        showAuthButton ||
        showConflictButton ||
        (active && state !== 'dormant')) && (
        <div className="flex items-center justify-between gap-2 pt-1">
          {active && state !== 'dormant' ? (
            // A follower pulls only, so "Synced" (two-way) would overstate it —
            // it reads "Updated"; full sync reads "Synced".
            <span className="text-xs text-muted-foreground" data-testid="sync-popover-last-sync">
              {following ? t`Updated ${lastSyncedRelative}` : t`Synced ${lastSyncedRelative}`}
            </span>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap justify-end gap-1">
            {showSyncButton && (
              // One label for every mode ("Sync"); the op pushes only when full
              // and active, and pulls otherwise (following, or a paused one-shot).
              <Button
                variant="outline"
                size="xs"
                onClick={() => triggerSyncFromBadge(manualSyncOp)}
              >
                <Trans>Sync</Trans>
              </Button>
            )}
            {showAuthButton && (
              <Button variant="outline" size="xs" onClick={onSignIn}>
                <Trans>Sign in</Trans>
              </Button>
            )}
            {showConflictButton && firstConflict && (
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
      )}
    </div>
  );
}

// ── public component ──────────────────────────────────────────────────────────

interface SyncStatusBadgeProps {
  /** Called when "Sign in" is clicked in the auth-error popover or enable-sync prompt. */
  onSignIn?: () => void;
  /** Called when "Set identity" is clicked in the identity-unresolved nudge. */
  onSetIdentity?: () => void;
}

export function SyncStatusBadge({ onSignIn, onSetIdentity }: SyncStatusBadgeProps = {}) {
  const { t } = useLingui();
  const { status, fetchError } = useGitSyncStatusDetailed();
  const { projectLocalConfig } = useConfigContext();
  // Paused = the user turned off a previously-enabled project. It's config-only
  // (the engine reports it as disabled/dormant), so the badge reads it here to
  // stay visible and render the paused icon/label.
  const paused = isSyncPaused(projectLocalConfig?.autoSync);
  // The local config is the source of truth for user intent; the server status
  // lags a resume by a beat. When the config already resolves to an active mode
  // (follow/full) but the engine still reports the pre-resume `disabled`, keep
  // the badge visible so the resume doesn't unmount it — unmounting closes the
  // popover and flickers the icon until the status catches up.
  const localWantsSync = isSyncActiveMode(resolveLocalAutoSyncMode(projectLocalConfig?.autoSync));

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
  // conflict / offline already render — they need attention.) A following
  // (pull-only) project is always on, so it must always show its state.
  // A paused project (config: was enabled, now off) stays visible so the user
  // isn't stranded in Settings to resume — the engine reports it as disabled.
  if (
    status.state === 'disabled' &&
    !status.pausedReason &&
    status.syncMode !== 'follow' &&
    !paused &&
    !localWantsSync
  ) {
    return null;
  }

  const label = paused ? '' : badgeLabel(status);
  const syncStateLabel = paused
    ? t`Sync paused`
    : stateLabel(displayState(status), isFollowingMode(status));
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
              <BadgeIcon status={status} paused={paused} />
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
        <TooltipContent>{tooltipLabel(status, paused)}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <PopoverBody status={status} onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
      </PopoverContent>
    </Popover>
  );
}
