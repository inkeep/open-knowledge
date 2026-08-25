/**
 * Working-tree status for `GET /api/git/worktree-status` — the `git status`
 * equivalent the sync popover renders.
 *
 * Read-only, so no `withParentLock`: every probe here is a `status` /
 * `rev-parse` / `for-each-ref` read. Running it under the parent mutex would
 * make a popover open block behind an in-flight push cycle, which is exactly
 * the moment the user most wants to see what is happening.
 *
 * Local-only by construction — nothing here contacts a remote. `upstream` reads
 * the configured tracking ref from local refs; it never fetches.
 */

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

/**
 * Per-list cap. A repo with a stale `node_modules` or an unignored build
 * directory can emit tens of thousands of untracked records; the popover shows
 * a bounded list and a "+N more" line rather than shipping all of them to the
 * renderer. Applied per list so a huge untracked set cannot crowd out the
 * staged entries the user actually acted on.
 */
export const WORKTREE_STATUS_LIST_CAP = 100;

export interface WorktreeStatus {
  /** False when the porcelain read failed — see the schema's `readable`. */
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

/** Narrow a raw porcelain column to the bounded wire enum, defaulting to `M`. */
function toStatusCode(raw: string): GitStatusCode {
  return (GIT_STATUS_CODES as readonly string[]).includes(raw) ? (raw as GitStatusCode) : 'M';
}

/**
 * Partition porcelain entries into the three lists `git status` prints.
 *
 * A path can legitimately land in both `staged` and `notStaged` — that is the
 * "Changes to be committed" / "Changes not staged for commit" split git itself
 * shows for a file modified, staged, then modified again. Untracked (`??`) and
 * ignored (`!!`) are single-column states; ignored never reaches the UI because
 * the caller does not pass `--ignored`.
 *
 * Exported for unit tests: the partition rules are pure given the parsed
 * records, so they are pinned without spawning git.
 */
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
    // `!!` only appears with `--ignored`, which this surface never passes.
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
      // `origPath` rides both branches: a worktree rename reports in the Y
      // column, so spreading it onto `staged` only dropped the origin for
      // exactly the rename shape the parser fix below now admits.
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

/**
 * Files a pull would bring in — the diff from HEAD to the tracking ref.
 *
 * Three-dot (`HEAD...@{upstream}`), i.e. merge-base..upstream — the set a merge
 * would actually bring in. Two-dot is a symmetric tree-to-tree diff, so on a
 * branch that is AHEAD it reports every local-only commit inverted: a file you
 * added locally renders as an incoming "Deleted" with a destructive badge, for a
 * pull that would touch nothing. Being ahead is the steady state for a follower
 * and for any branch whose last push failed, so that was not a corner case.
 *
 * Local-only: this compares two refs already on disk, so it is exactly as fresh
 * as the last fetch and costs no network. Returns `[]` for a branch with no
 * upstream, which is a normal state and not an error.
 *
 * Exported for tests.
 */
export async function readIncomingEntries(git: SimpleGit): Promise<GitWorktreeEntry[]> {
  let rows: Awaited<ReturnType<typeof listNameStatus>>;
  try {
    rows = await listNameStatus(git, ['diff', '--name-status', 'HEAD...@{upstream}']);
  } catch {
    // No upstream configured, unborn HEAD, or an unreadable ref. Nothing
    // incoming is the honest answer; the counts alongside carry the same story.
    return [];
  }
  return rows.map((row) => ({
    // A rename's `to` is the path that will exist after the merge.
    path: row.to,
    code: toStatusCode(row.status.charAt(0)),
    // Pull is unscoped — git merges everything the remote carries — so the
    // "would Push send this" flag has no meaning on an inbound row.
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

  // Local-only: status and ref reads never reach a remote, so no credentials.
  const { git } = createGitInstance(projectDir, { credentialConfig: [] });

  const [entriesResult, branchResult, upstreamResult, incomingResult] = await Promise.allSettled([
    listPorcelainEntries(git),
    // `--symbolic-full-name HEAD` prints `HEAD` verbatim when detached, which is
    // how the detached case is detected without a second probe.
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', 'HEAD']),
    git.raw(['rev-parse', '--symbolic-full-name', '--abbrev-ref', '@{upstream}']),
    readIncomingEntries(git),
  ]);

  if (entriesResult.status === 'rejected') {
    // `warn`, not `debug`: debug sits below the default console level AND below
    // the bug-report file sink, so the only diagnostic for a false-clean reached
    // neither the terminal nor a support bundle.
    log.warn({ err: entriesResult.reason }, '[git-status] porcelain read failed');
    return { ...empty, readable: false };
  }

  const headRef = branchResult.status === 'fulfilled' ? branchResult.value.trim() : '';
  const detached = headRef === 'HEAD';
  // An unborn HEAD makes rev-parse fail entirely; both branches then read null.
  const branch = detached || headRef === '' ? null : headRef;
  // A branch with no configured tracking ref rejects `@{upstream}` — that is a
  // normal state (a local-only branch), not an error worth logging.
  const upstream =
    upstreamResult.status === 'fulfilled' ? upstreamResult.value.trim() || null : null;

  const incomingAll = incomingResult.status === 'fulfilled' ? incomingResult.value : [];
  const partitioned = partitionPorcelainEntries(entriesResult.value, isSyncScoped);

  // Stamped after the per-list caps so the resolution runs once per RENDERED
  // row, not once per porcelain record — a stale `node_modules` can emit tens
  // of thousands of those, and the rows past the cap are never sent.
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
