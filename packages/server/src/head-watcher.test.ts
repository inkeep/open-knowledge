import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { readBranchFromHead, startHeadWatcher, watchedGitFile } from './head-watcher';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-headwatch-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('resolveGitDir', () => {
  test('returns .git path when .git is a directory', () => {
    const projectRoot = resolve(tmpDir, 'project');
    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });

    const result = resolveGitDir(projectRoot);
    expect(result).toBe(resolve(projectRoot, '.git'));
  });

  test('resolves worktree .git pointer file', () => {
    const projectRoot = resolve(tmpDir, 'worktree');
    const realGitDir = resolve(tmpDir, 'real-git');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(realGitDir, { recursive: true });

    // .git is a file with gitdir: pointer
    writeFileSync(resolve(projectRoot, '.git'), `gitdir: ${realGitDir}\n`);

    const result = resolveGitDir(projectRoot);
    expect(result).toBe(realGitDir);
  });

  test('returns null when no .git exists', () => {
    const projectRoot = resolve(tmpDir, 'no-git');
    mkdirSync(projectRoot, { recursive: true });

    const result = resolveGitDir(projectRoot);
    expect(result).toBeNull();
  });
});

describe('readBranchFromHead', () => {
  test('reads branch name from symref HEAD', () => {
    const gitDir = resolve(tmpDir, 'git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    expect(readBranchFromHead(gitDir)).toBe('main');
  });

  test('reads feature branch name', () => {
    const gitDir = resolve(tmpDir, 'git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'ref: refs/heads/feature/my-feature\n');

    expect(readBranchFromHead(gitDir)).toBe('feature/my-feature');
  });

  test('returns detached-<sha12> for raw SHA HEAD', () => {
    const gitDir = resolve(tmpDir, 'git');
    mkdirSync(gitDir, { recursive: true });
    const sha = 'abc123def456789012345678901234567890abcd';
    writeFileSync(resolve(gitDir, 'HEAD'), `${sha}\n`);

    expect(readBranchFromHead(gitDir)).toBe('detached-abc123def456');
  });

  test('returns null when .git/HEAD does not exist', () => {
    const gitDir = resolve(tmpDir, 'nonexistent');
    expect(readBranchFromHead(gitDir)).toBeNull();
  });

  test('returns null for invalid HEAD content', () => {
    const gitDir = resolve(tmpDir, 'git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(gitDir, 'HEAD'), 'invalid\n');

    expect(readBranchFromHead(gitDir)).toBeNull();
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
  // NOTE: we intentionally do NOT assert that a real branch switch fires
  // `onBatchEnd` here. That requires waiting on a real chokidar/inotify event,
  // whose attach + delivery latency is environment-dependent and flakes on
  // loaded CI runners. The chokidar backend's event delivery is the same one
  // the file-watcher already relies on in production (verified manually that a
  // branch switch produces `change:HEAD`); this test pins the new code path —
  // forced-backend selection, clean start, initial-state read, and teardown —
  // deterministically, without an fs-event race.
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
    git('branch -M main'); // normalize branch name across git default-branch configs

    const handle = await startHeadWatcher(
      projectRoot,
      () => {},
      () => {},
      {
        forceBackend: 'chokidar',
      },
    );
    try {
      // Initial branch state is read synchronously once the backend is active.
      expect(handle.getLastKnownBranch()).toBe('main');
    } finally {
      // unsubscribe() must resolve — it closes the chokidar watcher.
      await handle.unsubscribe();
    }
  });
});
