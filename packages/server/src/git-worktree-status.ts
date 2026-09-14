import type {
  GitStatusCode,
  GitWorktreeEntry,
  GitWorktreeOpenTarget,
} from '@inkeep/open-knowledge-core';
import { GIT_STATUS_CODES } from '@inkeep/open-knowledge-core';
import type { SimpleGit } from 'simple-git';
import { createGitInstance } from './git-handle.ts';
import {
  listNameStatus,
  listPorcelainEntries,
  PORCELAIN_STATUS_ARGS,
  type PorcelainEntry,
} from './git-paths.ts';
import { getLogger } from './logger.ts';

const log = getLogger('git-worktree-status');

export const WORKTREE_STATUS_LIST_CAP = 100;

const WORKTREE_STATUS_TIMEOUT_MS = 10_000;

export interface WorktreeStatus {
  readable: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  staged: GitWorktreeEntry[];
  notStaged: GitWorktreeEntry[];
  untracked: GitWorktreeEntry[];
  incoming: GitWorktreeEntry[];
  truncated: boolean;
}

function toStatusCode(raw: string): GitStatusCode {
  return (GIT_STATUS_CODES as readonly string[]).includes(raw) ? (raw as GitStatusCode) : 'M';
}

export function partitionPorcelainEntries(
  entries: PorcelainEntry[],
  isSyncScoped: (projectRelPath: string) => boolean,
): Omit<WorktreeStatus, 'branch' | 'detached' | 'upstream' | 'incoming' | 'readable'> {
  const staged: GitWorktreeEntry[] = [];
  const notStaged: GitWorktreeEntry[] = [];
  const untracked: GitWorktreeEntry[] = [];

  for (const entry of entries) {
    const syncScoped = isSyncScoped(entry.path);
    if (entry.x === '?' || entry.y === '?') {
      untracked.push({ path: entry.path, code: '?', syncScoped });
      continue;
    }
    if (entry.x === '!' || entry.y === '!') continue;
    if (entry.x !== ' ' && entry.x !== '') {
      staged.push({
        path: entry.path,
        code: toStatusCode(entry.x),
        syncScoped,
        ...(entry.origPath !== undefined ? { origPath: entry.origPath } : {}),
      });
    }
    if (entry.y !== ' ' && entry.y !== '') {
      notStaged.push({
        path: entry.path,
        code: toStatusCode(entry.y),
        syncScoped,
        ...(entry.origPath !== undefined ? { origPath: entry.origPath } : {}),
      });
    }
  }

  const truncated =
    staged.length > WORKTREE_STATUS_LIST_CAP ||
    notStaged.length > WORKTREE_STATUS_LIST_CAP ||
    untracked.length > WORKTREE_STATUS_LIST_CAP;

  const syncScopedFirst = (bucket: GitWorktreeEntry[]): GitWorktreeEntry[] =>
    [...bucket.filter((e) => e.syncScoped), ...bucket.filter((e) => !e.syncScoped)].slice(
      0,
      WORKTREE_STATUS_LIST_CAP,
    );

  return {
    staged: syncScopedFirst(staged),
    notStaged: syncScopedFirst(notStaged),
    untracked: syncScopedFirst(untracked),
    truncated,
  };
}

const EXPECTED_GIT_ABSENCE_MESSAGES = [
  'unknown revision or path not in the working tree',
  'no upstream configured for branch',
  'does not point to a branch',
  'no such branch',
] as const;

export function isExpectedGitAbsence(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return EXPECTED_GIT_ABSENCE_MESSAGES.some((known) => message.includes(known));
}

export async function readIncomingEntries(
  git: SimpleGit,
  abortSignal?: AbortSignal,
): Promise<GitWorktreeEntry[]> {
  let rows: Awaited<ReturnType<typeof listNameStatus>>;
  try {
    rows = await listNameStatus(git, ['diff', '--name-status', 'HEAD...@{upstream}']);
  } catch (err) {
    if (!abortSignal?.aborted && !isExpectedGitAbsence(err)) {
      log.warn(
        { event: 'worktree-incoming-read-failed', err },
        '[sync] incoming-change read failed — panel shows nothing incoming',
      );
    }
    return [];
  }
  return rows.map((row) => ({
    path: row.to,
    code: toStatusCode(row.status.charAt(0)),
    syncScoped: true,
    ...(row.status.charAt(0) === 'R' || row.status.charAt(0) === 'C' ? { origPath: row.from } : {}),
  }));
}

export interface ReadWorktreeStatusOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * It is threaded in rather than recomputed here so the answer comes from the sync engine's own
 * admission predicate — the same one the staging walk consults (precedent #55).
 */
export async function readWorktreeStatus(
  projectDir: string,
  isSyncScoped: (projectRelPath: string) => boolean,
  toOpenTarget?: (projectRelPath: string) => GitWorktreeOpenTarget | undefined,
  options: ReadWorktreeStatusOptions = {},
): Promise<WorktreeStatus> {
  const empty: WorktreeStatus = {
    readable: true,
    branch: null,
    detached: false,
    upstream: null,
    staged: [],
    notStaged: [],
    untracked: [],
    incoming: [],
    truncated: false,
  };

  const { git } = createGitInstance(projectDir, {
    credentialConfig: [],
    timeoutMs: options.timeoutMs ?? WORKTREE_STATUS_TIMEOUT_MS,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });

  const startedAt = Date.now();
  const [entriesResult, branchResult, upstreamResult, incomingResult] = await Promise.allSettled([
    listPorcelainEntries(git, PORCELAIN_STATUS_ARGS),
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', 'HEAD']),
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', '@{upstream}']),
    readIncomingEntries(git, options.abortSignal),
  ]);

  const headRef = branchResult.status === 'fulfilled' ? branchResult.value.trim() : '';
  const detached = headRef === 'HEAD';
  const branch = detached || headRef === '' ? null : headRef;
  const cancelled = options.abortSignal?.aborted === true;
  const repoUnreadable = entriesResult.status === 'rejected';

  const reportDefaultedLeg = (
    result: PromiseSettledResult<unknown>,
    event: string,
    msg: string,
  ): void => {
    if (result.status !== 'rejected') return;
    if (cancelled || repoUnreadable || isExpectedGitAbsence(result.reason)) return;
    log.warn(
      { event, err: result.reason, elapsedMs: Date.now() - startedAt, branch },
      `[sync] ${msg}`,
    );
  };

  reportDefaultedLeg(
    branchResult,
    'worktree-branch-read-failed',
    'branch read failed — panel shows no branch',
  );
  reportDefaultedLeg(
    upstreamResult,
    'worktree-upstream-read-failed',
    'upstream read failed — panel shows no upstream',
  );

  if (entriesResult.status === 'rejected') {
    if (!cancelled) {
      log.error(
        {
          event: 'worktree-read-failed',
          err: entriesResult.reason,
          elapsedMs: Date.now() - startedAt,
          branch,
        },
        '[sync] worktree status read failed — panel listing marked unreadable',
      );
    }
    return { ...empty, readable: false };
  }
  const upstream =
    upstreamResult.status === 'fulfilled' ? upstreamResult.value.trim() || null : null;

  const incomingAll = incomingResult.status === 'fulfilled' ? incomingResult.value : [];
  const partitioned = partitionPorcelainEntries(entriesResult.value, isSyncScoped);

  const withOpenTargets = (entries: GitWorktreeEntry[]): GitWorktreeEntry[] => {
    if (!toOpenTarget) return entries;
    return entries.map((entry) => {
      const open = toOpenTarget(entry.path);
      return open === undefined ? entry : { ...entry, open };
    });
  };

  return {
    readable: true,
    branch,
    detached,
    upstream,
    staged: withOpenTargets(partitioned.staged),
    notStaged: withOpenTargets(partitioned.notStaged),
    untracked: withOpenTargets(partitioned.untracked),
    truncated: partitioned.truncated || incomingAll.length > WORKTREE_STATUS_LIST_CAP,
    incoming: withOpenTargets(incomingAll.slice(0, WORKTREE_STATUS_LIST_CAP)),
  };
}
