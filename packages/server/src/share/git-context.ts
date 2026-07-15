/**
 * Read-only inspector for the local git state required by
 * `POST /api/share/construct-url`: HEAD branch, origin URL, and the
 * `refs/remotes/origin/<branch>` ref existence.
 *
 * All reads target `.git/` directly via filesystem APIs rather than spawning
 * `git` subprocesses — the share button has a sub-100ms p95 budget and a
 * three-subprocess hop would dominate on slower machines. Branch-existence is
 * local-only against `refs/remotes/origin/<branch>` (loose form) with a
 * packed-refs fallback; no `git ls-remote`.
 *
 * The github-origin parser here is intentionally narrower than
 * `parseGitUrl` in `packages/cli/src/github/url.ts` — it covers only the four
 * URL forms produced by real GitHub/GHES clones (https, ssh://, scp-style,
 * git://), not the cli grammar's shorthand forms. It stays a server-local
 * parser because the cli depends on `@inkeep/open-knowledge-server` — importing
 * the cli's parser here would create a cycle.
 *
 * Host classification follows the cli's `validateGitHubHost` philosophy:
 * GHES hostnames are arbitrary, so any parseable origin whose host is not a
 * known non-GitHub forge (`KNOWN_NON_GITHUB_GIT_HOSTS`) is treated as a
 * GitHub host and carries its `host` in the result. Known forges (gitlab,
 * bitbucket, …) classify as `non-github` so callers surface the matching
 * toast.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { KNOWN_NON_GITHUB_GIT_HOSTS } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

const log = getLogger('git-context');

/** Outcome of `readOriginGitHubRepo`. */
export type OriginResult =
  | { kind: 'ok'; host: string; owner: string; repo: string }
  | { kind: 'no-remote' }
  | { kind: 'non-github' };

/**
 * Resolve the absolute git directory for a project. Handles both the common
 * `<project>/.git/` directory layout and worktrees where `<project>/.git`
 * is a file containing `gitdir: <absolute-or-relative-path>`.
 *
 * For a linked worktree the returned dir holds per-worktree state (`HEAD`)
 * but NOT `config` / `refs/remotes/` — those live in the shared common dir.
 * Reads of those must go through `resolveCommonDir`; otherwise a
 * worktree project reports `no-remote` even when origin is configured.
 */
function resolveGitDir(projectDir: string): string | null {
  const gitPath = resolve(projectDir, '.git');
  if (!existsSync(gitPath)) return null;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) return gitPath;

  if (stat.isFile()) {
    let contents: string;
    try {
      contents = readFileSync(gitPath, 'utf-8');
    } catch {
      return null;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(contents.trim());
    if (!match) return null;
    const rawTarget = match[1].trim();
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(projectDir, rawTarget);
    return existsSync(target) ? target : null;
  }

  return null;
}

/**
 * Resolve the shared common git dir for `config` + `refs/remotes/` reads. In a
 * linked worktree the git dir holds a `commondir` file pointing at the main
 * `.git` (path is relative to the worktree git dir, occasionally absolute);
 * the origin config and remote-tracking refs live there, not in the worktree
 * git dir. For a non-worktree git dir there is no `commondir` file and the git
 * dir itself is the common dir.
 */
function resolveCommonDir(gitDir: string): string {
  const pointer = join(gitDir, 'commondir');
  if (!existsSync(pointer)) return gitDir;
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
 * Read `.git/HEAD` and return the symbolic-ref branch name. Returns null for
 * a detached HEAD (raw SHA), a missing HEAD file, or any read failure.
 */
export function readGitHeadBranch(projectDir: string): string | null {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return null;
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;
  let head: string;
  try {
    head = readFileSync(headPath, 'utf-8');
  } catch {
    return null;
  }
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim());
  return match ? match[1] : null;
}

/**
 * Strip git-config inline comments (`;` or `#`) and surrounding whitespace.
 * `;` and `#` are both valid comment characters in git's `*.config` grammar.
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
 * of a git config file. Returns null when the section is absent, has no
 * `url` line, or the config is malformed.
 */
export function extractOriginUrl(configContents: string): string | null {
  let inOriginRemote = false;
  for (const rawLine of configContents.split(/\r?\n/)) {
    const line = stripCommentAndTrim(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      // Match `[remote "origin"]` with arbitrary internal whitespace and
      // either single or double quotes (git accepts both). Kept in sync
      // with the sibling parsers in
      // `packages/desktop/src/main/git-remote.ts` and
      // `packages/cli/src/github/folder-validator.ts` — see
      // `packages/desktop/tests/main/git-config-parser-parity.test.ts`.
      inOriginRemote = /^\[\s*remote\s+["']origin["']\s*\]$/.test(line);
      continue;
    }
    if (!inOriginRemote) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return value;
  }
  return null;
}

/** Parsed origin repo: normalized host + owner/repo path segments. */
interface ParsedOriginRepo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Lowercase, strip a trailing `:port`, and fold `www.github.com` →
 * `github.com`. Ports are dropped because every downstream consumer (token
 * relay via `gh auth token --hostname`, the `/api/v3` probe base, browse
 * URLs) addresses the host by name.
 */
function normalizeGitHost(rawHost: string): string {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

/**
 * Match a GitHub-host origin URL (github.com or GHES) and return
 * `{host, owner, repo}`. Returns null for known non-GitHub forges
 * (`KNOWN_NON_GITHUB_GIT_HOSTS`) and unparseable strings. Unknown hosts are
 * presumed GitHub; the downstream probe/token paths degrade gracefully when
 * one turns out not to be.
 */
function parseGitHubOriginUrl(originUrl: string): ParsedOriginRepo | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  const classify = (host: string, owner: string, repo: string): ParsedOriginRepo | null => {
    const normalized = normalizeGitHost(host);
    if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) return null;
    return { host: normalized, owner, repo };
  };

  // https://<host>[:port]/<owner>/<repo>(.git)?
  let m = /^https?:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3]);

  // ssh://[user@]<host>[:port]/<owner>/<repo>(.git)?
  m = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
    raw,
  );
  if (m) return classify(m[1], m[2], m[3]);

  // <user>@<host>:<owner>/<repo>(.git)?  (scp-style; `@` is required, so
  // Windows drive paths like `C:\x` can never match)
  m = /^[\w.-]+@([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3]);

  // git://<host>[:port]/<owner>/<repo>(.git)?
  m = /^git:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3]);

  return null;
}

/**
 * Shared `.git/config` → origin-URL pipeline for the two public origin
 * readers: resolve the git dir, read `config`, extract the origin URL,
 * and classify it as github (owner/repo) or not. Returns null when there is
 * no readable origin URL. Centralizing the read here keeps future
 * config-resolution changes (worktree config, `[includeIf]`, error handling)
 * in one place instead of drifting across two callers.
 */
function readParsedOrigin(
  projectDir: string,
): { originUrl: string; github: ParsedOriginRepo | null } | null {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return null;
  // Origin config lives in the common dir, which differs from `gitDir` for a
  // linked worktree (where `gitDir` has no `config` of its own).
  const configPath = join(resolveCommonDir(gitDir), 'config');
  if (!existsSync(configPath)) return null;
  let configContents: string;
  try {
    configContents = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  const originUrl = extractOriginUrl(configContents);
  if (!originUrl) return null;
  return { originUrl, github: parseGitHubOriginUrl(originUrl) };
}

/**
 * Read `.git/config`, locate `[remote "origin"]`, and classify the URL.
 * Returns `ok` (with the origin `host` — `github.com` or a GHES hostname)
 * for GitHub-host origins, `non-github` for known non-GitHub forges (gitlab,
 * bitbucket, ...) and unparseable URLs, `no-remote` when no origin URL is
 * configured.
 */
export function readOriginGitHubRepo(projectDir: string): OriginResult {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return { kind: 'no-remote' };
  if (parsed.github) {
    const { host, owner, repo } = parsed.github;
    return { kind: 'ok', host, owner, repo };
  }
  // Origin URL present but a known non-GitHub forge or unparseable — surface
  // as `non-github` so the caller renders the matching toast.
  return { kind: 'non-github' };
}

/**
 * The workspace origin's GitHub host (github.com or GHES), falling back to
 * github.com when there is no parseable GitHub origin. Single source of the
 * "which host do auth surfaces target by default" rule — the local-op auth
 * relay and the CLI `--host` defaults both call this. Never throws (all
 * `.git` reads underneath are individually guarded): the CLI evaluates it
 * at command registration, where a throw would break every invocation.
 */
export function originGitHubHost(projectDir: string): string {
  const origin = readOriginGitHubRepo(projectDir);
  if (origin.kind === 'ok') return origin.host;
  log.debug(
    { kind: origin.kind },
    '[git-context] origin is not a GitHub host — falling back to github.com',
  );
  return 'github.com';
}

/**
 * UI-facing summary of the origin remote for the sync-status payload.
 * `webUrl` is non-null for GitHub-host origins — github.com AND GHES (the
 * Sync UI renders it as a link); known non-GitHub forges yield a readable
 * `label` with no link.
 */
export interface SyncRemoteInfo {
  label: string;
  webUrl: string | null;
}

/**
 * Resolve the origin remote into a display label + optional browse URL.
 * Reads `.git/config` directly (no subprocess), so it is safe to call from
 * the synchronous sync-status path. Returns null when no origin URL is set.
 */
export function readSyncRemoteInfo(projectDir: string): SyncRemoteInfo | null {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return null;
  if (parsed.github) {
    const { host, owner, repo } = parsed.github;
    return {
      // Enterprise hosts keep the host in the label; github.com stays terse.
      label: host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`,
      webUrl: `https://${host}/${owner}/${repo}`,
    };
  }
  // Non-github origin: show a readable host/path label, never linkified.
  return { label: labelFromNonGitHubUrl(parsed.originUrl), webUrl: null };
}

/**
 * Best-effort readable label for a non-github origin URL: strip credentials,
 * scheme, and a trailing `.git`, leaving `host/path` (scp-like
 * `git@host:group/repo` becomes `host/group/repo`). Display-only.
 */
function labelFromNonGitHubUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`;
  // `*` (not `?`) so multiple `@`-terminated userinfo segments are all
  // stripped — e.g. `https://user:p@ss@host/...` won't leak `ss@host`.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)*(.+)$/i.exec(trimmed);
  if (scheme) return scheme[1];
  return trimmed;
}

/**
 * Return true if `<projectDir>/.git/refs/remotes/origin/<branch>` exists
 * (loose ref) OR `packed-refs` contains an entry for
 * `refs/remotes/origin/<branch>`. Local-only — no network call.
 *
 * False-negative window: the user's last `git fetch` ran before they pushed
 * the branch. The toast prompts them to push, they push, fetch isn't
 * required for share (the local ref is updated as a side effect of `push`),
 * the retry succeeds. Acceptable by contract.
 */
export function branchExistsOnOrigin(projectDir: string, branch: string): boolean {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return false;
  // Remote-tracking refs + packed-refs live in the common dir, shared across
  // worktrees — not in a linked worktree's own git dir.
  const commonDir = resolveCommonDir(gitDir);

  const loosePath = join(commonDir, 'refs', 'remotes', 'origin', branch);
  if (existsSync(loosePath)) return true;

  const packedPath = join(commonDir, 'packed-refs');
  if (!existsSync(packedPath)) return false;
  let packed: string;
  try {
    packed = readFileSync(packedPath, 'utf-8');
  } catch {
    return false;
  }
  const target = `refs/remotes/origin/${branch}`;
  for (const rawLine of packed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue;
    const parts = line.split(/\s+/);
    if (parts.length === 2 && parts[1] === target) return true;
  }
  return false;
}
