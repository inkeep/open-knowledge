import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetResolveOnPathCacheForTests,
  __seedResolveOnPathCacheForTests,
} from './git-preflight.ts';
import { ensureProjectGit, ProjectGitInitError } from './project-git.ts';

const execFileAsync = promisify(execFile);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-project-git-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ensureProjectGit', () => {
  test('returns { didInit: false } when .git/HEAD already exists (idempotent)', async () => {
    const projectRoot = resolve(tmpDir, 'has-git');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(resolve(projectRoot, '.git'));
    writeFileSync(resolve(projectRoot, '.git/HEAD'), 'ref: refs/heads/main\n');

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(false);
    expect(result.repaired).toBeUndefined();
  });

  test('auto-repairs partial .git/ (directory without HEAD) preserving .git/ok/ subtree', async () => {
    const projectRoot = resolve(tmpDir, 'shell-git');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(resolve(projectRoot, '.git/ok/refs'), { recursive: true });

    writeFileSync(resolve(projectRoot, '.git/ok/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      resolve(projectRoot, '.git/ok/config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    writeFileSync(resolve(projectRoot, '.git/ok/refs/marker'), 'shadow-marker\n');

    expect(existsSync(resolve(projectRoot, '.git/HEAD'))).toBe(false);
    expect(existsSync(resolve(projectRoot, '.git/ok/HEAD'))).toBe(true);

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(true);
    expect(result.repaired).toBe(true);
    expect(existsSync(resolve(projectRoot, '.git/HEAD'))).toBe(true);

    expect(readFileSync(resolve(projectRoot, '.git/ok/HEAD'), 'utf-8')).toBe(
      'ref: refs/heads/main\n',
    );
    expect(readFileSync(resolve(projectRoot, '.git/ok/config'), 'utf-8')).toBe(
      '[core]\n\trepositoryformatversion = 0\n',
    );
    expect(readFileSync(resolve(projectRoot, '.git/ok/refs/marker'), 'utf-8')).toBe(
      'shadow-marker\n',
    );
  });

  test('returns { didInit: false } when .git is a file (worktree-style pointer — D6 match-any)', async () => {
    const projectRoot = resolve(tmpDir, 'worktree');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(resolve(projectRoot, '.git'), 'gitdir: /tmp/real-git\n');

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(false);
  });

  test('returns { didInit: false } when running inside a subfolder of an existing repo', async () => {
    const projectRoot = resolve(tmpDir, 'parent-repo');
    mkdirSync(projectRoot, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', projectRoot]);

    const subFolder = resolve(projectRoot, 'nested/child');
    mkdirSync(subFolder, { recursive: true });

    const result = await ensureProjectGit(subFolder);

    expect(result.didInit).toBe(false);
    expect(existsSync(resolve(subFolder, '.git'))).toBe(false);
  });

  test('runs git init --initial-branch=main when .git/ is missing', async () => {
    const projectRoot = resolve(tmpDir, 'fresh');
    mkdirSync(projectRoot, { recursive: true });

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(true);
    expect(existsSync(resolve(projectRoot, '.git/HEAD'))).toBe(true);

    const head = readFileSync(resolve(projectRoot, '.git/HEAD'), 'utf-8');
    expect(head).toBe('ref: refs/heads/main\n');
  });

  test('falls back to a usable git when bare git is unavailable on PATH', async () => {
    const projectRoot = resolve(tmpDir, 'no-git-binary');
    mkdirSync(projectRoot, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path';
    try {
      const result = await ensureProjectGit(projectRoot);
      expect(result.didInit).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }

    expect(existsSync(resolve(projectRoot, '.git/HEAD'))).toBe(true);
  });

  test('throws ProjectGitInitError when git init succeeds but .git/HEAD is absent (partial init)', async () => {
    const projectRoot = resolve(tmpDir, 'partial');
    mkdirSync(projectRoot, { recursive: true });

    const fakeBin = resolve(tmpDir, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeGit = resolve(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      `#!/bin/sh\ncase "$1" in\n  --version) echo "git version 2.45.0"; exit 0 ;;\n  init)\n    # args: init --initial-branch=main <path>\n    mkdir -p "$3/.git"\n    # intentionally do not create HEAD\n    exit 0 ;;\n  *) exit 0 ;;\nesac\n`,
      'utf-8',
    );
    await execFileAsync('chmod', ['+x', fakeGit]);

    __resetResolveOnPathCacheForTests();
    __seedResolveOnPathCacheForTests('git', fakeGit);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      await expect(ensureProjectGit(projectRoot)).rejects.toBeInstanceOf(ProjectGitInitError);
    } finally {
      process.env.PATH = originalPath;
      __resetResolveOnPathCacheForTests();
    }
  });
});

describe('ensureProjectGit — initial commit', () => {
  async function headResolves(cwd: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
      return true;
    } catch {
      return false;
    }
  }

  test('leaves a repo whose HEAD resolves after a fresh init', async () => {
    const projectRoot = resolve(tmpDir, 'fresh');
    mkdirSync(projectRoot, { recursive: true });

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(true);
    await expect(headResolves(projectRoot)).resolves.toBe(true);
  });

  test('leaves `main` resolvable, so `git worktree add ... -- main` succeeds', async () => {
    const projectRoot = resolve(tmpDir, 'worktree-base');
    mkdirSync(projectRoot, { recursive: true });

    await ensureProjectGit(projectRoot);

    const worktreePath = resolve(projectRoot, '.ok/worktrees/wt-1');
    await expect(
      execFileAsync('git', ['worktree', 'add', '-b', 'wt-1', worktreePath, '--', 'main'], {
        cwd: projectRoot,
      }),
    ).resolves.toBeDefined();
  });

  test('backfills a root commit on a repo already stranded with an unborn HEAD', async () => {
    const projectRoot = resolve(tmpDir, 'stranded');
    mkdirSync(projectRoot, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', projectRoot]);
    await expect(headResolves(projectRoot)).resolves.toBe(false);

    const result = await ensureProjectGit(projectRoot);

    expect(result.didInit).toBe(false);
    await expect(headResolves(projectRoot)).resolves.toBe(true);
  });

  test('never grafts a root commit onto a repo that holds any history', async () => {
    const projectRoot = resolve(tmpDir, 'history-elsewhere');
    mkdirSync(projectRoot, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=other', projectRoot]);
    await execFileAsync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@e.co', 'commit', '--allow-empty', '-m', 'existing'],
      { cwd: projectRoot },
    );
    const before = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: projectRoot });
    await expect(headResolves(projectRoot)).resolves.toBe(false);

    await ensureProjectGit(projectRoot);

    await expect(headResolves(projectRoot)).resolves.toBe(false);
    const after = await execFileAsync('git', ['rev-parse', 'other'], { cwd: projectRoot });
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  });

  test('commits after repairing a partial .git/ (shell-`.git/` regression class)', async () => {
    const projectRoot = resolve(tmpDir, 'shell-git-commit');
    mkdirSync(resolve(projectRoot, '.git/ok'), { recursive: true });

    const result = await ensureProjectGit(projectRoot);

    expect(result.repaired).toBe(true);
    await expect(headResolves(projectRoot)).resolves.toBe(true);
  });

  test('commits even when git can resolve no identity at all', async () => {
    const projectRoot = resolve(tmpDir, 'no-identity');
    mkdirSync(projectRoot, { recursive: true });
    const emptyConfig = resolve(tmpDir, 'gitconfig-no-identity');
    writeFileSync(emptyConfig, '[user]\n\tuseConfigOnly = true\n');

    const saved = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) {
        delete process.env[key];
      }
    }
    try {
      await expect(
        execFileAsync('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: projectRoot }),
      ).rejects.toBeDefined();

      await ensureProjectGit(projectRoot);
      await expect(headResolves(projectRoot)).resolves.toBe(true);

      const author = await execFileAsync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: projectRoot,
      });
      expect(author.stdout.trim()).toBe('Open Knowledge <noreply@openknowledge.local>');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  test('uses the configured identity when there is one, never the fallback', async () => {
    const projectRoot = resolve(tmpDir, 'real-identity');
    mkdirSync(projectRoot, { recursive: true });
    const realConfig = resolve(tmpDir, 'gitconfig-real');
    writeFileSync(realConfig, '[user]\n\tname = Real Person\n\temail = real@example.com\n');

    const saved = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = realConfig;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) {
        delete process.env[key];
      }
    }
    try {
      await ensureProjectGit(projectRoot);
      const author = await execFileAsync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: projectRoot,
      });
      expect(author.stdout.trim()).toBe('Real Person <real@example.com>');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });
});
