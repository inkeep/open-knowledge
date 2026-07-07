/**
 * Send-side freshness probe for `POST /api/share/construct-url`: does the
 * shared target match what origin has? Three local-only git reads against
 * `refs/remotes/origin/<branch>` — never a fetch — run in parallel and combine
 * into `current` / `stale` / `absent`.
 *
 * simple-git's `raw` rejects on non-empty stderr, not on exit code (see
 * `git-branch-info.ts`), so the exit-1 `diff --quiet` from the verified recipe
 * cannot be branched on here — `diff --name-only` carries the same "does the
 * working tree differ from the ref" signal in stdout instead. `cat-file -e`
 * DOES reject (its miss writes stderr), so a fail-fast `rev-parse` of the ref
 * first lets a later `cat-file` rejection mean "path absent" rather than "git
 * broke"; the broken-git case throws past the probes and omits freshness.
 */
import type { ShareFreshness } from '@inkeep/open-knowledge-core';
import { truncateError } from '../error-format.ts';
import { createGitInstance } from '../git-handle.ts';
import { getLogger } from '../logger.ts';

/**
 * Block timeout for the local freshness reads. They are local-only (no fetch),
 * so this never fires in normal use; it backstops a pathologically stuck git
 * (huge repo, index-lock contention) from blocking the interactive Share click
 * with no wall-clock bound. A timeout throws past the probes → freshness omitted
 * (fail-open), matching the target-status fetch's block-timeout precedent.
 */
const FRESHNESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Compute freshness for the shared target at `gitPath` (repo-root-relative)
 * against `refs/remotes/origin/<branch>`. Returns `undefined` — the field is
 * omitted — whenever any probe fails, so a probe never turns a working share
 * into a broken one (fail-open); the caller ships the URL regardless.
 *
 * `gitPath === ''` is the content-root folder share: the empty path is the
 * root tree for the existence probe (`<ref>:`), but an empty pathspec is fatal
 * to `diff` / `status`, which fall back to `.`.
 */
export async function computeShareFreshness(
  projectDir: string,
  branch: string,
  gitPath: string,
  kind: 'doc' | 'folder',
): Promise<ShareFreshness | undefined> {
  try {
    const { git } = createGitInstance(projectDir, { timeoutMs: FRESHNESS_PROBE_TIMEOUT_MS });
    const ref = `refs/remotes/origin/${branch}`;

    // Fail-fast: the git binary works AND the remote-tracking ref resolves.
    // After this, a `cat-file` rejection can only mean the path is absent from
    // the ref — not that git itself failed.
    await git.raw(['rev-parse', '--verify', ref]);

    const pathspec = gitPath === '' ? '.' : gitPath;

    const [present, trackedDiff, untracked] = await Promise.all([
      git
        .raw(['cat-file', '-e', `${ref}:${gitPath}`])
        .then(() => true)
        .catch(() => false),
      git.raw(['diff', '--name-only', ref, '--', pathspec]),
      git.raw(['status', '--porcelain', '--untracked-files=all', '--', pathspec]),
    ]);

    if (!present) return 'absent';
    // Tracked drift (committed-unpushed or uncommitted) surfaces in the diff;
    // a brand-new untracked file beneath a shared folder surfaces only in
    // status. Either makes the recipient's copy differ from what they'd see.
    if (trackedDiff.trim() !== '' || untracked.trim() !== '') return 'stale';
    return 'current';
  } catch (err) {
    // Keep the error identity (bounded) so a "freshness always missing" report
    // can be triaged — matching the truncated-message pattern the sibling
    // git-branch-info / git-checkout fail-open catches use.
    const truncated = truncateError(err);
    getLogger('share').warn(
      { action: 'freshness-probe-failed', kind, error: truncated },
      '[share] freshness probe failed; omitting freshness',
    );
    return undefined;
  }
}
