
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export interface LinkedWorktreeHandle {
  repoRoot: string;
  worktreePath: string;
  worktreeGitdir: string;
  branch: string;
  cleanup: () => void;
}

export interface CreateLinkedWorktreeOptions {
  branch?: string;
  seedOkScaffold?: boolean;
  prefix?: string;
}

export function createLinkedWorktree(opts: CreateLinkedWorktreeOptions = {}): LinkedWorktreeHandle {
  const prefix = opts.prefix ?? 'ok-wt-test';
  const repoRoot = mkdtempSync(resolve(tmpdir(), `${prefix}-repo-`));

  execFileSync('git', ['init', '--initial-branch=main', repoRoot], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
  writeFileSync(resolve(repoRoot, 'README.md'), '# test\n');
  execFileSync('git', ['-C', repoRoot, 'add', '.']);
  execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'init']);

  const worktreePath = mkdtempSync(resolve(tmpdir(), `${prefix}-tree-`));
  rmSync(worktreePath, { recursive: true, force: true });
  const branch = opts.branch ?? `feat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath]);

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
