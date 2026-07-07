import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  classifyRecentGit,
  classifyRecentGitAsync,
  clearRecentGitCache,
  readWorktreeBranch,
  readWorktreeBranchAsync,
} from './worktree-recents.ts';

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' };

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: GIT_ENV });
}

interface Handle {
  readonly root: string;
  readonly mainRepo: string;
  readonly worktree: string;
  cleanup(): void;
}

async function makeRepoWithWorktree(): Promise<Handle> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-recents-test-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);
  await git(mainRepo, 'init', '--initial-branch=main', '.');
  await git(mainRepo, 'config', 'user.email', 'test@example.com');
  await git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  await git(mainRepo, 'add', '-A');
  await git(mainRepo, 'commit', '-m', 'initial');
  const worktree = join(root, 'wt', 'feature');
  mkdirSync(join(root, 'wt'), { recursive: true });
  await git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);
  return {
    root,
    mainRepo,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('classifyRecentGit', () => {
  let handle: Handle | null = null;
  beforeEach(() => clearRecentGitCache());
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('main worktree: same repo, not linked', async () => {
    handle = await makeRepoWithWorktree();
    const info = classifyRecentGit(handle.mainRepo);
    expect(info.gitCommonDir).toBe(join(handle.mainRepo, '.git'));
    expect(info.mainRoot).toBe(handle.mainRepo);
    expect(info.isLinkedWorktree).toBe(false);
  });

  test('linked worktree: shares the main repo common-dir + main root, flagged linked', async () => {
    handle = await makeRepoWithWorktree();
    const info = classifyRecentGit(handle.worktree);
    expect(info.gitCommonDir).toBe(join(handle.mainRepo, '.git'));
    expect(info.mainRoot).toBe(handle.mainRepo);
    expect(info.isLinkedWorktree).toBe(true);
  });

  test('main + linked worktree share the same gitCommonDir (grouping key)', async () => {
    handle = await makeRepoWithWorktree();
    const main = classifyRecentGit(handle.mainRepo);
    const linked = classifyRecentGit(handle.worktree);
    expect(main.gitCommonDir).toBe(linked.gitCommonDir);
  });

  test('non-git dir → empty classification', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-recents-nogit-')));
    try {
      const info = classifyRecentGit(tmp);
      expect(info.gitCommonDir).toBeNull();
      expect(info.mainRoot).toBeNull();
      expect(info.isLinkedWorktree).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-absolute path → empty', () => {
    expect(classifyRecentGit('relative/path').gitCommonDir).toBeNull();
  });

  test('result is memoized per path (cache hit after clear + recompute)', async () => {
    handle = await makeRepoWithWorktree();
    const first = classifyRecentGit(handle.mainRepo);
    const second = classifyRecentGit(handle.mainRepo);
    // Same object identity → served from cache.
    expect(first).toBe(second);
  });
});

describe('readWorktreeBranch', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('main worktree returns its branch', async () => {
    handle = await makeRepoWithWorktree();
    expect(readWorktreeBranch(handle.mainRepo)).toBe('main');
  });

  test('linked worktree returns its branch', async () => {
    handle = await makeRepoWithWorktree();
    expect(readWorktreeBranch(handle.worktree)).toBe('feature');
  });

  test('resolves up from a SUBDIRECTORY of a worktree (the OK-subtree case)', async () => {
    handle = await makeRepoWithWorktree();
    // A nested dir with no `.git` of its own — the raw `<path>/.git/HEAD` reader
    // fails here, but git walks up to the worktree's real gitdir.
    const subdir = join(handle.worktree, 'public', 'open-knowledge');
    mkdirSync(subdir, { recursive: true });
    expect(readWorktreeBranch(subdir)).toBe('feature');
  });

  test('detached HEAD → null', async () => {
    handle = await makeRepoWithWorktree();
    await git(handle.worktree, 'checkout', '--detach', 'HEAD');
    expect(readWorktreeBranch(handle.worktree)).toBeNull();
  });

  test('non-git dir → null', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-branch-nogit-')));
    try {
      expect(readWorktreeBranch(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-absolute path → null', () => {
    expect(readWorktreeBranch('relative/path')).toBeNull();
  });
});

describe('classifyRecentGitAsync', () => {
  let handle: Handle | null = null;
  beforeEach(() => clearRecentGitCache());
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('main worktree: same repo, not linked', async () => {
    handle = await makeRepoWithWorktree();
    const info = await classifyRecentGitAsync(handle.mainRepo);
    expect(info.gitCommonDir).toBe(join(handle.mainRepo, '.git'));
    expect(info.mainRoot).toBe(handle.mainRepo);
    expect(info.isLinkedWorktree).toBe(false);
  });

  test('linked worktree: shares common-dir + main root, flagged linked', async () => {
    handle = await makeRepoWithWorktree();
    const info = await classifyRecentGitAsync(handle.worktree);
    expect(info.gitCommonDir).toBe(join(handle.mainRepo, '.git'));
    expect(info.mainRoot).toBe(handle.mainRepo);
    expect(info.isLinkedWorktree).toBe(true);
  });

  test('non-git dir → empty classification', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-recents-async-nogit-')));
    try {
      const info = await classifyRecentGitAsync(tmp);
      expect(info.gitCommonDir).toBeNull();
      expect(info.mainRoot).toBeNull();
      expect(info.isLinkedWorktree).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-absolute path → empty', async () => {
    expect((await classifyRecentGitAsync('relative/path')).gitCommonDir).toBeNull();
  });

  test('matches the sync variant for the same path', async () => {
    handle = await makeRepoWithWorktree();
    const sync = classifyRecentGit(handle.worktree);
    clearRecentGitCache();
    const async = await classifyRecentGitAsync(handle.worktree);
    expect(async).toEqual(sync);
  });

  test('shares the memo with the sync variant (sync populate → async cache hit)', async () => {
    handle = await makeRepoWithWorktree();
    // Sync call populates the shared memo; the async call must return that same
    // cached object identity rather than re-spawning git.
    const seeded = classifyRecentGit(handle.mainRepo);
    const fromAsync = await classifyRecentGitAsync(handle.mainRepo);
    expect(fromAsync).toBe(seeded);
  });

  test('result is memoized across async calls (same object identity)', async () => {
    handle = await makeRepoWithWorktree();
    const first = await classifyRecentGitAsync(handle.mainRepo);
    const second = await classifyRecentGitAsync(handle.mainRepo);
    expect(first).toBe(second);
  });
});

describe('readWorktreeBranchAsync', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('main worktree returns its branch', async () => {
    handle = await makeRepoWithWorktree();
    expect(await readWorktreeBranchAsync(handle.mainRepo)).toBe('main');
  });

  test('linked worktree returns its branch', async () => {
    handle = await makeRepoWithWorktree();
    expect(await readWorktreeBranchAsync(handle.worktree)).toBe('feature');
  });

  test('resolves up from a SUBDIRECTORY of a worktree (the OK-subtree case)', async () => {
    handle = await makeRepoWithWorktree();
    const subdir = join(handle.worktree, 'public', 'open-knowledge');
    mkdirSync(subdir, { recursive: true });
    expect(await readWorktreeBranchAsync(subdir)).toBe('feature');
  });

  test('detached HEAD → null', async () => {
    handle = await makeRepoWithWorktree();
    await git(handle.worktree, 'checkout', '--detach', 'HEAD');
    expect(await readWorktreeBranchAsync(handle.worktree)).toBeNull();
  });

  test('non-git dir → null', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-branch-async-nogit-')));
    try {
      expect(await readWorktreeBranchAsync(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-absolute path → null', async () => {
    expect(await readWorktreeBranchAsync('relative/path')).toBeNull();
  });

  test('matches the sync variant for the same path', async () => {
    handle = await makeRepoWithWorktree();
    expect(await readWorktreeBranchAsync(handle.worktree)).toBe(
      readWorktreeBranch(handle.worktree),
    );
  });
});
