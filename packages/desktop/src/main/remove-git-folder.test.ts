import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { runStop } from '@inkeep/open-knowledge';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { removeGitFolder, stopServerThenRemoveGitFolder } from './remove-git-folder.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-remove-git-')));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe('removeGitFolder — pure helper backing ok:fs:remove-git-folder', () => {
  test('happy path: real .git directory at <gitRoot>/.git is removed', async () => {
    const gitRoot = join(tmpRoot, 'proj');
    mkdirSync(join(gitRoot, '.git', 'objects'), { recursive: true });
    writeFileSync(join(gitRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
    expect(existsSync(gitRoot)).toBe(true);
  });

  test('idempotent: .git already absent → resolves without throwing', async () => {
    const gitRoot = join(tmpRoot, 'proj-no-git');
    mkdirSync(gitRoot, { recursive: true });
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
    expect(existsSync(gitRoot)).toBe(true);
  });

  test('worktree `.git` file (not directory) at <gitRoot>/.git is removed', async () => {
    const gitRoot = join(tmpRoot, 'worktree');
    mkdirSync(gitRoot, { recursive: true });
    writeFileSync(join(gitRoot, '.git'), 'gitdir: /unrelated/worktree-store/wt1\n');

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  describe('input validation rejects malformed gitRoot before any FS work', () => {
    test('empty string', async () => {
      await expect(removeGitFolder('', { allowedGitRoots: new Set() })).rejects.toThrow(
        /must be a non-empty string/,
      );
    });

    test('non-string (object)', async () => {
      await expect(
        removeGitFolder({ rogue: true } as unknown, { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be a non-empty string/);
    });

    test('non-string (null)', async () => {
      await expect(
        removeGitFolder(null as unknown, { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be a non-empty string/);
    });

    test('relative path is refused (must be absolute)', async () => {
      await expect(
        removeGitFolder('relative/path', { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be an absolute, resolved path/);
    });

    test('absolute path with literal `..` segments is refused (must be already-resolved)', async () => {
      const traversal = `${tmpRoot}/proj/../private-stuff`;
      await expect(
        removeGitFolder(traversal, { allowedGitRoots: new Set([traversal]) }),
      ).rejects.toThrow(/must be an absolute, resolved path/);
    });
  });

  test('membership-set miss: a well-formed gitRoot NOT in allowedGitRoots is refused', async () => {
    const gitRoot = join(tmpRoot, 'fabricated');
    mkdirSync(join(gitRoot, '.git'), { recursive: true });

    await expect(removeGitFolder(gitRoot, { allowedGitRoots: new Set() })).rejects.toThrow(
      /was not surfaced by a recent probe/,
    );

    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });

  test('symlink defense: <gitRoot>/.git → unrelated dir is refused, unrelated dir survives', async () => {
    const gitRoot = join(tmpRoot, 'proj-with-rogue-symlink');
    const unrelated = join(tmpRoot, 'important-dir');
    mkdirSync(gitRoot, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    const sentinel = join(unrelated, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete\n');

    symlinkSync(unrelated, join(gitRoot, '.git'), 'dir');

    await expect(removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) })).rejects.toThrow(
      /resolved symlink target is not a \.git entry/,
    );

    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });

  test('symlink defense: <gitRoot>/.git → another /.git directory IS allowed (canonical basename still .git)', async () => {
    const gitRoot = join(tmpRoot, 'proj-with-symlinked-git');
    const realGit = join(tmpRoot, 'real-git-store', '.git');
    mkdirSync(join(tmpRoot, 'real-git-store'), { recursive: true });
    mkdirSync(realGit, { recursive: true });
    writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(gitRoot, { recursive: true });
    symlinkSync(realGit, join(gitRoot, '.git'), 'dir');

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('membership-set is keyed exactly — case-sensitive, no trailing-slash forgiveness', async () => {
    const gitRoot = join(tmpRoot, 'proj-strict');
    mkdirSync(join(gitRoot, '.git'), { recursive: true });

    await expect(
      removeGitFolder(`${gitRoot}/`, { allowedGitRoots: new Set([gitRoot]) }),
    ).rejects.toThrow(/must be an absolute, resolved path/);
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });
});

describe('stopServerThenRemoveGitFolder', () => {
  const notStopped = 'remove-git-folder: the worktree server was not stopped; removing .git anyway';
  let gitRoot: string;
  let lockDir: string;

  beforeEach(() => {
    gitRoot = join(tmpRoot, 'proj');
    lockDir = join(gitRoot, '.ok', 'local');
    mkdirSync(join(gitRoot, '.git', 'objects'), { recursive: true });
  });

  function harness(stop: () => ReturnType<typeof runStop>) {
    const info: Array<{ data: Record<string, unknown>; message: string }> = [];
    const warn: Array<{ data: Record<string, unknown>; message: string }> = [];
    const stopCalls: Array<Parameters<typeof runStop>[0]> = [];
    const deps = {
      allowedGitRoots: new Set([gitRoot]),
      lockDirFor: (root: string) => join(root, '.ok', 'local'),
      runStop: (stopDeps: Parameters<typeof runStop>[0]) => {
        stopCalls.push(stopDeps);
        return stop();
      },
      log: {
        info: (data: Record<string, unknown>, message: string) => info.push({ data, message }),
        warn: (data: Record<string, unknown>, message: string) => warn.push({ data, message }),
      },
    };
    return { info, warn, stopCalls, deps };
  }

  test('removes .git after a refused stop, logging the holder, its lock, the cause and the native failures', async () => {
    const lockPath = join(lockDir, 'server.lock');
    const { info, warn, stopCalls, deps } = harness(async () => ({
      stopped: [],
      failed: [
        {
          target: { name: 'server', pid: 4242 },
          error: 'Could not read when process 4242 started',
          unverified: {
            cause: 'process-start-unreadable',
            pid: 4242,
            lockPath,
            platform: 'win32',
            nativeFailures: [{ kind: 'query-failed', reason: 'Access is denied. (os error 5)' }],
          },
        },
      ],
      hadTargets: true,
    }));

    await stopServerThenRemoveGitFolder(gitRoot, deps);

    expect(stopCalls).toEqual([expect.objectContaining({ lockDir, force: true })]);
    expect(info).toEqual([]);
    expect(warn).toEqual([
      {
        data: {
          gitRoot,
          lockPid: 4242,
          lockPath,
          cause: 'process-start-unreadable',
          nativeFailures: [{ kind: 'query-failed', reason: 'Access is denied. (os error 5)' }],
          error: 'Could not read when process 4242 started',
        },
        message: notStopped,
      },
    ]);
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('reports a signalled server as stopped, then removes .git', async () => {
    const { info, warn, deps } = harness(async () => ({
      stopped: [{ name: 'server', pid: 4242, port: 3001 }],
      failed: [],
      hadTargets: true,
    }));

    await stopServerThenRemoveGitFolder(gitRoot, deps);

    expect(info).toEqual([
      {
        data: { gitRoot, stopped: 1 },
        message: 'remove-git-folder: stopped worktree server before .git removal',
      },
    ]);
    expect(warn).toEqual([]);
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('records a declined stop as not stopped and still removes .git', async () => {
    const { warn, deps } = harness(async () => ({
      stopped: [],
      failed: [],
      hadTargets: true,
      declined: { clients: 2 },
    }));

    await stopServerThenRemoveGitFolder(gitRoot, deps);

    expect(warn).toEqual([{ data: { gitRoot, declined: { clients: 2 } }, message: notStopped }]);
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('records a stop that throws as not stopped and still removes .git', async () => {
    const failure = new Error('lock unreadable');
    const { warn, deps } = harness(async () => {
      throw failure;
    });

    await stopServerThenRemoveGitFolder(gitRoot, deps);

    expect(warn).toEqual([{ data: { gitRoot, err: failure }, message: notStopped }]);
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('stops nothing for a root no probe surfaced and refuses its removal', async () => {
    const { stopCalls, deps } = harness(async () => ({
      stopped: [],
      failed: [],
      hadTargets: false,
    }));

    await expect(
      stopServerThenRemoveGitFolder(gitRoot, { ...deps, allowedGitRoots: new Set<string>() }),
    ).rejects.toThrow(/not surfaced by a recent probe/);
    expect(stopCalls).toEqual([]);
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });
});
