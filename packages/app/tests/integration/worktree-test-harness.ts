/**
 * Helper for tests that need a real linked git worktree (`.git` is a pointer
 * file, not a directory). Wraps the `git init` → commit → `git worktree add`
 * ceremony so tests can focus on what changes vs. the main-worktree path.
 *
 * The handle's `cleanup()` removes BOTH the worktree path and the source repo
 * — call it in `afterEach` to keep `/tmp` from filling up during a long
 * concurrent test run.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export interface LinkedWorktreeHandle {
  /** Source repo (where `.git/` is a real directory). */
  repoRoot: string;
  /** Linked worktree path (where `.git` is a pointer file). */
  worktreePath: string;
  /** Resolved gitdir for the worktree, e.g. `<repoRoot>/.git/worktrees/<name>`. */
  worktreeGitdir: string;
  /** Branch name the worktree was created on. */
  branch: string;
  cleanup: () => void;
}

export interface CreateLinkedWorktreeOptions {
  /** Branch name for the worktree. Defaults to `wt-<timestamp>`. */
  branch?: string;
  /**
   * If true, scaffolds `<wt>/.ok/{config.yml,.gitignore}` so `bootServer`'s
   * pre-listen check passes. Tests that need to exercise State A/B/C set
   * this to false and create the desired files themselves.
   */
  seedOkScaffold?: boolean;
  /** Optional prefix for the source-repo tmpdir name. */
  prefix?: string;
}

export function createLinkedWorktree(opts: CreateLinkedWorktreeOptions = {}): LinkedWorktreeHandle {
  const prefix = opts.prefix ?? 'ok-wt-test';
  const repoRoot = mkdtempSync(resolve(tmpdir(), `${prefix}-repo-`));

  // Initial commit so `git worktree add` can resolve a HEAD.
  execFileSync('git', ['init', '--initial-branch=main', repoRoot], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
  writeFileSync(resolve(repoRoot, 'README.md'), '# test\n');
  execFileSync('git', ['-C', repoRoot, 'add', '.']);
  execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'init']);

  const worktreePath = mkdtempSync(resolve(tmpdir(), `${prefix}-tree-`));
  // git worktree add wants the path to NOT pre-exist
  rmSync(worktreePath, { recursive: true, force: true });
  const branch = opts.branch ?? `feat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath]);

  // The worktree's gitdir lives under the source repo's `.git/worktrees/<name>/`.
  // `git worktree add <wtPath>` may sanitize the basename, so derive the name
  // by listing the worktrees admin dir; with a fresh repo it's the only entry.
  const worktreesDir = resolve(repoRoot, '.git/worktrees');
  const adminEntries = readdirSync(worktreesDir);
  const adminName = adminEntries[0];
  if (!adminName) {
    throw new Error(
      `createLinkedWorktree: expected exactly one entry under ${worktreesDir} after git worktree add`,
    );
  }
  const worktreeGitdir = resolve(worktreesDir, adminName);

  if (opts.seedOkScaffold) {
    const okDir = resolve(worktreePath, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
  }

  return {
    repoRoot,
    worktreePath,
    worktreeGitdir,
    branch,
    cleanup: () => {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
