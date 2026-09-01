import type {
  GitStatusCode,
  GitWorktreeEntry,
  GitWorktreeOpenTarget,
} from '@inkeep/open-knowledge-core';
import { GIT_STATUS_CODES } from '@inkeep/open-knowledge-core';
import type { SimpleGit } from 'simple-git';
import { createGitInstance } from './git-handle.ts';
import { listNameStatus, listPorcelainEntries, type PorcelainEntry } from './git-paths.ts';
import { getLogger } from './logger.ts';

const log = getLogger('git-worktree-status');

export const WORKTREE_STATUS_LIST_CAP = 100;

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

  return {
    staged: staged.slice(0, WORKTREE_STATUS_LIST_CAP),
    notStaged: notStaged.slice(0, WORKTREE_STATUS_LIST_CAP),
    untracked: untracked.slice(0, WORKTREE_STATUS_LIST_CAP),
    truncated,
  };
}

export async function readIncomingEntries(git: SimpleGit): Promise<GitWorktreeEntry[]> {
  let rows: Awaited<ReturnType<typeof listNameStatus>>;
  try {
    rows = await listNameStatus(git, ['diff', '--name-status', 'HEAD...@{upstream}']);
  } catch {
    return [];
  }
  return rows.map((row) => ({
    path: row.to,
    code: toStatusCode(row.status.charAt(0)),
    syncScoped: true,
    ...(row.status.charAt(0) === 'R' || row.status.charAt(0) === 'C' ? { origPath: row.from } : {}),
  }));
}

/**
 * Read the working tree's status.
 *
 * `toOpenTarget` maps a project-relative path to where clicking it navigates,
 * or undefined when it navigates nowhere. Threaded in for the same reason as
 * `isSyncScoped`: the answer belongs to the server's live file index and
 * content filter, and a path this surface guessed at would render as a link
 * to a 404.
 *
 * `isSyncScoped` decides whether Open Knowledge would ever commit a given
 * project-relative path. It is threaded in rather than recomputed here so the
 * answer comes from the sync engine's own admission predicate — the same one
 * the staging walk consults (precedent #55). A UI that marked a path in-scope
 * that Push then skipped would be worse than showing nothing.
 *
 * Never throws: a repository that is unborn, mid-rebase, or not a git dir at
 * all yields an empty status rather than failing the popover. The engine's own
 * `sync-status` payload is what reports sync health; this surface is
 * supplementary detail.
 */
export async function readWorktreeStatus(
  projectDir: string,
  isSyncScoped: (projectRelPath: string) => boolean,
  toOpenTarget?: (projectRelPath: string) => GitWorktreeOpenTarget | undefined,
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

  const { git } = createGitInstance(projectDir, { credentialConfig: [] });

  const [entriesResult, branchResult, upstreamResult, incomingResult] = await Promise.allSettled([
    listPorcelainEntries(git),
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', 'HEAD']),
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', '@{upstream}']),
    readIncomingEntries(git),
  ]);

  if (entriesResult.status === 'rejected') {
    log.warn({ err: entriesResult.reason }, '[git-status] porcelain read failed');
    return { ...empty, readable: false };
  }

  const headRef = branchResult.status === 'fulfilled' ? branchResult.value.trim() : '';
  const detached = headRef === 'HEAD';
  const branch = detached || headRef === '' ? null : headRef;
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
