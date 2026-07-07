/**
 * RED regression tests for inkeep/open-knowledge#356 — "Unable to set up a
 * project for the first time" when the host git is present-but-broken.
 *
 * Pins the project-setup git-preflight invariant at the `ensureProjectGit`
 * spine, which Create New Project (create-new-project.ts) and Open Folder /
 * open-project (index.ts + utility/server-entry.ts) all route through:
 *
 *   A project-setup op that invokes git must verify git is usable against the
 *   binding it will invoke; on an unusable git it surfaces the recoverable typed
 *   git-preflight error (GitNotAvailableError / code GIT_NOT_AVAILABLE), never a
 *   raw ProjectGitInitError.
 *
 * These FAIL on the current code (ensureProjectGit has no preflight → raw
 * ProjectGitInitError) and pass once the fix routes the existing preflight
 * through the setup boundary. The assertions pin the recoverable *outcome*, not
 * a specific fix shape — see git-unusable-setup.test-helper.ts.
 *
 * Distinct from project-git.test.ts's "git binary is missing" case (PATH set to
 * a nonexistent dir → ENOENT): this exercises present-but-broken git (nonzero
 * exit), the failure mode the report and the fix turn on.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Classify what `ensureProjectGit` did, for assertion + informative failures. */
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
  // Create New Project / Open Folder spine: git unusable everywhere → must
  // surface the recoverable typed error, never the raw ProjectGitInitError.
  test('surfaces the recoverable GitNotAvailableError (not raw ProjectGitInitError) when git is unusable', async () => {
    const project = freshProjectDir();
    // Typed `string` (not SetupOutcome) so the closure reassignment below isn't
    // control-flow-narrowed to the initializer at the assertion.
    let outcome = 'unset';
    try {
      await withUnusableGitEverywhere(async () => {
        outcome = await runEnsureProjectGit(project);
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }

    // GREEN target: 'recoverable-git-not-available'.
    // Current (bug): 'raw-ProjectGitInitError' — no preflight on the setup path.
    expect(outcome).toBe('recoverable-git-not-available');
  });

  // Check/use binding divergence: a working git exists at an absolute fallback
  // path while the bare `git` the op invokes is broken, so detectGit() PASSES
  // (source:'fallback'). Design-agnostic contract: the op must NOT proceed to a
  // raw ProjectGitInitError — it must either succeed by using the resolved git,
  // or surface the recoverable typed error.
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

    // GREEN target: either 'succeeded' (used the fallback git) or
    // 'recoverable-git-not-available'. Current (bug): 'raw-ProjectGitInitError'.
    expect(['succeeded', 'recoverable-git-not-available']).toContain(outcome);
  });

  // Too-old git: the setup-boundary preflight must surface the recoverable typed
  // GitTooOldError, not proceed to a raw git init. Uses the fake-binary pattern
  // from project-git.test.ts's partial-init test — a stub `git` answering
  // `--version` with a version BELOW MIN_GIT_VERSION, exit 0 — so detectGit()
  // resolves the stub (PATH probe) and assertGitAvailable() trips GitTooOldError.
  test('surfaces the recoverable GitTooOldError (not raw ProjectGitInitError) when git is below MIN_GIT_VERSION', async () => {
    const project = freshProjectDir();
    // 2.10.0 sits below MIN_GIT_VERSION (2.31) and below any plausible future
    // floor bump, so this stays a deterministic too-old signal.
    const fakeBin = mkdtempSync(join(tmpdir(), 'ok356-oldgit-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "git version 2.10.0"; exit 0 ;;\n  *) exit 0 ;;\nesac\n',
      'utf-8',
    );
    chmodSync(fakeGit, 0o755);

    // The `--version` probe resolves `git` via the (mutated) PATH and hits the
    // stub; resolveOnPath('git') reads the runtime's startup PATH snapshot, so
    // seed the memo to pin detectGit().resolvedPath to the stub too.
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

    // Recoverable typed signal (GitTooOldError), NOT a raw ProjectGitInitError.
    expect(caught).toBeInstanceOf(GitTooOldError);
    expect(isRecoverableGitSignal(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(ProjectGitInitError);
  });
});
