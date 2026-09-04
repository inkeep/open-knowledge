import { statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { classifyGitHubShareHost } from '@inkeep/open-knowledge-core';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';
import { parseGitUrl } from './url.ts';

export type ShareFolderValidationResult =
  | { kind: 'ok'; gitRemoteUrl: string }
  | { kind: 'not-git' }
  | { kind: 'no-origin' }
  | { kind: 'wrong-repo'; actualOwner: string; actualRepo: string }
  | { kind: 'wrong-host'; actualHost: string }
  | { kind: 'non-github' }
  | { kind: 'symlink-escape' };

/*
 * WARN: mirrors `ExpectedShareRepo` in `@inkeep/open-knowledge-core`. Nothing
 * fails when the two drift; they must move together.
 */
export interface ExpectedShareRepo {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export async function validateLocalFolderForShare(
  folderPath: string,
  expected: ExpectedShareRepo,
): Promise<ShareFolderValidationResult> {
  let realFolder: string;
  let realParent: string;
  try {
    realFolder = await realpath(resolve(folderPath));
    realParent = await realpath(resolve(dirname(folderPath)));
  } catch {
    return { kind: 'not-git' };
  }
  if (!isDescendantOrEqual(realFolder, realParent)) {
    return { kind: 'symlink-escape' };
  }

  const dotGit = join(realFolder, '.git');
  let dotGitStat: ReturnType<typeof statSync>;
  try {
    dotGitStat = statSync(dotGit);
  } catch {
    return { kind: 'not-git' };
  }

  if (dotGitStat.isDirectory()) {
    let realDotGit: string;
    try {
      realDotGit = await realpath(dotGit);
    } catch {
      return { kind: 'not-git' };
    }
    if (!isDescendantOrEqual(realDotGit, realFolder)) {
      return { kind: 'symlink-escape' };
    }
  } else if (!dotGitStat.isFile()) {
    return { kind: 'not-git' };
  }

  const inspected = inspectGitRepository(realFolder);
  if (inspected.kind !== 'repository') {
    return { kind: 'not-git' };
  }
  const origin = inspected.repository.readRemoteUrl('origin');
  if (origin.kind === 'unreadable') return { kind: 'not-git' };
  if (origin.kind === 'absent') {
    return origin.reason === 'config-missing' ? { kind: 'not-git' } : { kind: 'no-origin' };
  }
  const originUrl = origin.url;

  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return { kind: 'non-github' };
  const foldedHost = classifyGitHubShareHost(parsed.hostname);
  if (foldedHost === null) return { kind: 'non-github' };

  const hostMatch = foldedHost === expected.host.toLowerCase();
  const ownerMatch = parsed.owner.toLowerCase() === expected.owner.toLowerCase();
  const repoMatch = parsed.name.toLowerCase() === expected.repo.toLowerCase();
  if (!hostMatch && ownerMatch && repoMatch) {
    return { kind: 'wrong-host', actualHost: foldedHost };
  }
  if (!hostMatch || !ownerMatch || !repoMatch) {
    return { kind: 'wrong-repo', actualOwner: parsed.owner, actualRepo: parsed.name };
  }

  return {
    kind: 'ok',
    gitRemoteUrl: `https://${foldedHost}/${parsed.owner}/${parsed.name}.git`,
  };
}

function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}
