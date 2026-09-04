import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { truncateError } from '../error-format.ts';
import { createGitInstance } from '../git-handle.ts';
import { listNameStatus, type NameStatusRow } from '../git-paths.ts';
import { getLogger } from '../logger.ts';

export const SHARE_TARGET_STATUS_HANDLER_TAG = 'share-target-status';

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function classifyDoc(rows: NameStatusRow[], gitPath: string): ShareTargetStatusResponse {
  for (const row of rows) {
    if (row.from !== gitPath) continue;
    if (row.status.startsWith('R')) return { verdict: 'renamed', renamedTo: row.to };
    if (row.status === 'D') return { verdict: 'deleted' };
  }
  return { verdict: 'deleted' };
}

function classifyFolder(rows: NameStatusRow[], folderPath: string): ShareTargetStatusResponse {
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

export async function computeShareTargetStatus(
  projectDir: string,
  branch: string,
  gitPath: string,
  kind: 'doc' | 'folder',
  opts: { skipFetch?: boolean; fetchTimeoutMs?: number; credentialConfig: string[] },
): Promise<ShareTargetStatusResponse> {
  const log = getLogger('share');
  const emit = (result: ShareTargetStatusResponse): ShareTargetStatusResponse => {
    log.info({ action: 'target-status', verdict: result.verdict, kind }, 'target-status verdict');
    return result;
  };

  const { git } = createGitInstance(
    projectDir,
    opts.skipFetch
      ? { credentialConfig: [] }
      : {
          timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
          credentialConfig: opts.credentialConfig,
        },
  );

  if (!opts.skipFetch) {
    try {
      await git.raw(['fetch', 'origin', branch]);
    } catch (err) {
      log.warn(
        { action: 'target-status', kind, error: truncateError(err) },
        'target-status fetch failed',
      );
      return emit({ verdict: 'unknown' });
    }
  }

  const ref = `origin/${branch}`;
  try {
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

    const removingCommit = (await git.raw(['log', '-1', '--format=%H', ref, '--', gitPath])).trim();
    if (removingCommit === '') return emit({ verdict: 'never-on-branch' });

    const rows = await listNameStatus(git, [
      'diff-tree',
      '-M',
      '-r',
      '--no-commit-id',
      '--name-status',
      `${removingCommit}^1`,
      removingCommit,
    ]);
    const classified =
      kind === 'folder' ? classifyFolder(rows, gitPath) : classifyDoc(rows, gitPath);

    if (classified.verdict === 'renamed') {
      const redirectExists = await git
        .raw(['cat-file', '-e', `${ref}:${classified.renamedTo}`])
        .then(() => true)
        .catch(() => false);
      if (!redirectExists) return emit({ verdict: 'deleted' });
    }
    return emit(classified);
  } catch (err) {
    log.warn(
      { action: 'target-status', kind, error: truncateError(err) },
      'target-status detection failed',
    );
    return emit({ verdict: 'unknown' });
  }
}
