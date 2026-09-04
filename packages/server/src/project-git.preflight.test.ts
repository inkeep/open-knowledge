import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  __resetResolveOnPathCacheForTests,
  __seedResolveOnPathCacheForTests,
  GitTooOldError,
} from './git-preflight.ts';
import {
  isRecoverableGitSignal,
  withBrokenBareGitOnly,
  withUnusableGitEverywhere,
} from './git-unusable-setup.test-helper.ts';
import { ensureProjectGit, ProjectGitInitError } from './project-git.ts';

type SetupOutcome =
  | 'succeeded'
  | 'recoverable-git-not-available'
  | 'raw-ProjectGitInitError'
  | `other:${string}`;

async function runEnsureProjectGit(projectRoot: string): Promise<SetupOutcome> {
  try {
    await ensureProjectGit(projectRoot);
    return 'succeeded';
  } catch (err) {
    if (isRecoverableGitSignal(err)) return 'recoverable-git-not-available';
    if (err instanceof ProjectGitInitError) return 'raw-ProjectGitInitError';
    return `other:${err instanceof Error ? err.name : String(err)}`;
  }
}

function freshProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ok356-project-'));
}

describe('ensureProjectGit — git-preflight at the project-setup boundary (#356)', () => {
  test('surfaces the recoverable GitNotAvailableError (not raw ProjectGitInitError) when git is unusable', async () => {
    const project = freshProjectDir();
    let outcome = 'unset';
    try {
      await withUnusableGitEverywhere(async () => {
        outcome = await runEnsureProjectGit(project);
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }

    expect(outcome).toBe('recoverable-git-not-available');
  });

  test('does not fail with a raw ProjectGitInitError under the check/use binding divergence', async () => {
    const project = freshProjectDir();
    let outcome = 'unset';
    try {
      await withBrokenBareGitOnly(async () => {
        outcome = await runEnsureProjectGit(project);
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }

    expect(['succeeded', 'recoverable-git-not-available']).toContain(outcome);
  });

  test('surfaces the recoverable GitTooOldError (not raw ProjectGitInitError) when git is below MIN_GIT_VERSION', async () => {
    const project = freshProjectDir();
    const fakeBin = mkdtempSync(join(tmpdir(), 'ok356-oldgit-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "git version 2.10.0"; exit 0 ;;\n  *) exit 0 ;;\nesac\n',
      'utf-8',
    );
    chmodSync(fakeGit, 0o755);

    __resetResolveOnPathCacheForTests();
    __seedResolveOnPathCacheForTests('git', fakeGit);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    let caught: unknown;
    try {
      await ensureProjectGit(project);
    } catch (err) {
      caught = err;
    } finally {
      process.env.PATH = originalPath;
      __resetResolveOnPathCacheForTests();
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(GitTooOldError);
    expect(isRecoverableGitSignal(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(ProjectGitInitError);
  });
});
