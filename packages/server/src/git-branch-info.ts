/**
 * Helpers for `GET /api/git/branch-info` — single-round-trip view of git
 * state the share-receive branch-switch dialog consumes.
 *
 * Pure functions on the project's git directory; no `withParentLock` because
 * every operation is a read. All four git probes are issued in parallel via
 * `Promise.all` to keep the dialog dependency under the P99 budget.
 */

import { isValidBranchName } from '@inkeep/open-knowledge-core';
import { truncateError } from './error-format.ts';
import { type DirtyOverlapResult, dirtyFilesOverlapWith } from './git-dirty.ts';
import { createGitInstance } from './git-handle.ts';

// Re-export from core so existing callers (`api-extension.ts`,
// `git-branch-info.test.ts`) keep their import paths. Single source of
// truth for the seven-rule contract lives in `packages/core/src/schemas/api/share.ts`.
export { isValidBranchName };

/**
 * Server-side mirror of `BranchInfoResponse`'s discriminated union (keyed on
 * `detached`). The wire schema in `packages/core/src/schemas/api/share.ts`
 * is the canonical contract — keep both variants here in lockstep so the
 * `successResponse(..., BranchInfoResponseSchema, info)` validation cannot
 * reject a value `computeBranchInfo` returns.
 */
export type BranchInfo =
  | {
      detached: false;
      currentBranch: string | null;
      currentHeadSha: null;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
      shareTargetOnOriginBranch?: boolean;
    }
  | {
      detached: true;
      currentBranch: null;
      currentHeadSha: string;
      shareTargetExists: boolean;
      dirtyConflicts: DirtyOverlapResult;
      branchIsLocal: boolean;
      shareTargetOnOriginBranch?: boolean;
    };

/**
 * Whitelist for the `path` query parameter. Forward-slash separated only —
 * matches the wire contract `buildGitHubBlobUrl` / `buildGitHubTreeUrl` emit
 * (`path.split('/')`). Rejects any backslash in the input so a `\`-bearing
 * share URL cannot bypass the segment gate and reach
 * `git cat-file -e <ref>:<path>` with an anomalous ref-spec.
 *
 * Kind-aware, mirroring `isValidSharePath`: the empty path is the folder-root
 * sentinel, valid only when `kind === 'folder'`; a doc always names a file so
 * empty is rejected for `kind === 'doc'`.
 *
 * Otherwise rejects: leading `/`, any `\`, control chars, `..` segment,
 * `.git` segment, empty segment (consecutive slashes).
 */
export function isValidBranchInfoPath(path: unknown, kind: 'doc' | 'folder'): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return kind === 'folder';
  if (path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  for (const segment of path.split('/')) {
    if (segment.length === 0) return false;
    if (segment === '..' || segment === '.git') return false;
  }
  return true;
}

/**
 * Compute `BranchInfo` for `projectDir`, `targetBranch`, and `path`.
 *
 * `kind` discriminates the share-target existence probe: a folder share with
 * an empty `path` targets the content root, whose tree always exists — so
 * the probe is skipped and `shareTargetExists` is `true`. Every other case
 * (`doc`, or a non-empty folder path) runs the type-agnostic
 * `git cat-file -e <ref>:<path>` probe, which resolves both blob and tree
 * objects.
 *
 * Throws if `projectDir` is not a git checkout (the underlying `rev-parse
 * --git-dir` propagates). Callers map the throw to a 500 envelope so the
 * dialog can fall back gracefully.
 */
export async function computeBranchInfo(
  projectDir: string,
  targetBranch: string,
  path: string,
  kind: 'doc' | 'folder',
): Promise<BranchInfo> {
  const { git } = createGitInstance(projectDir);

  // Fail-fast on non-git directories so the downstream Promise.all doesn't
  // swallow "not a git repository" errors via the per-probe catch handlers.
  await git.raw(['rev-parse', '--git-dir']);

  // simple-git's `raw` only rejects when stderr is non-empty; the `--quiet`
  // flag on `symbolic-ref` and `rev-parse --verify` would suppress stderr
  // and make a missing-ref or detached-HEAD look like an empty-stdout
  // success. Omit `--quiet` so the rejection path is the one we branch on.
  const headStatePromise = (async (): Promise<
    | { detached: false; currentBranch: string | null; currentHeadSha: null }
    | { detached: true; currentBranch: null; currentHeadSha: string }
  > => {
    try {
      const ref = (await git.raw(['symbolic-ref', 'HEAD'])).trim();
      const match = /^refs\/heads\/(.+)$/.exec(ref);
      const branch = match ? match[1] : null;
      return { detached: false, currentBranch: branch, currentHeadSha: null };
    } catch {
      // Detached HEAD — symbolic-ref exits non-zero; resolve the raw SHA
      // and report the 7-char prefix as the dialog label. If rev-parse
      // returns an empty string (corrupted repo), fall back to the named-
      // branch sentinel — the schema requires `currentHeadSha: string` on
      // the detached variant, so an empty SHA can't be paired with
      // `detached: true`.
      const sha = (await git.raw(['rev-parse', '--short=7', 'HEAD'])).trim();
      if (sha.length === 0) {
        return { detached: false, currentBranch: null, currentHeadSha: null };
      }
      return { detached: true, currentBranch: null, currentHeadSha: sha };
    }
  })();

  const shareTargetPromise = headStatePromise.then(async (head) => {
    // Folder root: the content-root tree exists on every ref, so skip the
    // probe entirely (a `cat-file -e <ref>:` with an empty path is malformed).
    if (kind === 'folder' && path === '') return true;
    const ref = head.detached ? 'HEAD' : head.currentBranch;
    if (!ref) return false;
    try {
      await git.raw(['cat-file', '-e', `${ref}:${path}`]);
      return true;
    } catch {
      return false;
    }
  });

  const branchIsLocalPromise = git
    .raw(['rev-parse', '--verify', `refs/heads/${targetBranch}`])
    .then(() => true)
    .catch(() => false);

  // Additive HINT for the branch-switch dialog: does the share target exist at
  // `origin/<targetBranch>` per the local remote-tracking ref? Network-free —
  // the fetch that would refresh a stale ref belongs to target-status, not this
  // fast-path endpoint. `undefined` when the remote-tracking ref isn't present
  // locally (the answer is genuinely unknown until a fetch), which the dialog
  // treats the same as `false`: a hint to ask target-status, never a denial.
  const shareTargetOnOriginBranchPromise = (async (): Promise<boolean | undefined> => {
    const originRef = `origin/${targetBranch}`;
    const refPresent = await git
      .raw(['rev-parse', '--verify', originRef])
      .then(() => true)
      .catch(() => false);
    if (!refPresent) return undefined;
    // A folder-root share targets the content-root tree, which exists on every ref.
    if (kind === 'folder' && path === '') return true;
    return git
      .raw(['cat-file', '-e', `${originRef}:${path}`])
      .then(() => true)
      .catch(() => false);
  })();

  // dirtyFilesOverlapWith throws when targetBranch isn't resolvable (e.g.
  // the share branch is not local yet). The dialog still needs the other
  // fields, so surface a no-conflict result in that case; the
  // `branchIsLocal: false` field carries the missing-locally signal.
  //
  // Narrow the swallow to git's branch-resolution failures
  // ("unknown revision" / "bad revision" / "ambiguous argument") — the
  // legitimate "target ref doesn't exist locally yet" path. Disk I/O,
  // git-binary-missing, and other unexpected failures shape stderr
  // differently and propagate to the caller instead of being silently
  // misclassified as "no conflict" (which would let a switch attempt
  // proceed on stale info and surprise the user with a real failure
  // mid-checkout).
  const dirtyPromise = dirtyFilesOverlapWith(projectDir, targetBranch).catch(
    (err: unknown): DirtyOverlapResult => {
      if (isBranchResolutionError(err)) return { conflicts: false, files: [] };
      // Log + degrade gracefully. The dialog still renders; the lack of a
      // conflict signal is preferable to crashing the whole branch-info
      // endpoint when only one of its four probes fails for an unrelated
      // reason (the other three may still be intact).
      const truncated = truncateError(err);
      console.warn(
        `[git-branch-info] action=dirty-overlap-failed branch=${targetBranch} error=${truncated}`,
      );
      return { conflicts: false, files: [] };
    },
  );

  const [headState, shareTargetExists, branchIsLocal, dirtyConflicts, shareTargetOnOriginBranch] =
    await Promise.all([
      headStatePromise,
      shareTargetPromise,
      branchIsLocalPromise,
      dirtyPromise,
      shareTargetOnOriginBranchPromise,
    ]);

  if (headState.detached) {
    return {
      detached: true,
      currentBranch: null,
      currentHeadSha: headState.currentHeadSha,
      shareTargetExists,
      dirtyConflicts,
      branchIsLocal,
      shareTargetOnOriginBranch,
    };
  }
  return {
    detached: false,
    currentBranch: headState.currentBranch,
    currentHeadSha: null,
    shareTargetExists,
    dirtyConflicts,
    branchIsLocal,
    shareTargetOnOriginBranch,
  };
}

/** Single source of truth for the handler tag used in logs + telemetry. */
export const BRANCH_INFO_HANDLER_TAG = 'git-branch-info';

/**
 * Returns true when a thrown error looks like git's "this ref doesn't
 * resolve locally" failure — the legitimate signal that the target branch
 * isn't checked out yet. simple-git surfaces git's stderr verbatim:
 *
 *   - `fatal: ambiguous argument 'HEAD..<ref>': unknown revision`
 *   - `fatal: bad revision 'HEAD..<ref>'`
 *
 * Any other error shape (disk I/O, git binary missing, partial fetch
 * mid-write) flows through to the caller's log + degrade path so it
 * doesn't get silently classified as "no conflict".
 *
 * Exported for unit testing — the narrow check is load-bearing (a mis-scoped
 * match would silently classify a real error as "no conflict"), and a
 * regression test pins the message-shape match.
 */
export function isBranchResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown revision|bad revision|ambiguous argument/i.test(message);
}
