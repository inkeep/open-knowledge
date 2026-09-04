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

type ManualSyncOp = 'sync' | 'push' | 'pull';

function triggerSyncFromBadge(op: ManualSyncOp = 'sync', onFailure?: () => void): void {
  triggerSync(op).catch((err) => {
    console.warn(
      '[sync-badge] manual sync trigger failed',
      err instanceof Error ? err.message : err,
    );
    onFailure?.();
  });
}

function navigateToHash(nextHash: string): void {
  if (typeof window === 'undefined') return;
  if (!isSameHash(window.location.hash, nextHash)) {
    window.location.hash = nextHash;
  }
}

function hashForOpenTarget(target: GitWorktreeOpenTarget): string {
  return target.kind === 'doc' ? hashFromDocName(target.docName) : hashFromAssetPath(target.path);
}

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

function isFollowingMode(status: GitSyncStatus): boolean {
  return status.syncMode === 'follow';
}

export function displayState(status: GitSyncStatus): GitSyncStatus['state'] {
  if (status.state === 'idle' && status.conflictCount > 0) {
    return 'conflict';
  }
  return status.state;
}

interface BadgeIconProps {
  status: GitSyncStatus;
}

function BadgeIcon({ status }: BadgeIconProps) {
  const cls = 'size-3.5';
  switch (displayState(status)) {
    case 'dormant':
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
      return hasNotFoundAsIdentityError(status) ? (
        <CloudAlert className={`${cls} text-destructive`} />
      ) : (
        <LogIn className={`${cls} text-destructive`} />
      );
    case 'disabled':
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

function stateLabel(status: GitSyncStatus): string {
  const following = isFollowingMode(status);
  const state = displayState(status);
  switch (state) {
    case 'dormant':
      return t`No git remote`;
    case 'idle':
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

type PushPermissionDeniedIdentity = Pick<
  Extract<PushPermissionWire, { checkStatus: 'denied' }>,
  'resolvedLogin' | 'declaredLogin' | 'declaredSource'
>;

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
  return sentences;
}

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

export function hasNotFoundAsIdentityError(
  status: Pick<GitSyncStatus, 'pushErrorCode' | 'pullErrorCode'>,
): boolean {
  return (
    status.pushErrorCode === 'auth-not-found-as-identity' ||
    status.pullErrorCode === 'auth-not-found-as-identity'
  );
}

export function isParkedOnNotFoundAsIdentity(
  status:
    | Pick<GitSyncStatus, 'pausedReason' | 'pushErrorCode' | 'pullErrorCode'>
    | null
    | undefined,
): boolean {
  return status?.pausedReason === 'auth-error' && hasNotFoundAsIdentityError(status);
}

export function shouldOfferReconnect(pushPermission: PushPermissionWire | undefined): boolean {
  return (
    pushPermission?.checkStatus === 'denied' && pushPermission.deniedReason === 'not-authenticated'
  );
}

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
      return t`Push failed — check the server logs for details.`;
  }
}

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
  key: 'sync' | 'push' | 'pull';
  direction: SyncErrorDirection | null;
  message: string;
}

export function computeSyncErrorLines(
  status: Pick<GitSyncStatus, 'pushError' | 'pushErrorCode' | 'pullError' | 'pullErrorCode'>,
): SyncErrorLine[] {
  const pushPresent = status.pushErrorCode != null || status.pushError != null;
  const pullPresent = status.pullErrorCode != null || status.pullError != null;

  if (pushPresent && pullPresent) {
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

export function shouldOfferSignInAgain(pushPermission: PushPermissionWire | undefined): boolean {
  return (
    pushPermission?.checkStatus === 'unknown' && pushPermission.unknownError === 'token-invalid'
  );
}

function syncStateLabelFor(status: GitSyncStatus): string {
  if (displayState(status) === 'auth-error' && hasNotFoundAsIdentityError(status)) {
    return t`Repository not found`;
  }
  return stateLabel(status);
}

export function tooltipLabel(status: GitSyncStatus): string {
  const following = isFollowingMode(status);
  const state = displayState(status);
  if (state === 'conflict' && status.conflictCount > 0) {
    const { conflictCount } = status;
    return plural(conflictCount, { one: '# conflict', other: '# conflicts' });
  }
  if (state === 'idle') {
    const { ahead, behind } = status;
    if (following) {
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

function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <span id={id} className="font-mono uppercase tracking-wide text-2xs text-muted-foreground">
      {children}
    </span>
  );
}

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

function WorktreeRow({
  entry,
  dimmed,
  label,
}: {
  entry: GitWorktreeEntry;
  dimmed: boolean;
  label: string;
}) {
  const codeLabel = statusCodeLabel(entry.code);
  const openTarget = entry.open;
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
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverClose asChild>
              <Button
                variant="link-muted"
                size="xs"
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
          {}
          {label !== entry.path && <span className="sr-only">{entry.path}</span>}
        </>
      )}
    </li>
  );
}

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

function WorktreeFolder({
  group,
  prefix,
  dimmed,
}: {
  group: WorktreeFolderGroup;
  prefix: string;
  dimmed: boolean;
}) {
  const fileCount = group.rows.length;
  const [open, setOpen] = useState(false);
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
            className="flex max-h-56 flex-col gap-2.5 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — Chromium doesn't make overflow:auto divs focusable without tabIndex.
            tabIndex={0}
            aria-labelledby="worktree-status-label"
            data-testid="worktree-listing"
          >
            {}
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

function UpdatedLine({
  pulledAt,
  pushedAt,
  combinedAt,
}: {
  pulledAt: string | null;
  pushedAt: string | null;
  combinedAt: string | null;
}) {
  const { t } = useLingui();
  const pulled = pulledAt === null ? null : formatRelativeCompact(pulledAt);
  const pushed = pushedAt === null ? null : formatRelativeCompact(pushedAt);
  const updatedRelative = combinedAt === null ? null : formatRelativeCompact(combinedAt);
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
  const showArrows = pulled !== null || pushed !== null;
  if (label === null) return <span />;
  return (
    <span className="text-xs text-muted-foreground" data-testid="sync-popover-last-sync">
      {}
      {showArrows && (
        <span className="sr-only" data-testid="sync-popover-last-sync-label">
          {label}
        </span>
      )}
      {}
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
  const { status: worktree, loading: worktreeLoading } = useGitWorktreeStatus(true);

  const following = mode === 'follow';
  const state = displayState(status);
  const notFoundAsIdentity = hasNotFoundAsIdentityError(status);
  const pulledAt = status.lastPullOkUtc ?? null;
  const pushedAt = status.lastPushOkUtc ?? null;
  const combinedAt = status.lastRunUtc ?? status.lastSyncUtc ?? null;
  const genuineReadOnly =
    status.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated' &&
    !notFoundAsIdentity;

  const canPush = !genuineReadOnly;
  const busy = state === 'fetching' || state === 'pulling' || state === 'pushing';
  const [pendingAction, setPendingAction] = useState<ManualSyncOp | null>(null);
  useEffect(() => {
    if (!busy) setPendingAction(null);
  }, [busy]);
  const clearFailedAction = (op: ManualSyncOp) => {
    setPendingAction((current) => (current === op ? null : current));
  };
  const spinning: ManualSyncOp | null = !busy
    ? null
    : (pendingAction ?? (state === 'pushing' ? 'push' : 'pull'));
  const runManualSync = (op: ManualSyncOp): void => {
    setPendingAction(op);
    triggerSyncFromBadge(op, () => clearFailedAction(op));
  };
  const pullBlocked = state === 'dormant' || state === 'auth-error' || status.state === 'conflict';
  const pushBlocked = pullBlocked || status.conflictCount > 0;

  const blockingPaths = status.blockingPaths ?? [];

  const { conflicts } = useConflicts();
  const firstConflict = conflicts[0] ?? null;
  const showConflictButton = state === 'conflict' && firstConflict !== null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        {}
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

      {}
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
            className="w-full text-xs"
            aria-label={t`Sync mode`}
            data-testid="sync-mode-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off" className="text-xs">{t`Manual`}</SelectItem>
            <SelectItem value="follow" className="text-xs">{t`Auto (Pull only)`}</SelectItem>
            {}
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

      {}
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

      {}
      {}
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

        {}
        {isParkedOnNotFoundAsIdentity(status) && status.pushPermission?.checkStatus === 'denied'
          ? formatDeniedIdentitySentences(status.pushPermission).map((sentence) => (
              <p key={sentence} className="text-xs text-muted-foreground">
                {sentence}
              </p>
            ))
          : null}
        {status.pausedReason === 'no-push-permission' &&
        status.pushPermission?.checkStatus === 'denied'
          ? formatDeniedIdentitySentences(status.pushPermission).map((sentence) => (
              <p key={sentence} className="text-xs text-muted-foreground">
                {sentence}
              </p>
            ))
          : null}
      </div>

      {!following && shouldOfferReconnect(status.pushPermission) ? (
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
        <SyncBlockingChanges paths={blockingPaths} />
      ) : isParkedOnNotFoundAsIdentity(status) ? null : status.pausedReason ? (
        <p className="text-xs text-muted-foreground">{formatPausedReason(status.pausedReason)}</p>
      ) : !following && genuineReadOnly && status.pushPermission?.checkStatus === 'denied' ? (
        formatPushPermissionDenied(status.pushPermission.deniedReason, status.pushPermission).map(
          (sentence) => (
            <p key={sentence} className="text-xs text-muted-foreground">
              {sentence}
            </p>
          ),
        )
      ) : shouldOfferSignInAgain(status.pushPermission) ? (
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
            {}
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

      {}
      <WorktreeStatusSection status={status} worktree={worktree} loading={worktreeLoading} />

      {}
      <div className="flex items-center justify-between gap-2">
        <UpdatedLine pulledAt={pulledAt} pushedAt={pushedAt} combinedAt={combinedAt} />
        {}
        <PopoverClose asChild>
          <Button
            variant="link"
            size="xs"
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

interface SyncStatusBadgeProps {
  onSignIn?: () => void;
  onSetIdentity?: () => void;
}

export function SyncStatusBadge({ onSignIn, onSetIdentity }: SyncStatusBadgeProps = {}) {
  const { t } = useLingui();
  const { status, fetchError } = useGitSyncStatusDetailed();

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

  if (!status.hasRemote) return null;

  const label = badgeLabel(status);
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
      {}
      <PopoverContent
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col overflow-y-auto p-3"
      >
        <PopoverBody status={status} onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
      </PopoverContent>
    </Popover>
  );
}
