/**
 * Read the canonical GitHub remote URL for a project, used to backfill
 * `RecentProject.gitRemoteUrl` on every project open so the share-receive
 * lookup finds previously opened projects by `{owner, repo}`.
 *
 * Why not shell out to `git config --get`: backfill runs synchronously on
 * the boot hot path. A spawn round-trip is ~30-50ms on macOS; the file
 * read is sub-millisecond. The downside — we ignore git's includeIf /
 * conditional includes — is acceptable here because `[remote "origin"]`
 * lives in the repo's common `.git/config`, never in a parent include. For a
 * linked worktree that common config is reached via the gitdir's `commondir`
 * pointer — the worktree's own gitdir holds HEAD but no `config`.
 *
 * Why re-emit canonical form: senders may have cloned via SSH
 * (`git@github.com:owner/repo.git`) while receivers via HTTPS — both must
 * normalize to one URL for the string compare to hit.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseGitUrl } from '@inkeep/open-knowledge';

/**
 * Best-effort: returns the canonical GitHub remote URL for the project
 * at `projectPath`, or `null` if the project has no `.git/config`, no
 * `[remote "origin"]`, or a non-github.com origin. Never throws — any
 * I/O or parse error returns `null` so callers can fall through silently
 * (the field stays undefined, the user pays a one-time cost on first
 * share-receive for this project).
 *
 * Handles git worktrees: when `.git` is a regular file containing
 * `gitdir: <path>`, follow the pointer to the worktree gitdir and then to
 * the shared common dir (via the gitdir's `commondir` pointer), where the
 * origin config actually lives — a linked worktree's gitdir holds HEAD but
 * no `config`. Without this, every worktree user silently misses the
 * share-receive lookup. Mirrors the worktree handling in `git-context.ts`
 * (`resolveGitDir` + `resolveCommonDir`).
 */
export function readCanonicalGitHubRemoteUrl(projectPath: string): string | null {
  const gitDir = resolveGitDir(projectPath);
  if (gitDir === null) return null;
  let raw: string;
  try {
    // Origin config lives in the shared common dir, which differs from the
    // resolved git dir for a linked worktree (whose gitdir has no `config`).
    raw = readFileSync(join(resolveCommonDir(gitDir), 'config'), 'utf-8');
  } catch {
    return null;
  }
  const originUrl = extractOriginUrl(raw);
  if (originUrl === null) return null;
  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return null;
  if (parsed.hostname !== 'github.com') return null;
  return `https://github.com/${parsed.owner}/${parsed.name}.git`;
}

/**
 * Resolve `<projectPath>/.git` to the gitdir holding the actual `config`
 * file. For a primary checkout `.git` is itself the dir; for a worktree
 * `.git` is a file whose contents are `gitdir: <path>` (absolute or
 * relative-to-projectPath). Returns `null` on any I/O or parse error.
 */
function resolveGitDir(projectPath: string): string | null {
  const dotGit = join(projectPath, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
  if (!match) return null;
  const target = match[1].trim();
  return isAbsolute(target) ? target : resolve(projectPath, target);
}

/**
 * Resolve the shared common git dir, where `config` lives. A linked worktree's
 * gitdir holds a `commondir` file pointing at the main `.git` (relative to the
 * gitdir, occasionally absolute); a primary checkout has no `commondir` and is
 * its own common dir. Returns `gitDir` unchanged on any read/parse failure.
 */
function resolveCommonDir(gitDir: string): string {
  const pointer = join(gitDir, 'commondir');
  let contents: string;
  try {
    contents = readFileSync(pointer, 'utf-8').trim();
  } catch {
    return gitDir;
  }
  if (contents.length === 0) return gitDir;
  return isAbsolute(contents) ? contents : resolve(gitDir, contents);
}

/**
 * Parse `[remote "origin"] url = ...` out of a git-config INI blob.
 * Tolerates indented values, comments, quoted values, and CRLF line
 * endings. Returns the first matching `url` line in the `[remote
 * "origin"]` section, or `null` if absent.
 *
 * Exported for testing — production callers go through
 * `readCanonicalGitHubRemoteUrl`. Aligned with the sibling parsers in
 * `packages/server/src/share/git-context.ts` and
 * `packages/cli/src/github/folder-validator.ts` — a cross-package parser
 * parity contract.
 */
export function extractOriginUrl(configBlob: string): string | null {
  let inOriginSection = false;
  for (const rawLine of configBlob.split(/\r?\n/)) {
    const line = stripCommentAndTrim(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      // Match `[remote "origin"]` with arbitrary internal whitespace and
      // either single or double quotes (git accepts both).
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

function stripCommentAndTrim(line: string): string {
  // git-config treats `;` and `#` as comment markers. Quoted segments
  // are out of scope for the remote.origin case so a naive split is fine.
  const indexes = [line.indexOf('#'), line.indexOf(';')].filter((i) => i >= 0);
  if (indexes.length === 0) return line.trim();
  const idx = Math.min(...indexes);
  return line.slice(0, idx).trim();
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
