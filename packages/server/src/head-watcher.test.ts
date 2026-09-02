import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readProjectHeadState, startHeadWatcher, watchedGitFile } from './head-watcher';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-headwatch-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('readProjectHeadState', () => {
  test('reads branch name from symref HEAD', () => {
    const projectRoot = resolve(tmpDir, 'project');
    const gitDir = resolve(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    expect(readProjectHeadState(projectRoot)).toEqual({ branch: 'main', oid: null });
  });

  test('reads feature branch name', () => {
    const projectRoot = resolve(tmpDir, 'project');
    const gitDir = resolve(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'ref: refs/heads/feature/my-feature\n');

    expect(readProjectHeadState(projectRoot)).toEqual({
      branch: 'feature/my-feature',
      oid: null,
    });
  });

  test('returns detached-<sha12> for raw SHA HEAD', () => {
    const projectRoot = resolve(tmpDir, 'project');
    const gitDir = resolve(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });
    const sha = 'abc123def456789012345678901234567890abcd';
    writeFileSync(resolve(gitDir, 'HEAD'), `${sha}\n`);

    expect(readProjectHeadState(projectRoot)).toEqual({
      branch: 'detached-abc123def456',
      oid: sha,
    });
  });

  test('returns null when .git/HEAD does not exist', () => {
    const projectRoot = resolve(tmpDir, 'project');
    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });
    expect(readProjectHeadState(projectRoot)).toEqual({ branch: null, oid: null });
  });

  test('returns null for invalid HEAD content', () => {
    const projectRoot = resolve(tmpDir, 'project');
    const gitDir = resolve(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'invalid\n');

    expect(readProjectHeadState(projectRoot)).toEqual({ branch: null, oid: null });
  });

  test('reads a linked worktree branch oid from the common packed refs', () => {
    const projectRoot = resolve(tmpDir, 'worktree');
    const commonDir = resolve(tmpDir, 'main', '.git');
    const gitDir = resolve(commonDir, 'worktrees', 'feature');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(projectRoot, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(resolve(gitDir, 'commondir'), '../..\n');
    writeFileSync(resolve(gitDir, 'HEAD'), 'ref: refs/heads/feature/deep-inspection\n');
    writeFileSync(
      resolve(commonDir, 'packed-refs'),
      '0123456789abcdef0123456789abcdef01234567 refs/heads/feature/deep-inspection\n',
    );

    expect(readProjectHeadState(projectRoot)).toEqual({
      branch: 'feature/deep-inspection',
      oid: '0123456789abcdef0123456789abcdef01234567',
    });
  });
});

describe('watchedGitFile', () => {
  test('returns the basename for watched .git ref files', () => {
    expect(watchedGitFile('/x/.git/HEAD')).toBe('HEAD');
    expect(watchedGitFile('/x/.git/ORIG_HEAD')).toBe('ORIG_HEAD');
    expect(watchedGitFile('/x/.git/MERGE_HEAD')).toBe('MERGE_HEAD');
    expect(watchedGitFile('/x/.git/index.lock')).toBe('index.lock');
  });

  test('returns null for paths outside the watched set', () => {
    expect(watchedGitFile('/x/.git/config')).toBeNull();
    expect(watchedGitFile('/x/.git/objects/ab/cdef')).toBeNull();
    expect(watchedGitFile('')).toBeNull();
  });
});

describe('startHeadWatcher chokidar fallback', () => {
  test('selects the chokidar backend, reads initial state, and tears down cleanly', async () => {
    const projectRoot = resolve(tmpDir, 'repo');
    mkdirSync(projectRoot, { recursive: true });
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectRoot, stdio: 'ignore' });
    git('init -q');
    git('config user.email t@t.co');
    git('config user.name t');
    writeFileSync(resolve(projectRoot, 'a.md'), 'hello\n');
    git('add -A');
    git('commit -qm init');
    git('branch -M main');

    const handle = await startHeadWatcher(
      projectRoot,
      () => {},
      () => {},
      {
        forceBackend: 'chokidar',
      },
    );
    try {
      expect(handle.getLastKnownBranch()).toBe('main');
    } finally {
      await handle.unsubscribe();
    }
  });
});

describe('startHeadWatcher batch serialization', () => {
  test('queues a second HEAD batch until the first branch-switch callback settles', async () => {
    const projectRoot = resolve(tmpDir, 'repo');
    mkdirSync(projectRoot, { recursive: true });
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectRoot, stdio: 'ignore' });
    git('init -q');
    git('config user.email t@t.co');
    git('config user.name t');
    writeFileSync(resolve(projectRoot, 'a.md'), 'hello\n');
    git('add -A');
    git('commit -qm init');
    git('branch -M main');
    git('branch feature');
    git('branch second');

    let dispatch!: (rawPath: string) => void;
    let releaseFirst!: () => void;
    const firstCanSettle = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const branches: Array<string | null> = [];
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;

    const handle = await startHeadWatcher(
      projectRoot,
      () => {},
      async (info) => {
        activeCallbacks++;
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
        branches.push(info.newBranch);
        try {
          if (branches.length === 1) await firstCanSettle;
        } finally {
          activeCallbacks--;
        }
      },
      {
        subscribeForTest: async (_gitDir, nextDispatch) => {
          dispatch = nextDispatch;
          return async () => {};
        },
      },
    );

    try {
      git('checkout -q feature');
      dispatch(resolve(projectRoot, '.git', 'HEAD'));
      await vi.waitFor(() => expect(branches).toEqual(['feature']));

      git('checkout -q second');
      dispatch(resolve(projectRoot, '.git', 'HEAD'));
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      expect(branches).toEqual(['feature']);

      releaseFirst();
      await vi.waitFor(() => expect(branches).toEqual(['feature', 'second']));
      expect(maxActiveCallbacks).toBe(1);
    } finally {
      releaseFirst();
      await handle.unsubscribe();
    }
  });
});
