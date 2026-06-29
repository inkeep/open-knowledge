
import { statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseGitUrl } from './url.ts';

export type ShareFolderValidationResult =
  | { kind: 'ok'; gitRemoteUrl: string }
  | { kind: 'not-git' }
  | { kind: 'no-origin' }
  | { kind: 'wrong-repo'; actualOwner: string; actualRepo: string }
  | { kind: 'non-github' }
  | { kind: 'symlink-escape' };

export interface ExpectedShareRepo {
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

  let gitDir: string;
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
    gitDir = realDotGit;
  } else if (dotGitStat.isFile()) {
    let pointerContents: string;
    try {
      pointerContents = await readFile(dotGit, 'utf-8');
    } catch {
      return { kind: 'not-git' };
    }
    const match = /^gitdir:\s*(.+)$/m.exec(pointerContents.trim());
    if (!match) return { kind: 'not-git' };
    const target = match[1].trim();
    const absoluteTarget = isAbsolute(target) ? target : resolve(realFolder, target);
    try {
      gitDir = await realpath(absoluteTarget);
    } catch {
      return { kind: 'not-git' };
    }
  } else {
    return { kind: 'not-git' };
  }

  const configPath = join(await resolveCommonDir(gitDir), 'config');
  let configContents: string;
  try {
    configContents = await readFile(configPath, 'utf-8');
  } catch {
    return { kind: 'not-git' };
  }
  const originUrl = extractOriginUrl(configContents);
  if (originUrl === null) return { kind: 'no-origin' };

  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return { kind: 'non-github' };
  if (parsed.hostname !== 'github.com') return { kind: 'non-github' };

  const ownerMatch = parsed.owner.toLowerCase() === expected.owner.toLowerCase();
  const repoMatch = parsed.name.toLowerCase() === expected.repo.toLowerCase();
  if (!ownerMatch || !repoMatch) {
    return { kind: 'wrong-repo', actualOwner: parsed.owner, actualRepo: parsed.name };
  }

  return {
    kind: 'ok',
    gitRemoteUrl: `https://github.com/${parsed.owner}/${parsed.name}.git`,
  };
}

async function resolveCommonDir(gitDir: string): Promise<string> {
  let contents: string;
  try {
    contents = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim();
  } catch {
    return gitDir;
  }
  if (contents.length === 0) return gitDir;
  const resolved = isAbsolute(contents) ? contents : resolve(gitDir, contents);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function stripCommentAndTrim(line: string): string {
  const hashIdx = line.indexOf('#');
  const semiIdx = line.indexOf(';');
  let cutAt = -1;
  if (hashIdx >= 0 && semiIdx >= 0) cutAt = Math.min(hashIdx, semiIdx);
  else if (hashIdx >= 0) cutAt = hashIdx;
  else if (semiIdx >= 0) cutAt = semiIdx;
  return (cutAt === -1 ? line : line.slice(0, cutAt)).trim();
}

export function extractOriginUrl(configContents: string): string | null {
  let inOriginSection = false;
  for (const rawLine of configContents.split(/\r?\n/)) {
    const line = stripCommentAndTrim(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      inOriginSection = /^\[\s*remote\s+["']origin["']\s*\]$/.test(line);
      continue;
    }
    if (!inOriginSection) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    return unquote(m[1]);
  }
  return null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
