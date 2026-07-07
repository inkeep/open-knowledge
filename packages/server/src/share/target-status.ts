/**
 * Receive-side verdict for `POST /api/share/target-status`: when a receiver
 * opens a share link and the target isn't on their current ref, why — did it
 * move, get deleted, or was it never here? Runs a targeted `git fetch origin
 * <branch>` (via `createGitInstance`, so the user's ambient git credential
 * helper authenticates it exactly as checkout's fetch does — no explicit OK
 * token is injected) bounded by a block timeout, so a stale local ref can't
 * misreport a recently-added target as gone, then classifies the miss from
 * git's own rename detection.
 *
 * Everything is fail-open: a fetch failure, a broken git, or an ambiguous
 * classification returns `unknown`, and the caller falls back to today's
 * guidance. A miss degrades to honest `deleted`, never a wrong redirect.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { truncateError } from '../error-format.ts';
import { createGitInstance } from '../git-handle.ts';
import { getLogger } from '../logger.ts';

/** Single source of truth for the handler tag used in logs + telemetry. */
export const SHARE_TARGET_STATUS_HANDLER_TAG = 'share-target-status';

/** Block timeout for the fetch — a hung fetch degrades to `unknown`. */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

interface DiffRow {
  status: string;
  from: string;
  to: string;
}

/**
 * Parse `git diff-tree --name-status` rows (tab-separated). Rename/copy rows
 * carry a score and two paths (`R100\told\tnew`); every other status carries
 * one path (`D\told`).
 */
function parseNameStatus(output: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
      rows.push({ status, from: parts[1] ?? '', to: parts[2] ?? '' });
    } else {
      rows.push({ status, from: parts[1] ?? '', to: parts[1] ?? '' });
    }
  }
  return rows;
}

/** Classify a doc removal: the row whose source is exactly the shared path. */
function classifyDoc(rows: DiffRow[], gitPath: string): ShareTargetStatusResponse {
  for (const row of rows) {
    if (row.from !== gitPath) continue;
    if (row.status.startsWith('R')) return { verdict: 'renamed', renamedTo: row.to };
    if (row.status === 'D') return { verdict: 'deleted' };
  }
  // The removing commit touched the path but not via a rename/delete row we
  // recognize — treat as deleted (honest) rather than inventing a redirect.
  return { verdict: 'deleted' };
}

/**
 * Classify a folder removal: a `git mv` of a folder shows as per-file rename
 * rows under the old prefix, all rewriting to one new prefix. Map the folder by
 * the common prefix across those rows; anything else (deletes, inconsistent
 * destinations) is a deletion.
 */
function classifyFolder(rows: DiffRow[], folderPath: string): ShareTargetStatusResponse {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
  const newPrefixes = new Set<string>();
  for (const row of rows) {
    if (!row.from.startsWith(prefix)) continue;
    if (!row.status.startsWith('R')) continue;
    const rest = row.from.slice(prefix.length);
    if (row.to.endsWith(`/${rest}`)) {
      newPrefixes.add(row.to.slice(0, row.to.length - rest.length - 1));
    } else {
      newPrefixes.add('\0ambiguous');
    }
  }
  const only = newPrefixes.size === 1 ? [...newPrefixes][0] : undefined;
  if (only !== undefined && only !== '\0ambiguous') {
    return { verdict: 'renamed', renamedTo: only };
  }
  return { verdict: 'deleted' };
}

/**
 * Compute the target-status verdict for `gitPath` (repo-root-relative) at
 * `origin/<branch>`. `skipFetch` is for the fresh-clone leg, whose clone is
 * already current, so no fetch is needed.
 */
export async function computeShareTargetStatus(
  projectDir: string,
  branch: string,
  gitPath: string,
  kind: 'doc' | 'folder',
  opts: { skipFetch?: boolean; fetchTimeoutMs?: number } = {},
): Promise<ShareTargetStatusResponse> {
  const log = getLogger('share');
  const emit = (result: ShareTargetStatusResponse): ShareTargetStatusResponse => {
    log.info({ action: 'target-status', verdict: result.verdict, kind }, 'target-status verdict');
    return result;
  };

  const { git } = createGitInstance(
    projectDir,
    opts.skipFetch ? {} : { timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS },
  );

  if (!opts.skipFetch) {
    try {
      await git.raw(['fetch', 'origin', branch]);
    } catch (err) {
      // Offline / auth / timeout — the caller falls back to today's guidance.
      // Keep the error identity so a "receiver always sees pull-guidance"
      // report can distinguish offline from auth-denied from timeout.
      log.warn(
        { action: 'target-status', kind, error: truncateError(err) },
        'target-status fetch failed',
      );
      return emit({ verdict: 'unknown' });
    }
  }

  const ref = `origin/${branch}`;
  try {
    // Present at origin's tip. Two sub-cases the receiver must not conflate:
    //   - a genuinely stale local ref — they are behind, and a pull recovers
    //     the target (`on-origin`); or
    //   - a LOCAL uncommitted change — the target is still in their committed
    //     HEAD but they removed or renamed it in their own working tree without
    //     syncing (`changed-locally`). "Pull" is the wrong guidance there: they
    //     are not behind, and a pull can't reconcile an uncommitted working-tree
    //     change.
    // Distinguish by HEAD + working-tree state. `projectDir` is the receiver's
    // repo root, so the working-tree copy of `gitPath` lives at
    // `<projectDir>/<gitPath>`. A local delete AND a local rename both leave the
    // OLD path in HEAD yet gone from the working tree, so one check covers both.
    const present = await git
      .raw(['cat-file', '-e', `${ref}:${gitPath}`])
      .then(() => true)
      .catch(() => false);
    if (present) {
      const inHead = await git
        .raw(['cat-file', '-e', `HEAD:${gitPath}`])
        .then(() => true)
        .catch(() => false);
      const inWorkingTree = existsSync(join(projectDir, gitPath));
      if (inHead && !inWorkingTree) return emit({ verdict: 'changed-locally' });
      return emit({ verdict: 'on-origin' });
    }

    // The last commit that touched the path. Empty output = the path never
    // existed on this branch (never pushed) — distinct from a real deletion.
    const removingCommit = (await git.raw(['log', '-1', '--format=%H', ref, '--', gitPath])).trim();
    if (removingCommit === '') return emit({ verdict: 'never-on-branch' });

    // Diff the removing commit against its FIRST parent explicitly. A bare
    // `diff-tree <commit>` on a merge commit emits combined-diff format (one
    // status column per parent), which `parseNameStatus` can't read — so a path
    // removed via a merge would misclassify. `<commit>^1 <commit>` forces the
    // standard single-status format and is equivalent to the bare form for
    // ordinary single-parent commits. A removal only ever reachable through the
    // second parent falls through to the honest `deleted` verdict.
    const nameStatus = await git.raw([
      'diff-tree',
      '-M',
      '-r',
      '--no-commit-id',
      '--name-status',
      `${removingCommit}^1`,
      removingCommit,
    ]);
    const rows = parseNameStatus(nameStatus);
    const classified =
      kind === 'folder' ? classifyFolder(rows, gitPath) : classifyDoc(rows, gitPath);

    // Chained rename guard: a redirect is only offered if its destination
    // actually resolves at the origin ref — otherwise degrade to deleted.
    if (classified.verdict === 'renamed') {
      const redirectExists = await git
        .raw(['cat-file', '-e', `${ref}:${classified.renamedTo}`])
        .then(() => true)
        .catch(() => false);
      if (!redirectExists) return emit({ verdict: 'deleted' });
    }
    return emit(classified);
  } catch (err) {
    // Git broke mid-detection — fail-open rather than guess.
    log.warn(
      { action: 'target-status', kind, error: truncateError(err) },
      'target-status detection failed',
    );
    return emit({ verdict: 'unknown' });
  }
}
