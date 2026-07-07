/**
 * Classify a recent project's git-worktree relationship so the renderer can
 * nest linked worktrees under their main project. Two paths are worktrees of the same repo iff they share an absolute
 * `git rev-parse --git-common-dir`; the one whose top-level equals the repo's
 * main root is the main worktree, the rest are linked.
 *
 * One git spawn per path (`rev-parse` returns top-level + common-dir in a
 * single call), memoized by realpath: the common-dir / main-root of a path is
 * stable, so subsequent `list-recent` calls hit the cache (the branch label is
 * read separately + fresh, since it changes on checkout). Fails soft — a
 * non-git or unreadable path yields the empty classification, never a throw.
 *
 * Sync and async twins coexist. The async variants (`classifyRecentGitAsync`,
 * `readWorktreeBranchAsync`) share the same realpath memo and behavior as the
 * sync ones — they exist so the `list-recent` IPC handler can await a
 * `Promise.all` and fan its cold git spawns out concurrently rather than
 * blocking the main event loop one spawn at a time. `openProject` still calls
 * the sync `classifyRecentGit` (one lookup, already off any hot path).
 */

import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const GIT_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C' } as const;

const execFileAsync = promisify(execFile);

export interface RecentGitInfo {
  /** Absolute `<mainRoot>/.git` shared by all worktrees of the repo, or null. */
  readonly gitCommonDir: string | null;
  /** Absolute main-worktree root of the repo, or null when not a git repo. */
  readonly mainRoot: string | null;
  /** This path is a linked worktree (not the repo's main worktree). */
  readonly isLinkedWorktree: boolean;
}

const EMPTY: RecentGitInfo = { gitCommonDir: null, mainRoot: null, isLinkedWorktree: false };

// Keyed by realpath — the common-dir/main-root of a path don't change.
const cache = new Map<string, RecentGitInfo>();

/** Clear the memo (tests, or after a worktree add/remove changes the topology). */
export function clearRecentGitCache(): void {
  cache.clear();
}

/**
 * Fresh (non-memoized) branch label for a recent. Resolved via git rather than a
 * raw `<path>/.git/HEAD` read so it works when the project was opened at a git
 * SUBDIRECTORY — e.g. the OK subtree of a worktree, where `<path>/.git` doesn't
 * exist but `git rev-parse` walks up to the worktree's real gitdir. Returns the
 * short branch name, or null on detached HEAD / non-git / error. Kept out of the
 * `classifyRecentGit` memo because the branch changes on checkout.
 */
export function readWorktreeBranch(projectPath: string): string | null {
  if (!isAbsolute(projectPath)) return null;
  try {
    const out = String(
      execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: projectPath,
        env: GIT_ENV,
      }),
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    // Detached HEAD (symbolic-ref exits non-zero), non-git dir, or missing path.
    return null;
  }
}

/**
 * Async twin of `readWorktreeBranch` — same git args + parsing, `execFile`
 * instead of `execFileSync` so the caller can await it off the event loop. The
 * `list-recent` IPC handler awaits a `Promise.all` of these so its ~40 cold git
 * spawns run concurrently instead of blocking the main process one at a time.
 * Un-memoized for the same reason as the sync one — the branch changes on
 * checkout.
 */
export async function readWorktreeBranchAsync(projectPath: string): Promise<string | null> {
  if (!isAbsolute(projectPath)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: projectPath,
      env: GIT_ENV,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    // Detached HEAD (symbolic-ref exits non-zero), non-git dir, or missing path.
    return null;
  }
}

/**
 * Return the git-worktree relationship for `projectPath`. Memoized by realpath.
 */
export function classifyRecentGit(projectPath: string): RecentGitInfo {
  if (!isAbsolute(projectPath)) return EMPTY;
  let key: string;
  try {
    key = realpathSync(projectPath);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const info = computeRecentGit(key);
  cache.set(key, info);
  return info;
}

/**
 * Async twin of `classifyRecentGit` — same realpath memo (shared `cache` Map,
 * cleared by the same `clearRecentGitCache`), same git call + parsing, just
 * awaited so the `list-recent` handler can fan the spawns out concurrently.
 * A value computed by either path serves the other on the next hit.
 */
export async function classifyRecentGitAsync(projectPath: string): Promise<RecentGitInfo> {
  if (!isAbsolute(projectPath)) return EMPTY;
  let key: string;
  try {
    key = realpathSync(projectPath);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const info = await computeRecentGitAsync(key);
  cache.set(key, info);
  return info;
}

const REV_PARSE_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-common-dir',
] as const;

function computeRecentGit(realPath: string): RecentGitInfo {
  let out: string;
  try {
    out = String(execFileSync('git', [...REV_PARSE_ARGS], { cwd: realPath, env: GIT_ENV }));
  } catch {
    return EMPTY;
  }
  return parseRevParse(out);
}

async function computeRecentGitAsync(realPath: string): Promise<RecentGitInfo> {
  let out: string;
  try {
    const { stdout } = await execFileAsync('git', [...REV_PARSE_ARGS], {
      cwd: realPath,
      env: GIT_ENV,
    });
    out = stdout;
  } catch {
    return EMPTY;
  }
  return parseRevParse(out);
}

function parseRevParse(out: string): RecentGitInfo {
  const [topLevelRaw, commonDirRaw] = out.split('\n');
  const topLevel = topLevelRaw?.trim();
  const commonDir = commonDirRaw?.trim();
  if (!topLevel || !commonDir) return EMPTY;

  // `<mainRoot>/.git` for a normal repo (main + linked worktrees alike). When
  // the common dir isn't a `.git` child (bare repo, relocated gitdir), fall
  // back to the top-level so grouping still keys on a real directory.
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : topLevel;
  const isLinkedWorktree = realpathEq(topLevel, mainRoot) === false;
  return { gitCommonDir: commonDir, mainRoot, isLinkedWorktree };
}

function realpathEq(a: string, b: string): boolean {
  const ra = safeRealpath(a);
  const rb = safeRealpath(b);
  return resolve(ra) === resolve(rb);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
