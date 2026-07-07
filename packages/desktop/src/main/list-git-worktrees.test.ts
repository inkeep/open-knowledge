import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listGitWorktrees } from './list-git-worktrees.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

interface TestRepoHandle {
  readonly root: string;
  readonly mainRepo: string;
  readonly worktrees: Map<string, string>;
  cleanup(): void;
}

/**
 * Build a tmpdir containing a main repo and N linked worktrees on freshly-
 * created branches. Each worktree gets a single committed file so HEAD has a
 * real SHA. Returns realpath-resolved paths to avoid macOS `/private/var/...`
 * vs `/var/...` mismatches when comparing against the impl's output.
 */
async function makeRepoWithWorktrees(branches: string[]): Promise<TestRepoHandle> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'list-git-wt-test-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);

  await git(mainRepo, 'init', '--initial-branch=main', '.');
  await git(mainRepo, 'config', 'user.email', 'test@example.com');
  await git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  await git(mainRepo, 'add', 'README.md');
  await git(mainRepo, 'commit', '-m', 'initial');

  const worktrees = new Map<string, string>();
  for (const branch of branches) {
    const wt = join(root, 'wt', branch);
    mkdirSync(join(root, 'wt'), { recursive: true });
    await git(mainRepo, 'worktree', 'add', '-b', branch, wt);
    worktrees.set(branch, wt);
  }

  return {
    root,
    mainRepo,
    worktrees,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('listGitWorktrees', () => {
  let handle: TestRepoHandle | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('enumerates main repo + linked worktrees from an anchor inside main', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo', 'feat-bar']);
    const entries = await listGitWorktrees(handle.mainRepo);

    expect(entries).toHaveLength(3);
    const byBranch = new Map(entries.map((e) => [e.branch, e]));
    expect(byBranch.get('main')?.path).toBe(handle.mainRepo);
    expect(byBranch.get('feat-foo')?.path).toBe(handle.worktrees.get('feat-foo'));
    expect(byBranch.get('feat-bar')?.path).toBe(handle.worktrees.get('feat-bar'));
    for (const e of entries) {
      expect(e.headSha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(e.locked).toBe(false);
      expect(e.prunable).toBe(false);
    }
  });

  test('enumeration works from anchor inside a linked worktree (not just main)', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo']);
    const fromWorktree = await listGitWorktrees(handle.worktrees.get('feat-foo') as string);
    expect(fromWorktree).toHaveLength(2);
    expect(new Set(fromWorktree.map((e) => e.branch))).toEqual(new Set(['main', 'feat-foo']));
  });

  test('locked worktrees surface locked: true (FR8)', async () => {
    handle = await makeRepoWithWorktrees(['feat-locked']);
    await git(handle.mainRepo, 'worktree', 'lock', handle.worktrees.get('feat-locked') as string);

    const entries = await listGitWorktrees(handle.mainRepo);
    const locked = entries.find((e) => e.branch === 'feat-locked');
    expect(locked?.locked).toBe(true);
    // Unlock so cleanup can rmSync the worktree dir
    await git(handle.mainRepo, 'worktree', 'unlock', handle.worktrees.get('feat-locked') as string);
  });

  test('slashed branch name round-trips intact (FR11)', async () => {
    handle = await makeRepoWithWorktrees(['feat/foo/bar']);
    const entries = await listGitWorktrees(handle.mainRepo);
    const slashed = entries.find((e) => e.path === handle?.worktrees.get('feat/foo/bar'));
    expect(slashed?.branch).toBe('feat/foo/bar');
  });

  test('symlinked anchor collapses to realpath identity (FR10)', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo']);
    const symlinkPath = join(handle.root, 'main-symlink');
    symlinkSync(handle.mainRepo, symlinkPath);
    const entries = await listGitWorktrees(symlinkPath);
    // The symlinked anchor should still resolve to the canonical mainRepo path.
    expect(entries.find((e) => e.branch === 'main')?.path).toBe(handle.mainRepo);
  });

  test('non-git anchor returns [] (does not throw)', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'list-git-wt-empty-')));
    try {
      const entries = await listGitWorktrees(tmp);
      expect(entries).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-absolute anchor returns [] (defensive)', async () => {
    const entries = await listGitWorktrees('relative/path');
    expect(entries).toEqual([]);
  });

  test('non-existent anchor returns []', async () => {
    const entries = await listGitWorktrees(resolve(`/tmp/does-not-exist-yet-${Date.now()}`));
    expect(entries).toEqual([]);
  });
});
