import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
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
    // Bare git off PATH (PATH=/nonexistent) is not "git unavailable": the
    // setup-boundary preflight resolves the host's git at a detectGit() fallback
    // path and invokes THAT binary, closing the check/use divergence — so the op
    // succeeds. ("git unavailable *everywhere* → recoverable typed error" is
    // owned by project-git.preflight.test.ts.)
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

    // Init ran via the fallback git, so .git/HEAD exists.
    expect(existsSync(resolve(projectRoot, '.git/HEAD'))).toBe(true);
  });

  test('throws ProjectGitInitError when git init succeeds but .git/HEAD is absent (partial init)', async () => {
    const projectRoot = resolve(tmpDir, 'partial');
    mkdirSync(projectRoot, { recursive: true });

    // Create a fake `git` binary that creates .git/ but NOT .git/HEAD.
    // Simulates a defensively-checked post-condition failure. It must also pass
    // the setup-boundary preflight, so it answers `--version` with a valid,
    // >= MIN_GIT_VERSION string — making detectGit() resolve THIS git (PATH
    // source) and the op invoke it (rather than falling back to the host git).
    // The `2.45.0` below is pinned ABOVE MIN_GIT_VERSION (2.31) on purpose: if
    // the floor is ever bumped past 2.45, bump this stub too, or detectGit()
    // trips GitTooOldError before the partial-init path under test.
    const fakeBin = resolve(tmpDir, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeGit = resolve(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      `#!/bin/sh\ncase "$1" in\n  --version) echo "git version 2.45.0"; exit 0 ;;\n  init)\n    # args: init --initial-branch=main <path>\n    mkdir -p "$3/.git"\n    # intentionally do not create HEAD\n    exit 0 ;;\n  *) exit 0 ;;\nesac\n`,
      'utf-8',
    );
    await execFileAsync('chmod', ['+x', fakeGit]);

    // The preflight must resolve to THIS stub for the partial-init path to fire.
    // PATH narrowing makes the `git --version` probe deterministically hit the
    // stub (2.45.0), but resolveOnPath('git') resolves against the runtime's
    // startup PATH snapshot (Bun ignores a mid-process PATH mutation for a
    // no-`env` spawnSync) and would otherwise return the host git. Seed the
    // resolveOnPath memo so detectGit().resolvedPath IS the stub.
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
