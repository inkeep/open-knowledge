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
  type GitStatusCode,
  type GitWorktreeEntry,
  type GitWorktreeOpenTarget,
  isSyncMode,
  type PushPermissionWire,
  type SyncErrorCode,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  Cloud,
  CloudAlert,
  CloudOff,
  LogIn,
  RefreshCw,
  Settings2,
  UserCog,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { useConflicts } from '@/hooks/use-conflicts';
import { useBadgeSyncControls } from '@/hooks/use-enable-sync-with-confirm';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import type { GitWorktreeStatus } from '@/hooks/use-git-worktree-status';
import { useGitWorktreeStatus } from '@/hooks/use-git-worktree-status';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName, hashFromAssetPath, hashFromDocName, isSameHash } from '@/lib/doc-hash';
import { triggerSync } from '@/lib/trigger-sync';
import { openSyncSettings } from '@/lib/use-settings-route';
import { EnableSyncConfirmDialog } from './EnableSyncConfirmDialog';
import { SyncBlockingChanges } from './SyncBlockingChanges';
import {
  groupWorktreeEntries,
  MAX_ROWS_PER_GROUP,
  type WorktreeFolderGroup,
  type WorktreeRowModel,
} from './sync-worktree-grouping.ts';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// ── helpers ──────────────────────────────────────────────────────────────────

type ManualSyncOp = 'sync' | 'push' | 'pull';

/**
 * Fire-and-forget manual sync from a badge button. The badge's own status
 * stream drives the visible state, so a rejected trigger (offline / server
 * down) needs no UI handling — but it gets a breadcrumb rather than being
 * swallowed silently, so a "Sync now did nothing" report is triageable.
 *
 * A following (pull-only) project uses the `pull` op so the trigger runs the
 * one-directional cycle; full sync uses `sync` (fetch + merge + push).
 */
function triggerSyncFromBadge(op: ManualSyncOp = 'sync', onFailure?: () => void): void {
  triggerSync(op).catch((err) => {
    console.warn(
      '[sync-badge] manual sync trigger failed',
      err instanceof Error ? err.message : err,
    );
    onFailure?.();
  });
}

/**
 * Point the editor at a hash route. Shared by the conflict Review button and
 * the working-tree rows so both spell navigation the same way; the same-hash
 * guard keeps a re-click from pushing a duplicate history entry.
 */
function navigateToHash(nextHash: string): void {
  if (typeof window === 'undefined') return;
  if (!isSameHash(window.location.hash, nextHash)) {
    window.location.hash = nextHash;
  }
}

/**
 * The hash for a row's open target. `doc` and `asset` are the same two routes
 * the Files sidebar navigates to, so a row opens what the tree would — down to
 * the asset viewer's fallback pane for a file it has no renderer for.
 */
function hashForOpenTarget(target: GitWorktreeOpenTarget): string {
  return target.kind === 'doc' ? hashFromDocName(target.docName) : hashFromAssetPath(target.path);
}

/**
 * Compact relative time for the popover footer, where two stamps share a row
 * with the settings link inside a 320px popover — "4 min ago" twice overflows
 * and wraps. Reuses the same `{minutes}m ago` / `{hours}h ago` vocabulary the
 * activity panel and thread history already use, so the abbreviation is not
 * novel to this surface.
 */
function formatRelativeCompact(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t`just now`;
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    return t`${minutes}m ago`;
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
 * The state the badge renders. The unified B1 pull deliberately holds the
 * engine `idle` while a same-line collision waits in the conflict ledger —
 * that keeps the rest of the repo fast-forwarding in EVERY mode — but the
 * collision must still surface, so promote idle-with-conflicts to `conflict`
 * on the badge regardless of mode.
 */
export function displayState(status: GitSyncStatus): GitSyncStatus['state'] {
  if (status.state === 'idle' && status.conflictCount > 0) {
    return 'conflict';
  }
  return status.state;
}

// ── inner: icon + color per state ────────────────────────────────────────────

interface BadgeIconProps {
  status: GitSyncStatus;
}

function BadgeIcon({ status }: BadgeIconProps) {
  const cls = 'size-3.5';
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
      return (
        <Spinner aria-hidden="true" icon={RefreshCw} className={`${cls} text-muted-foreground`} />
      );
    case 'conflict':
      return <AlertTriangle className={`${cls} text-amber-500`} />;
    case 'offline':
      return <CloudOff className={`${cls} text-muted-foreground`} />;
    case 'auth-error':
      // The not-found masquerade withdraws the sign-in affordance, so the
      // sign-in glyph would prescribe exactly what the popover withholds.
      // CloudAlert (not AlertTriangle, which already means conflict/disabled
      // in amber): the collapsed badge is icon-only for this state, so the
      // glyph shape — not hue alone — has to distinguish it for users who
      // can't tell amber from red.
      return hasNotFoundAsIdentityError(status) ? (
        <CloudAlert className={`${cls} text-destructive`} />
      ) : (
        <LogIn className={`${cls} text-destructive`} />
      );
    case 'disabled':
      // The engine reports `disabled` whenever no automation is scheduled —
      // which is the NORMAL resting state of Manual mode, not a fault. Only an
      // auto-disable (protected branch, lost push access) carries a
      // `pausedReason`, and only that earns a warning glyph.
      if (status.pausedReason) return <AlertTriangle className={`${cls} text-amber-500`} />;
      if (status.ahead > 0 || status.behind > 0) {
        return <RefreshCw className={`${cls} text-muted-foreground`} />;
      }
      return <Cloud className={`${cls} text-muted-foreground`} />;
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

function stateLabel(status: GitSyncStatus): string {
  const following = isFollowingMode(status);
  const state = displayState(status);
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
      // Manual is a resting mode the user chose, not a disabled product.
      // "Sync disabled" reads as a fault and, next to a warning triangle, as a
      // problem the user has to go fix.
      return status.pausedReason ? t`Sync paused` : t`Manual`;
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
      return t`You don't have permission to push to this repo.`;
    default:
      return reason;
  }
}

/** Identity fields the wire's denied push-permission variant may carry. */
type PushPermissionDeniedIdentity = Pick<
  Extract<PushPermissionWire, { checkStatus: 'denied' }>,
  'resolvedLogin' | 'declaredLogin' | 'declaredSource'
>;

/**
 * Format the cause-specific message for a `denied` push-permission probe.
 * Used when the user has not enabled sync yet (so `pausedReason` is unset)
 * but the probe says they can't push — they should see the same actionable
 * copy as a user whose engine paused after enabling sync.
 *
 * When the wire names the identity that was actually authenticated
 * (`resolvedLogin`, always the post-fallback login), the denial copy ends
 * with it so the user can spot an account mismatch themselves — for every
 * denial reason that authenticated at all, since a read-only collaborator
 * verdict is exactly as account-dependent as a private-repo 404. When it is
 * absent the sentence is omitted — the message degrades, it never guesses.
 */
/**
 * Format the cause-specific message for a `denied` push-permission probe.
 * Used when the user has not enabled sync yet (so `pausedReason` is unset)
 * but the probe says they can't push — they should see the same actionable
 * copy as a user whose engine paused after enabling sync.
 *
 * When the wire names the identity that was actually authenticated
 * (`resolvedLogin`, always the post-fallback login), the denial copy ends
 * with it so the user can spot an account mismatch themselves — for every
 * denial reason that authenticated at all, since a read-only collaborator
 * verdict is exactly as account-dependent as a private-repo 404. When it is
 * absent the sentence is omitted — the message degrades, it never guesses.
 */
export function formatPushPermissionDenied(
  reason:
    | 'no-collaborator'
    | 'private-no-access'
    | 'repo-not-found'
    | 'not-authenticated'
    | undefined,
  identity?: PushPermissionDeniedIdentity,
): string[] {
  const sentences: string[] = [];
  switch (reason) {
    case 'not-authenticated':
      sentences.push(t`You're signed out — sign in to resume syncing.`);
      break;
    case 'no-collaborator':
      sentences.push(t`You don't have permission to push to this repo.`);
      break;
    case 'private-no-access':
      sentences.push(
        t`You don't have access to this private repo. Sign in with an account that does.`,
      );
      break;
    case 'repo-not-found':
      sentences.push(t`Repository not found. It may have been renamed, deleted, or moved.`);
      break;
    default:
      sentences.push(t`You don't have permission to push to this repo.`);
  }
  sentences.push(...formatDeniedIdentitySentences(identity));
  // Returned as sentences, rendered one per line: a hard-coded joiner would
  // put a Latin space after the CJK full stop in zh catalogs, and separate
  // lines keep three distinct facts scannable in the narrow popover.
  return sentences;
}

/**
 * Only the identity tail of a denial — the `Authenticated as …` and
 * declared-miss sentences, without the leading reason sentence. The parked
 * not-found popover renders this: its error line already carries the full
 * not-found copy, and every reason sentence either re-prescribes the sign-in
 * that state withholds (`private-no-access`) or asserts more than the 404
 * proves, so only the identity facts may ride along there.
 */
export function formatDeniedIdentitySentences(identity?: PushPermissionDeniedIdentity): string[] {
  const sentences: string[] = [];
  if (identity?.resolvedLogin) {
    const login = identity.resolvedLogin;
    sentences.push(t`Authenticated as ${login}.`);
  }
  if (identity?.declaredLogin) {
    sentences.push(formatDeclaredAccountMiss(identity.declaredLogin, identity.declaredSource));
  }
  return sentences;
}

/**
 * Name the account the user declared but the credential resolution could not
 * use, and the mechanism they declared it through. The copy asserts only the
 * miss itself — it does not name a cause (the wire does not say whether the
 * GitHub CLI was consulted, absent, or outdated, and a desktop install with
 * no gh at all reaches this path too) and it does not name the substitute
 * account (the `Authenticated as` sentence carries that when known).
 * `declaredSource` is an open string on the wire: a payload from a server
 * with a newer declaration mechanism must degrade to the generic wording,
 * never fail or guess.
 *
 * Deliberately says more than its CLI twin (`formatDeclaredMissWarning`):
 * this path reaches the wire only after the server resolved the answering
 * account, so it can contrast the two identities; the clone path has no such
 * lookup and asserts only that the request went unconfirmed. Don't collapse
 * one into the other.
 */
function formatDeclaredAccountMiss(declaredLogin: string, declaredSource: string | undefined) {
  switch (declaredSource) {
    case 'remote-url':
      return t`Your remote URL names ${declaredLogin}, but that account's credentials couldn't be used.`;
    case 'credential-config':
      return t`Your Git credential configuration names ${declaredLogin}, but that account's credentials couldn't be used.`;
    default:
      return t`Your Git configuration names ${declaredLogin}, but that account's credentials couldn't be used.`;
  }
}

/**
 * Whether the current sync error is the repository-not-found masquerade:
 * git's "repository not found" with a credential attached, where GitHub
 * deliberately hides "private + no access" behind the same answer as
 * "doesn't exist". The engine parks it as an auth error (sync genuinely
 * cannot proceed), but unlike every other auth subclass a re-sign-in is not
 * the prescribed fix — so the badge suppresses the reconnect affordance and
 * header for it and lets the error line carry the full copy.
 */
export function hasNotFoundAsIdentityError(
  status: Pick<GitSyncStatus, 'pushErrorCode' | 'pullErrorCode'>,
): boolean {
  return (
    status.pushErrorCode === 'auth-not-found-as-identity' ||
    status.pullErrorCode === 'auth-not-found-as-identity'
  );
}

/**
 * Whether the engine is parked on the repository-not-found masquerade — the
 * state where the Sign in affordance is withheld because re-auth cannot fix
 * it. Keyed on `pausedReason` rather than `state`: the engine refuses to let
 * a probe denial overwrite this park, so the reason survives even when a
 * later failure moves `state` (the retryable arm transitions to 'offline'
 * without clearing the reason).
 *
 * Shared by the badge and Settings so the two surfaces cannot describe one
 * status object differently — the defect class that made the composed
 * identity copy unreachable during this feature's development.
 */
export function isParkedOnNotFoundAsIdentity(
  status:
    | Pick<GitSyncStatus, 'pausedReason' | 'pushErrorCode' | 'pullErrorCode'>
    | null
    | undefined,
): boolean {
  return status?.pausedReason === 'auth-error' && hasNotFoundAsIdentityError(status);
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
    case 'auth-not-found-as-identity':
      return t`Repository not found — it may not exist, or the account used may not have access.`;
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
    case 'auth-not-found-as-identity':
      return t`Repository not found — it may not exist, or the account used may not have access.`;
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
    case 'auth-not-found-as-identity':
      return t`Repository not found — it may not exist, or the account used may not have access.`;
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
 * Only the affordance surfaces — the mode selector stays fully usable. The
 * probe couldn't reach a verdict, so the user's existing sync preference is
 * preserved while they re-authenticate.
 */
export function shouldOfferSignInAgain(pushPermission: PushPermissionWire | undefined): boolean {
  return (
    pushPermission?.checkStatus === 'unknown' && pushPermission.unknownError === 'token-invalid'
  );
}

/**
 * One home for the state → label rule every plain-state surface reads (the
 * tooltip tail and the trigger's accessible name), so the not-found masquerade
 * cannot read "Repository not found" on one surface while another still
 * prescribes the reconnect it withdrew.
 *
 * `stateLabel` alone answers `auth-error` with "Reconnect required", which is
 * the wrong prescription for a repository the account simply cannot see.
 */
function syncStateLabelFor(status: GitSyncStatus): string {
  if (displayState(status) === 'auth-error' && hasNotFoundAsIdentityError(status)) {
    return t`Repository not found`;
  }
  return stateLabel(status);
}

export function tooltipLabel(status: GitSyncStatus): string {
  const following = isFollowingMode(status);
  // `syncEnabled: false` is Manual — a resting mode, not an off switch. It
  // still reports ahead/behind, so fall through to the state labels rather
  // than short-circuiting on a "Sync off" that no longer exists.
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
  return syncStateLabelFor(status);
}

interface PopoverBodyProps {
  status: GitSyncStatus;
  onSignIn?: () => void;
  onSetIdentity?: () => void;
}

/** Section heading — the small uppercase rule the popover groups controls under. */
function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <span id={id} className="font-mono uppercase tracking-wide text-2xs text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Short, human label for a porcelain status letter. Total over the bounded wire
 * enum so a letter can never render as a bare glyph with no meaning.
 */
function statusCodeLabel(code: GitStatusCode): string {
  switch (code) {
    case 'M':
      return t`Modified`;
    case 'A':
      return t`Added`;
    case 'D':
      return t`Deleted`;
    case 'R':
      return t`Renamed`;
    case 'C':
      return t`Copied`;
    case 'U':
      return t`Unmerged`;
    case 'T':
      return t`Type changed`;
    case '?':
      return t`Untracked`;
    case '!':
      return t`Ignored`;
    default:
      return t`Changed`;
  }
}

/**
 * Badge variant for a status letter.
 *
 * Only the two letters that carry a real warning get a tinted variant; every
 * other code renders neutral. Git itself colors by GROUP (staged vs not), not
 * by letter, and the group headings already carry that — tinting all seven
 * letters would invent a taxonomy the user has to learn to read a listing.
 */
function statusCodeVariant(code: GitStatusCode): 'gray' | 'warning' | 'destructive' {
  switch (code) {
    case 'D':
      return 'destructive';
    case 'U':
      return 'warning';
    default:
      return 'gray';
  }
}

/**
 * One changed path: its porcelain letter and the path itself.
 *
 * The path becomes a button when the server resolved an open target for it —
 * a document, or the asset viewer for everything else the sidebar would show.
 * The rows that stay plain text are the ones that would open on nothing: a
 * deletion, an incoming file that has not landed yet, a path outside the
 * content dir, and the floors the sidebar hides too. The button's accessible
 * name is set to the full `entry.path` via `aria-label`, because the display
 * label is relative to the enclosing folder group and would collide with
 * sibling groups that hold files of the same name.
 */
function WorktreeRow({
  entry,
  dimmed,
  label,
}: {
  entry: GitWorktreeEntry;
  dimmed: boolean;
  /** Path relative to the enclosing folder group; the header carries the rest. */
  label: string;
}) {
  // No locale subscription here, deliberately. `statusCodeLabel` reads the
  // module `t`, which resolves at CALL time, so on a locale switch these
  // tooltips render in the old language until something re-renders the row.
  // That window is bounded to WORKTREE_POLL_MS (5s) — the poll in
  // `useGitWorktreeStatus` calls `setStatus` with a fresh object each tick —
  // which is not worth the two ways of closing it here: the macro `useLingui`
  // must appear in a variable declaration (a bare call fails the macro
  // transform), and the runtime `@lingui/react` one throws outright without an
  // `I18nProvider`, which the tests for this file do not mount — they mock the
  // macro module instead.
  const codeLabel = statusCodeLabel(entry.code);
  const openTarget = entry.open;
  // `text-start` AND `dir="auto"`, and the two are load-bearing for different
  // reasons. `dir` only resolves the logical start/end keywords, so it cannot
  // counter an inherited physical alignment: the openable row nests its span in
  // a real <Button>, which the UA centers and neither Preflight nor
  // `buttonVariants` resets — that is the site the round-4 regression hit, and
  // the one `text-start` exists for. On the non-openable row the span is a
  // direct child of a flex <li> with no button in its ancestry, so `text-start`
  // is a harmless no-op there and is kept only so both spans share one class.
  // `dir="auto"` is required on both: without it a non-Latin filename would be
  // forced to render LTR.
  const pathClassName = `truncate text-start font-mono text-2xs ${dimmed ? 'text-muted-foreground/60' : 'text-foreground'}`;
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={statusCodeVariant(entry.code)}
            className="size-4 shrink-0 justify-center p-0 text-2xs leading-none"
          >
            <span aria-hidden>{entry.code}</span>
            <span className="sr-only">{codeLabel}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{codeLabel}</TooltipContent>
      </Tooltip>
      {openTarget ? (
        // Closing on navigate: the popover overlays the editor, so leaving it
        // open would hide the document the click just asked for.
        // Tooltip wraps the BUTTON, not the label span: Radix opens on the
        // trigger's focus, and Tab lands on the button — a nested span never
        // receives focus, so a keyboard-only user got no truncation recovery.
        // Safe here where it was not on the folder header: `PopoverClose` does
        // not style on `data-state`, so nothing collides.
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverClose asChild>
              <Button
                variant="link-muted"
                size="xs"
                // `shrink` undoes the Button base's `shrink-0`, and `min-w-0`
                // releases the content-width floor — a flex item honors neither
                // truncation nor its parent's width without both, at every level
                // of the nest (li → button → span). Without `shrink` the row grew
                // to the length of the path and spilled out of the popover.
                // `min-h-6` restores a clickable target: `h-auto p-0` collapsed
                // these discrete list rows to the ~14px line box, under WCAG 2.2
                // SC 2.5.8's 24px floor — and a mis-aimed click here navigates the
                // editor. Horizontal p-0 stays for the flush-left alignment.
                className="h-auto min-h-6 min-w-0 shrink justify-start overflow-hidden p-0 font-normal"
                aria-label={entry.path}
                onClick={() => navigateToHash(hashForOpenTarget(openTarget))}
                data-testid="worktree-row-open"
              >
                <span dir="auto" className={`min-w-0 ${pathClassName}`}>
                  {label}
                </span>
              </Button>
            </PopoverClose>
          </TooltipTrigger>
          <TooltipContent dir="auto" className="font-mono text-2xs">
            {entry.path}
          </TooltipContent>
        </Tooltip>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                dir="auto"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip-on-static-text pattern (see EditorFooter) — Radix opens on the trigger's focus, so a non-focusable span leaves sighted keyboard-only users no way to recover a truncated path. Sibling rows that link are buttons and already take focus, so this also stops the list silently skipping the rows whose path is their only content.
                tabIndex={0}
                className={`min-w-0 rounded-xs focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${pathClassName}`}
              >
                {label}
              </span>
            </TooltipTrigger>
            <TooltipContent dir="auto" className="font-mono text-2xs">
              {entry.path}
            </TooltipContent>
          </Tooltip>
          {/* Tooltip is pointer-only; give the full path to AT via a
              screen-reader-only fallback (same pattern as the status letter).
              Omitted when the label already IS the full path — a row in an
              ungrouped section — so the path is not announced twice. */}
          {label !== entry.path && <span className="sr-only">{entry.path}</span>}
        </>
      )}
    </li>
  );
}

/**
 * Row list, capped until asked otherwise.
 *
 * The cap keeps a freshly-opened folder short, but the overflow is a toggle:
 * reaching these rows already took a deliberate click, so a count that cannot
 * be opened just says "there is more, and no." The toggle is two-way so the
 * button stays mounted when expanded — unmounting the focused node drops
 * keyboard focus to `<body>`. The enclosing disclosure unmounts this state on
 * close, so the next open always starts capped.
 */
function WorktreeRows({ rows, dimmed }: { rows: WorktreeRowModel[]; dimmed: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const hasOverflow = rows.length > MAX_ROWS_PER_GROUP;
  const shown = showAll ? rows : rows.slice(0, MAX_ROWS_PER_GROUP);
  const overflowCount = rows.length - MAX_ROWS_PER_GROUP;
  return (
    <ul className="flex flex-col gap-1">
      {shown.map(({ entry, label }) => (
        <WorktreeRow
          key={`${entry.code}:${entry.path}`}
          entry={entry}
          dimmed={dimmed}
          label={label}
        />
      ))}
      {hasOverflow && (
        <li>
          <Button
            variant="link-muted"
            size="xs"
            aria-expanded={showAll}
            className="h-auto min-h-6 justify-start p-0 text-2xs font-normal"
            onClick={() => setShowAll((v) => !v)}
            data-testid="worktree-rows-show-all"
          >
            {showAll ? <Trans>Collapse</Trans> : <Trans>+{overflowCount} more</Trans>}
          </Button>
        </li>
      )}
    </ul>
  );
}

/**
 * One collapsible folder bucket. The directory is stated once in the header and
 * its rows carry only their remainder.
 *
 * The label is content-sized and the count is pushed out with `ms-auto`, so
 * alignment inside the row is unobservable — the same shape as the section
 * header in `WorktreeGroup`. The tooltip carries `prefix + dir`, which is more than the
 * header shows whenever the section hoisted a prefix, and equal to it when it
 * did not. It opens on focus as well as hover, because it wraps the Button
 * rather than a span nested inside it.
 */
function WorktreeFolder({
  group,
  prefix,
  dimmed,
}: {
  group: WorktreeFolderGroup;
  /** Section-wide directory this group's `dir` is stated relative to. */
  prefix: string;
  dimmed: boolean;
}) {
  // Named `fileCount` to match `WorktreeGroup`'s count and the entry the catalog
  // already had: Lingui keys the plural unit on the placeholder name, so a
  // second name mints a second translation unit for identical English.
  const fileCount = group.rows.length;
  // Controlled rather than reading `data-state` off the trigger. Radix Tooltip
  // and Collapsible both write that attribute, and an `asChild` chain spreads
  // the incoming one last — so a Tooltip wrapping the CollapsibleTrigger
  // silently overwrites `open` with the tooltip's own `closed`. Owning the flag
  // here lets the Tooltip wrap the BUTTON, which is what makes it reachable by
  // keyboard: Radix opens on the trigger's focus, and Tab lands on the button,
  // never on a span nested inside it.
  const [open, setOpen] = useState(false);
  // What a `WorktreeRow` never shows: its label is relative to `dir`, and
  // `dir` is itself relative to the hoisted prefix.
  const fullDir = prefix === '' ? group.dir : `${prefix}/${group.dir}`;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-auto min-h-6 w-full justify-start gap-1 px-0 font-normal"
            >
              <ChevronRight
                className={`size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
                aria-hidden
              />
              <span
                dir="auto"
                className="min-w-0 truncate text-start font-mono text-2xs text-muted-foreground"
              >
                {group.dir}
              </span>
              <span
                aria-hidden
                className="ms-auto shrink-0 ps-1 text-2xs text-muted-foreground tabular-nums"
              >
                {fileCount}
              </span>
              <span className="sr-only">
                <Plural value={fileCount} one="# file" other="# files" />
              </span>
            </Button>
          </CollapsibleTrigger>
        </TooltipTrigger>
        <TooltipContent dir="auto" className="font-mono text-2xs">
          {fullDir}
        </TooltipContent>
      </Tooltip>
      <CollapsibleContent className="ps-4">
        <WorktreeRows rows={group.rows} dimmed={dimmed} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A titled section of changed paths; renders nothing when empty.
 *
 * Collapsed by default, including the section the user is about to act on. The
 * popover is a status surface first: the count in the trigger is the signal, and
 * the paths are detail you open when you want them. The listing's scroll region
 * bounds the height independently, so this is a deliberate default rather than
 * a workaround for an overflowing panel.
 */
function WorktreeGroup({
  title,
  note,
  entries,
  dimmed = false,
}: {
  title: React.ReactNode;
  note?: React.ReactNode;
  entries: GitWorktreeEntry[];
  dimmed?: boolean;
}) {
  if (entries.length === 0) return null;
  const fileCount = entries.length;
  const { prefix, groups, loose } = groupWorktreeEntries(entries);
  return (
    <Collapsible className="flex flex-col gap-1">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="group h-auto min-h-6 w-full justify-start gap-1 px-0 font-normal data-[state=open]:bg-transparent"
        >
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-90"
            aria-hidden
          />
          <span className="text-2xs font-medium text-muted-foreground">{title}</span>
          <span className="ms-auto shrink-0 ps-1 text-2xs text-muted-foreground tabular-nums">
            <Plural value={fileCount} one="# file" other="# files" />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 ps-3">
        {note && <span className="text-2xs text-muted-foreground/80">{note}</span>}
        {prefix !== '' && (
          <span dir="auto" className="break-all font-mono text-2xs text-muted-foreground">
            {prefix}/
          </span>
        )}
        {groups.map((group) => (
          <WorktreeFolder
            key={prefix === '' ? group.dir : `${prefix}/${group.dir}`}
            group={group}
            prefix={prefix}
            dimmed={dimmed}
          />
        ))}
        {loose.length > 0 && <WorktreeRows rows={loose} dimmed={dimmed} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Ahead/behind pill. Rendered only when the count is non-zero.
 *
 * Plain interpolation rather than `<Plural>`: "ahead"/"behind" are adverbs with
 * no noun to inflect, so every plural category would carry the same string —
 * a plural form whose branches are identical is a translation burden that buys
 * nothing (and, for `ar`, six of them).
 */
function DivergenceChip({ direction, count }: { direction: 'ahead' | 'behind'; count: number }) {
  const { t } = useLingui();
  if (count <= 0) return null;
  return (
    <span className="flex flex-1 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
      {direction === 'behind' ? (
        <ArrowDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <ArrowUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {direction === 'behind' ? t`${count} behind` : t`${count} ahead`}
    </span>
  );
}

/**
 * Split the working-tree listing by what Push will actually do with each path.
 *
 * Deliberately NOT git's staged/unstaged/untracked split. Open Knowledge never
 * touches the real index — it stages into a throwaway `GIT_INDEX_FILE` and
 * commits the working tree directly — so under normal use "staged" is always
 * empty and "not staged" reads as "Push will skip this" when Push will in fact
 * send it. Grouping on `syncScoped` describes the button the user is about to
 * press instead of a workflow the product bypasses.
 *
 * A path dirty in BOTH columns arrives in two of the source lists; it renders
 * once, keeping the index letter (a staged add reads `A`, not the worktree `M`).
 * The dedupe and precedence rules are pinned by the rendering tests.
 */
function partitionByPushScope(worktree: GitWorktreeStatus): {
  willPush: GitWorktreeEntry[];
  wontPush: GitWorktreeEntry[];
} {
  const seen = new Set<string>();
  const willPush: GitWorktreeEntry[] = [];
  const wontPush: GitWorktreeEntry[] = [];
  for (const entry of [...worktree.staged, ...worktree.notStaged, ...worktree.untracked]) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    (entry.syncScoped ? willPush : wontPush).push(entry);
  }
  return { willPush, wontPush };
}

/**
 * The working-tree block: tracking refs, divergence, and the changed paths
 * grouped by whether Push will send them. Fed by its own endpoint rather than
 * the CC1 sync-status payload — see `use-git-worktree-status.ts` for why.
 */
function WorktreeStatusSection({
  status,
  worktree,
  loading,
}: {
  status: GitSyncStatus;
  worktree: GitWorktreeStatus | null;
  loading: boolean;
}) {
  const { willPush, wontPush } = worktree
    ? partitionByPushScope(worktree)
    : { willPush: [], wontPush: [] };
  const incoming = worktree?.incoming ?? [];
  // A failed read arrives as empty lists, byte-identical to a clean tree — so
  // the render below has to branch on this BEFORE `clean`, or it states
  // "working tree clean" about a tree it could not read.
  const unreadable = worktree !== null && worktree.readable === false;
  const clean =
    worktree !== null && willPush.length === 0 && wontPush.length === 0 && incoming.length === 0;

  return (
    <div className="flex flex-col gap-2.5 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel id="worktree-status-label">
          <Trans>Status</Trans>
        </SectionLabel>
        {worktree && (worktree.branch || worktree.detached) && (
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
            {worktree.detached ? (
              <Trans>detached HEAD</Trans>
            ) : worktree.upstream ? (
              `${worktree.branch} → ${worktree.upstream}`
            ) : (
              worktree.branch
            )}
          </span>
        )}
      </div>

      {(status.behind > 0 || status.ahead > 0) && (
        <div className="flex items-stretch gap-2">
          <DivergenceChip direction="behind" count={status.behind} />
          <DivergenceChip direction="ahead" count={status.ahead} />
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Reading working tree</Trans>
        </p>
      ) : unreadable ? (
        <p className="text-xs text-muted-foreground" data-testid="worktree-unreadable">
          <Trans>Couldn't read the working tree. Check the server logs.</Trans>
        </p>
      ) : clean ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Nothing to commit — working tree clean.</Trans>
        </p>
      ) : (
        worktree && (
          <section
            // Its own scroll region, not the popover's: the mode selector and
            // the Pull/Push buttons sit above this, and letting an expanded
            // 25-file bucket grow the whole popover pushed them off-screen —
            // the listing is context for those controls, so it is the part
            // that should give way.
            // tabIndex makes the scroll region keyboard-focusable (Chromium
            // doesn't do this automatically); overscroll-contain keeps scroll
            // from bubbling to the popover's scroll chain.
            className="flex max-h-56 flex-col gap-2.5 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — Chromium doesn't make overflow:auto divs focusable without tabIndex.
            tabIndex={0}
            // <section> carries the region role implicitly, so `aria-labelledby`
            // has a role to attach its name to; on a bare div the name is dropped.
            aria-labelledby="worktree-status-label"
            data-testid="worktree-listing"
          >
            {/* Headings name the button rather than predicting the future:
                only `full` pushes on its own, so "will be pushed" would be a
                promise the product does not keep in Manual or Follow. */}
            <WorktreeGroup title={<Trans>Pull brings in</Trans>} entries={incoming} />
            <WorktreeGroup title={<Trans>Push includes</Trans>} entries={willPush} />
            <WorktreeGroup
              title={<Trans>Push skips</Trans>}
              note={<Trans>Outside what Open Knowledge commits.</Trans>}
              entries={wontPush}
              dimmed
            />
            {worktree.truncated && (
              <p className="text-2xs text-muted-foreground">
                <Trans>Some files are not listed — the working tree has too many changes.</Trans>
              </p>
            )}
          </section>
        )
      )}
    </div>
  );
}

/**
 * Freshness line, per direction: "Pulled 2 min ago · pushed 5 min ago".
 *
 * Split because the two legs run on independent schedules and diverge — a
 * single combined stamp reported whichever finished last and could not say
 * which, so a prompt pull read as though the push had also gone out.
 *
 * Each leg renders only once it has actually happened, so a Pull-only project
 * (no scheduled push) shows one half rather than an empty "pushed never". Three
 * whole-sentence messages rather than two fragments joined at runtime: the
 * conjunction and word order are the translator's to choose.
 *
 * Relative strings are NAMED bindings — an inline call would extract as a
 * positional `{0}`, leaving translators guessing what gets substituted.
 */
function UpdatedLine({
  pulledAt,
  pushedAt,
  combinedAt,
}: {
  pulledAt: string | null;
  pushedAt: string | null;
  /**
   * Direction-blind fallback for an engine that predates the split. Naming a
   * direction here would be a guess — the combined stamp records that SOMETHING
   * ran, not which — so this keeps the older, vaguer wording instead.
   */
  combinedAt: string | null;
}) {
  const { t } = useLingui();
  const pulled = pulledAt === null ? null : formatRelativeCompact(pulledAt);
  const pushed = pushedAt === null ? null : formatRelativeCompact(pushedAt);
  const updatedRelative = combinedAt === null ? null : formatRelativeCompact(combinedAt);
  // The visual row is arrows plus bare durations; this is the sentence a screen
  // reader gets instead. Same messages either way, so a translator sees whole
  // sentences rather than fragments an icon silently completes.
  const label =
    pulled !== null && pushed !== null
      ? t`Pulled ${pulled} · pushed ${pushed}`
      : pulled !== null
        ? t`Pulled ${pulled}`
        : pushed !== null
          ? t`Pushed ${pushed}`
          : updatedRelative === null
            ? null
            : t`Updated ${updatedRelative}`;
  // An empty slot, not nothing: the footer row is `justify-between`, so
  // collapsing this to null would slide the settings link over to the left on a
  // project that has never run a cycle.
  const showArrows = pulled !== null || pushed !== null;
  if (label === null) return <span />;
  return (
    <span className="text-xs text-muted-foreground" data-testid="sync-popover-last-sync">
      {/* Only when the visual row is arrows: the fallback branch below renders
          the sentence itself, so a second copy would double it in the
          accessibility tree. */}
      {showArrows && (
        <span className="sr-only" data-testid="sync-popover-last-sync-label">
          {label}
        </span>
      )}
      {/* Arrows rather than the words: the same ↓/↑ label the Pull and Push
          buttons carry two rows up, so the mapping is already established and
          the row fits beside the settings link. */}
      {showArrows ? (
        <span aria-hidden="true" className="inline-flex items-center gap-1">
          {pulled !== null && (
            <span className="inline-flex items-center gap-0.5">
              <ArrowDown className="size-3" />
              {pulled}
            </span>
          )}
          {pulled !== null && pushed !== null && <span>·</span>}
          {pushed !== null && (
            <span className="inline-flex items-center gap-0.5">
              <ArrowUp className="size-3" />
              {pushed}
            </span>
          )}
        </span>
      ) : (
        // Version-skew fallback has no direction to point at, so it stays words.
        <span aria-hidden="true">{label}</span>
      )}
    </span>
  );
}

function PopoverBody({ status, onSignIn, onSetIdentity }: PopoverBodyProps) {
  const { t } = useLingui();
  const { conflictCount } = status;
  const { projectLocalConfig, projectLocalSynced } = useConfigContext();
  const autoSync = projectLocalConfig?.autoSync;
  const {
    mode,
    confirmOpen,
    setConfirmOpen,
    pendingMode,
    strandedCommitCount,
    onModeSelect,
    onConfirm,
  } = useBadgeSyncControls(autoSync, status.ahead);
  // The popover is only ever rendered inside an open Popover, so mounting the
  // working-tree poll unconditionally here is already scoped to "open".
  const { status: worktree, loading: worktreeLoading } = useGitWorktreeStatus(true);

  const following = mode === 'follow';
  const state = displayState(status);
  // The repository-not-found masquerade parks as auth-error but withdraws the
  // sign-in affordance — see hasNotFoundAsIdentityError.
  const notFoundAsIdentity = hasNotFoundAsIdentityError(status);
  // `lastRunUtc` advances whenever a push or pull completes, whether or not
  // content moved — that is what makes a no-op Pull stop looking like a dead
  // button. `lastSyncUtc` is the version-skew fallback: it only moves when
  // something CHANGED, which understates but never lies.
  //
  // `lastFetchUtc` is deliberately NOT in this chain. It advances on the
  // panel-open fetch, so including it would make the line read "just now" every
  // time the user opened the popover — claiming a sync that never happened.
  // Per-direction when the engine reports it; the combined stamp is the
  // version-skew fallback for an engine that predates the split.
  const pulledAt = status.lastPullOkUtc ?? null;
  const pushedAt = status.lastPushOkUtc ?? null;
  const combinedAt = status.lastRunUtc ?? status.lastSyncUtc ?? null;
  // A genuine read-only collaborator can only ever follow, so the modes that
  // push are removed from their menu entirely rather than offered and rejected.
  // A signed-out user keeps them — authenticating may grant push. The not-found
  // masquerade is excluded for a different reason: its probe also answers
  // `denied`, but that is not a collaborator verdict, and a failure that says
  // nothing about push rights must not revoke the mode control.
  const genuineReadOnly =
    status.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated' &&
    !notFoundAsIdentity;

  // Every mode gets all three manual actions. The mode selector governs what
  // the AUTOMATION does; these buttons are the user acting directly, and a
  // Follow user is still allowed to send their own work when they ask for it.
  // The one case that hides them is a collaborator who genuinely cannot push:
  // the remote would 403, so offering the button would be a lie.
  const canPush = !genuineReadOnly;
  // A cycle is mid-flight; a second trigger would be refused by the engine's
  // single-flight guard, so disable rather than queue a no-op.
  const busy = state === 'fetching' || state === 'pulling' || state === 'pushing';
  // Which manual action the user launched. `busy` is direction-blind, so a
  // single shared spinner has to be placed somewhere — and placing it on
  // Pull and Push meant a plain Pull lit up the one button that was NOT
  // running. Cleared when the cycle ends; a trigger the engine never picked up
  // (offline, server down) shows nothing, because `busy` gates the render.
  const [pendingAction, setPendingAction] = useState<ManualSyncOp | null>(null);
  useEffect(() => {
    if (!busy) setPendingAction(null);
  }, [busy]);
  // A trigger that never reached the engine leaves no cycle to end, so `busy`
  // never flips and the effect above never fires — the dead attribution then
  // sits until the NEXT cycle, which is likely an automatic one, and lights
  // whichever button the failed click named instead of the one actually
  // running. Clear it at the point of failure.
  const clearFailedAction = (op: ManualSyncOp) => {
    setPendingAction((current) => (current === op ? null : current));
  };
  // Automation-driven cycles have no click to attribute, so fall back to the
  // engine's own direction rather than claiming an action the user never took.
  const spinning: ManualSyncOp | null = !busy
    ? null
    : (pendingAction ?? (state === 'pushing' ? 'push' : 'pull'));
  const runManualSync = (op: ManualSyncOp): void => {
    setPendingAction(op);
    triggerSyncFromBadge(op, () => clearFailedAction(op));
  };
  // Pull runs WITH ledger conflicts outstanding (`conflictCount > 0`, engine
  // still idle) — the overlay cycle re-pins them against the new tip and
  // fast-forwards the rest of the repo, exactly what the pull-only schedule
  // keeps doing. Disabling Pull for those would leave a Manual project with one
  // conflicted doc unable to receive anything.
  //
  // A real MERGE_HEAD is the different case: `runOneShotPull` refuses it
  // outright, because git cannot merge into an unresolved merge. Leaving the
  // button live there made it a no-op the user got no answer from — the refusal
  // reaches the log and nothing else. Blocked rather than given a message: the
  // popover already shows the conflict and its Review affordance, so the honest
  // button needs no new sentence.
  //
  // Read off `status.state`, NOT the local `state`: `displayState` promotes
  // idle-with-ledger-conflicts to 'conflict' for rendering, so the derived
  // value cannot tell the two apart and would disable Pull for exactly the
  // ledger case the paragraph above needs it enabled for.
  const pullBlocked = state === 'dormant' || state === 'auth-error' || status.state === 'conflict';
  const pushBlocked = pullBlocked || status.conflictCount > 0;

  // Present only while the engine is paused on a pre-merge overlap: the status
  // payload omits the field otherwise, so this cannot show a resolved pause.
  const blockingPaths = status.blockingPaths ?? [];

  const { conflicts } = useConflicts();
  const firstConflict = conflicts[0] ?? null;
  const showConflictButton = state === 'conflict' && firstConflict !== null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        {/* shrink-0 so a long `owner/repo` truncates instead of eating the
            title — "Git s…" next to a half-shown repo name tells the user
            nothing about either. */}
        <div className="flex shrink-0 items-center gap-2">
          <BadgeIcon status={status} />
          <span className="text-1sm font-medium">
            <Trans>Git sync</Trans>
          </span>
        </div>
        {status.remote &&
          (status.remote.webUrl ? (
            <a
              href={status.remote.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-0.5 text-xs text-foreground hover:text-primary hover:underline"
              aria-label={t`Open ${status.remote.label} on GitHub (opens in a new tab)`}
            >
              <span className="truncate">{status.remote.label}</span>
              <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
            </a>
          ) : (
            <span className="min-w-0 truncate text-xs text-foreground">{status.remote.label}</span>
          ))}
      </div>

      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
        variant={pendingMode ?? 'full'}
        strandedCommitCount={strandedCommitCount}
      />

      {/* ── Sync mode ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>
          <Trans>Sync mode</Trans>
        </SectionLabel>
        <Select
          value={mode}
          onValueChange={(v) => {
            if (isSyncMode(v)) onModeSelect(v);
          }}
          disabled={!projectLocalSynced}
        >
          <SelectTrigger
            size="sm"
            // shadcn's Select ships `text-sm` on both the trigger and its items.
            // This popover's body scale is `text-xs`, and its "Git sync" title
            // is `text-1sm` — an unscoped trigger renders the current mode
            // LARGER than the popover's own heading. Pinned here rather than in
            // ui/select.tsx so other Select surfaces keep the default scale.
            className="w-full text-xs"
            aria-label={t`Sync mode`}
            data-testid="sync-mode-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off" className="text-xs">{t`Manual`}</SelectItem>
            <SelectItem value="follow" className="text-xs">{t`Auto (Pull only)`}</SelectItem>
            {/* Rendered even when denied, disabled rather than omitted. Radix
                fills the trigger by portaling the SELECTED item's text into it,
                so dropping the item a `full` project is already on leaves the
                trigger blank and its accessible name empty — on the one control
                that says whether edits leave the machine. The reason is already
                on screen below (the push-permission line), so this needs no
                tooltip; Settings shows-and-explains the same condition. */}
            <SelectItem value="full" className="text-xs" disabled={genuineReadOnly}>
              {t`Auto (Pull and Push)`}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" data-testid="sync-popover-mode-line">
          {mode === 'off' ? (
            <Trans>Nothing moves until you ask.</Trans>
          ) : mode === 'follow' ? (
            <Trans>Updates flow in from your remote; your edits stay on this computer.</Trans>
          ) : (
            <Trans>Your edits are committed and pushed to your remote automatically.</Trans>
          )}
        </p>
      </div>

      {/* ── Manual actions ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t pt-3">
        <SectionLabel>
          <Trans>Manual</Trans>
        </SectionLabel>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="xs"
            className="flex-1"
            disabled={busy || pullBlocked}
            onClick={() => runManualSync('pull')}
            data-testid="sync-popover-pull"
          >
            {spinning === 'pull' ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : (
              <ArrowDown data-icon="inline-start" />
            )}
            <Trans>Pull</Trans>
          </Button>
          {canPush && (
            <Button
              variant="outline"
              size="xs"
              className="flex-1"
              disabled={busy || pushBlocked}
              onClick={() => runManualSync('push')}
              data-testid="sync-popover-push"
            >
              {spinning === 'push' ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <ArrowUp data-icon="inline-start" />
              )}
              <Trans>Push</Trans>
            </Button>
          )}
        </div>
        {canPush && (
          <Button
            size="xs"
            className="w-full"
            disabled={busy || pushBlocked}
            onClick={() => runManualSync('sync')}
            data-testid="sync-popover-sync"
          >
            {spinning === 'sync' ? (
              <Spinner aria-hidden="true" icon={RefreshCw} data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            <Trans>Pull and Push</Trans>
          </Button>
        )}
      </div>

      {/* ── Problems ────────────────────────────────────────────────────── */}
      {/* Live region carries only STATUS TEXT — error lines and the identity
          tail — so a state flip is announced to an open popover without
          re-reading button labels. role="status" is implicitly aria-atomic, so
          any text change re-announces the whole region; keep children
          non-interactive and render the button-bearing rows after it.
          `empty:sr-only` keeps it mounted and pre-registered while healthy: a
          region that appears and fills in one commit is missed on
          VoiceOver/Safari, and `display:none` drops it from the accessibility
          tree entirely. `sr-only` is absolutely positioned, so an empty region
          is not a flex item and adds no gap. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-3.5 empty:sr-only">
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

        {/* Identity tail — which account actually answered. Rendered under the
            error lines exactly as it is elsewhere, because a two-account user
            cannot otherwise tell WHY a push was refused: the reason sentence is
            identical whichever account was used. */}
        {isParkedOnNotFoundAsIdentity(status) && status.pushPermission?.checkStatus === 'denied'
          ? // Identity only: the error line above already carries the full
            // not-found copy, and every reason sentence either re-prescribes the
            // sign-in this state withholds or asserts more than a 404 proves.
            formatDeniedIdentitySentences(status.pushPermission).map((sentence) => (
              <p key={sentence} className="text-xs text-muted-foreground">
                {sentence}
              </p>
            ))
          : null}
        {status.pausedReason === 'no-push-permission' &&
        status.pushPermission?.checkStatus === 'denied'
          ? // Additive to the pause line below: the engine really is parked, and
            // that stays the headline — but a push-permission pause and a genuine
            // read-only collaborator render the same sentence, so the identity
            // tail is the only thing that distinguishes them.
            formatDeniedIdentitySentences(status.pushPermission).map((sentence) => (
              <p key={sentence} className="text-xs text-muted-foreground">
                {sentence}
              </p>
            ))
          : null}
      </div>

      {!following && shouldOfferReconnect(status.pushPermission) ? (
        // Signed-out denial (no credential resolved) — reconnecting resumes
        // sync, so offer it here. Takes precedence over the button-less
        // `pausedReason`/`denied` branches below.
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            <Trans>You're signed out — sign in to resume syncing.</Trans>
          </p>
          {onSignIn && (
            <Button variant="outline" size="xs" className="self-start" onClick={onSignIn}>
              <Trans>Sign in</Trans>
            </Button>
          )}
        </div>
      ) : blockingPaths.length > 0 ? (
        // The one paused reason the user can clear from here, so it gets the
        // panel instead of the sentence every other reason shares.
        <SyncBlockingChanges paths={blockingPaths} />
      ) : isParkedOnNotFoundAsIdentity(
          status,
        ) ? // Suppression, not copy: the error line already carries the full
      // not-found sentence and the identity tail rides above. Falling through
      // to `formatPausedReason('auth-error')` would read "Reconnect required" —
      // the one prescription this state withdraws, since re-authenticating
      // cannot make an unseeable repository visible.
      null : status.pausedReason ? (
        <p className="text-xs text-muted-foreground">{formatPausedReason(status.pausedReason)}</p>
      ) : !following && genuineReadOnly && status.pushPermission?.checkStatus === 'denied' ? (
        // A follower never pushes, so the push-permission verdict is not its
        // problem — its mode line already says what the project does.
        formatPushPermissionDenied(status.pushPermission.deniedReason, status.pushPermission).map(
          (sentence) => (
            <p key={sentence} className="text-xs text-muted-foreground">
              {sentence}
            </p>
          ),
        )
      ) : shouldOfferSignInAgain(status.pushPermission) ? (
        // Probe-401 branch: surface a "Sign in again" affordance without
        // disabling sync — the probe couldn't reach a verdict.
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            <Trans>Your GitHub session expired — sign in again to verify push access.</Trans>
          </p>
          {onSignIn && (
            <Button variant="outline" size="xs" className="self-start" onClick={onSignIn}>
              <Trans>Sign in</Trans>
            </Button>
          )}
        </div>
      ) : null}

      {state === 'conflict' && (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-amber-700 dark:text-amber-400">
            {/* One line for every mode: the repo keeps fast-forwarding while a
                document waits on resolution — only pushing is held — so the
                retired "paused/resume" framing would describe automation that
                is not actually stopped. */}
            <Trans>A document has a conflict — resolve it to keep it up to date.</Trans>
          </p>
          {showConflictButton && firstConflict && (
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => navigateToHash(hashFromDocName(filePathToDocName(firstConflict.file)))}
            >
              <Trans>Review</Trans>
            </Button>
          )}
        </div>
      )}

      {state === 'auth-error' && !isParkedOnNotFoundAsIdentity(status) && onSignIn && (
        // Withheld for the not-found masquerade: it parks as auth-error, but a
        // re-sign-in is not the prescribed fix, and the copy and the affordance
        // have to agree.
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-destructive">
            <Trans>Reconnect required to keep syncing.</Trans>
          </p>
          <Button variant="outline" size="xs" className="self-start" onClick={onSignIn}>
            <Trans>Sign in</Trans>
          </Button>
        </div>
      )}

      {conflictCount > 0 && (
        <p className="text-xs text-muted-foreground">
          <Plural value={conflictCount} one="# file conflicted" other="# files conflicted" />
        </p>
      )}

      {/* ── Status ──────────────────────────────────────────────────────── */}
      <WorktreeStatusSection status={status} worktree={worktree} loading={worktreeLoading} />

      {/* The popover hosts the controls you reach for mid-edit; the fuller set
          (committed shared default, cycle cadence) lives in Settings, which this
          opens with the Advanced disclosure already expanded. Paired on
          one row with the freshness line so the footer stays a single band
          instead of two stacked half-empty rows. `justify-between` with an
          always-present left slot keeps the link pinned right even before the
          first cycle, when the freshness line is deliberately absent. */}
      <div className="flex items-center justify-between gap-2">
        <UpdatedLine pulledAt={pulledAt} pushedAt={pushedAt} combinedAt={combinedAt} />
        {/* Closing on navigate: the popover overlays the editor, and Settings
            opens as a dialog on top — leaving it open would strand it there. */}
        <PopoverClose asChild>
          <Button
            variant="link"
            size="xs"
            // The `link` variant ships `hover:underline`; this footer wants the
            // quieter weight-shift instead, so the decoration is turned back off
            // (cn() last-wins puts `no-underline` over the variant's rule).
            className="h-auto p-0 text-xs text-muted-foreground hover:font-medium hover:text-foreground hover:no-underline"
            onClick={() => openSyncSettings({ advanced: true })}
            data-testid="sync-popover-settings"
          >
            <Settings2 data-icon="inline-start" />
            <Trans>Advanced settings</Trans>
          </Button>
        </PopoverClose>
      </div>

      {status.identityUnresolved && onSetIdentity && (
        <div className="flex items-start gap-2 rounded-md border border-dashed p-2">
          <UserCog className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs leading-snug text-muted-foreground">
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

  // A remote is the only precondition for showing the badge. Under the
  // three-way mode selector there is no longer an "opted out" state to hide
  // for: `off` is Manual, a resting mode whose whole point is the manual
  // actions this popover hosts. Hiding it would strand the user in Settings to
  // reach a Pull button.
  if (!status.hasRemote) return null;

  const label = badgeLabel(status);
  // Via syncStateLabelFor, not stateLabel: the trigger's visible label and
  // accessible name must agree with the popover, or the not-found masquerade
  // reads "Reconnect required" on the badge while the popover withdraws exactly
  // that prescription.
  const syncStateLabel = syncStateLabelFor(status);
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
      {/* Ceiling here rather than on the shared PopoverContent primitive: the
          server caps each status list at 100, so four lists can paint ~400 rows
          and push the Status block and this popover's own footer past the
          viewport. Upstream shadcn ships no ceiling on popover, and three
          sibling surfaces in this app cap at their own content — so the fix
          belongs to the content that overflows, not to every popover. */}
      <PopoverContent
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col overflow-y-auto p-3"
      >
        <PopoverBody status={status} onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
      </PopoverContent>
    </Popover>
  );
}
