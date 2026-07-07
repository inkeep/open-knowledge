/**
 * Validate that a user-picked folder is a clone of the GitHub repo a share
 * URL points at — drives the "I have it locally →" path on the in-OK receive
 * dialog. The receive dialog calls this
 * after the user picks a folder; on `kind: 'ok'` it registers the folder as
 * a `RecentProject` (with the canonical `gitRemoteUrl`) and opens the doc.
 *
 * Symlink discipline mirrors `discoverProject` in
 * `packages/desktop/src/main/folder-admission.ts`: realpath canonicalize,
 * then verify the picked folder hasn't escaped via a symlink that resolves
 * outside its apparent parent. A `.git` directory that symlinks outside the
 * realpath'd folder is also rejected — the AC's "FR security, inherits OK
 * Worktree pointers (`.git` is a regular file
 * containing `gitdir: <path>`) are exempt from the inside-folder check —
 * legitimate worktrees ALWAYS point at a separate gitdir outside the
 * worktree folder.
 *
 * Owner / repo comparison is case-insensitive: GitHub URLs accept any case
 * combination (`/Inkeep/Open-Knowledge` and `/inkeep/open-knowledge` resolve
 * to the same repo), so a clone whose origin uses different case from the
 * share URL must still match.
 */

import { statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseGitUrl } from './url.ts';

/** Outcome of `validateLocalFolderForShare`. Discriminated by `kind`. */
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

/**
 * Read the repo's `config` (`<folderPath>/.git/config` for a primary checkout;
 * for a git-worktree pointer, the shared common dir's config reached via the
 * worktree gitdir's `commondir` — a linked worktree's gitdir holds no `config`
 * of its own), parse `[remote "origin"]`, and classify against the expected
 * `{owner, repo}` from the share URL.
 *
 * Never throws — every filesystem or parse failure maps to a structured
 * result kind so the caller can render a friendly toast.
 */
export async function validateLocalFolderForShare(
  folderPath: string,
  expected: ExpectedShareRepo,
): Promise<ShareFolderValidationResult> {
  // 1. Realpath-canonicalize the picked folder; verify it didn't escape via
  //    a symlink. Mirrors `discoverProject`'s symlink-escape check.
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

  // 2. Locate `.git` (directory in the common case; regular file pointing at
  //    the gitdir for git worktrees).
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
    // `.git` directory must live inside the realpath'd folder; a `.git` symlink
    // that escapes (e.g., to `/etc/passwd`) is rejected so we don't mis-parse
    // an arbitrary file as a git config.
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

  // 3. Read git config + locate `[remote "origin"]` URL. For a linked worktree
  //    `gitDir` has no `config` of its own — it lives in the shared common dir,
  //    reached via the gitdir's `commondir` pointer.
  const configPath = join(await resolveCommonDir(gitDir), 'config');
  let configContents: string;
  try {
    configContents = await readFile(configPath, 'utf-8');
  } catch {
    return { kind: 'not-git' };
  }
  const originUrl = extractOriginUrl(configContents);
  if (originUrl === null) return { kind: 'no-origin' };

  // 4. Parse origin via the shared `parseGitUrl`. Anything we can't parse
  //    OR that points off-github lands as `non-github` — same downstream
  //    surface (the receive dialog renders the "switch your remote" toast).
  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return { kind: 'non-github' };
  if (parsed.hostname !== 'github.com') return { kind: 'non-github' };

  // 5. Compare owner/repo case-insensitively (GitHub URL semantics).
  const ownerMatch = parsed.owner.toLowerCase() === expected.owner.toLowerCase();
  const repoMatch = parsed.name.toLowerCase() === expected.repo.toLowerCase();
  if (!ownerMatch || !repoMatch) {
    return { kind: 'wrong-repo', actualOwner: parsed.owner, actualRepo: parsed.name };
  }

  // 6. Re-emit canonical HTTPS form so the caller's `RecentProject.gitRemoteUrl`
  //    matches the form readCanonicalGitHubRemoteUrl writes elsewhere — both
  //    SSH and HTTPS clones converge on one lookup key.
  return {
    kind: 'ok',
    gitRemoteUrl: `https://github.com/${parsed.owner}/${parsed.name}.git`,
  };
}

/**
 * Resolve the shared common git dir, where `config` lives. A linked worktree's
 * gitdir carries a `commondir` file pointing at the main `.git` (relative to
 * the gitdir, occasionally absolute); a primary checkout has no `commondir`
 * and is its own common dir. Returns `gitDir` unchanged on any read failure.
 */
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

/**
 * `relative(parent, child)` returns `''` for equal paths, a `..`-prefixed
 * string when `child` sits outside `parent`, and a non-`..` relative path
 * when child is a descendant. The early `child === parent` short-circuit is
 * defensive for trailing-slash / OS-quirk equality.
 */
function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Strip git-config inline comments (`;` or `#`) and surrounding whitespace.
 * Both characters are valid comment markers in git's `*.config` grammar; the
 * shape of `[remote "origin"]` URLs (no semicolons, no hashes) means the
 * naive split is safe here.
 */
function stripCommentAndTrim(line: string): string {
  const hashIdx = line.indexOf('#');
  const semiIdx = line.indexOf(';');
  let cutAt = -1;
  if (hashIdx >= 0 && semiIdx >= 0) cutAt = Math.min(hashIdx, semiIdx);
  else if (hashIdx >= 0) cutAt = hashIdx;
  else if (semiIdx >= 0) cutAt = semiIdx;
  return (cutAt === -1 ? line : line.slice(0, cutAt)).trim();
}

/**
 * Extract the first `url = ...` value from the `[remote "origin"]` section
 * of a git config file. Returns null when the section is absent or has no
 * `url` line. Tolerates indented values, comments, quoted values, and CRLF
 * line endings.
 */
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
