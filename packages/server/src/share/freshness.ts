import type { ShareFreshness } from '@inkeep/open-knowledge-core';
import { truncateError } from '../error-format.ts';
import { createGitInstance } from '../git-handle.ts';
import { getLogger } from '../logger.ts';

const FRESHNESS_PROBE_TIMEOUT_MS = 5_000;

export async function computeShareFreshness(
  projectDir: string,
  branch: string,
  gitPath: string,
  kind: 'doc' | 'folder',
): Promise<ShareFreshness | undefined> {
  try {
    const { git } = createGitInstance(projectDir, {
      timeoutMs: FRESHNESS_PROBE_TIMEOUT_MS,
      credentialConfig: [],
    });
    const ref = `refs/remotes/origin/${branch}`;

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

    if (!present) {
      if (kind === 'folder' && trackedDiff.trim() === '' && untracked.trim() === '') return 'empty';
      return 'absent';
    }
    if (trackedDiff.trim() !== '' || untracked.trim() !== '') return 'stale';
    return 'current';
  } catch (err) {
    const truncated = truncateError(err);
    getLogger('share').warn(
      { action: 'freshness-probe-failed', kind, error: truncated },
      '[share] freshness probe failed; omitting freshness',
    );
    return undefined;
  }
}
