/**
 * Project-git auto-init — fail-fast replacement for standalone-mode shadow.
 *
 * Ensures the project sits inside a git working tree before any shadow-repo or
 * HEAD-watcher subsystem runs. Called from `ok init` — the explicit setup
 * verb. Never falls back to a degraded mode.
 *
 * Layout decisions:
 *   - Default branch is always `main` (regardless of user's `init.defaultBranch`)
 *   - `.git` presence check is `existsSync` at the project root — matches
 *     dir OR file (worktree pointer). Extended to also walk up via
 *     `git rev-parse --is-inside-work-tree` so running `ok init` from a
 *     subfolder of an existing repo does not create a nested repo.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  assertGitAvailable,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
} from './git-preflight.ts';
import { emitPreflightFailureSpan } from './git-preflight-telemetry.ts';
import { getLogger } from './logger.ts';

const execFileAsync = promisify(execFile);
const log = getLogger('project-git');

export class ProjectGitInitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectGitInitError';
    this.stderr = stderr;
  }
}

export interface EnsureProjectGitResult {
  didInit: boolean;
  /**
   * `true` when a partial `.git/` (directory present but `HEAD` missing — the
   * "shell `.git/`" regression class produced by `initShadowRepo`'s
   * `mkdir .git/ok/` running before any `git init`) was auto-repaired by
   * re-running `git init`. The `.git/ok/` shadow subtree is preserved.
   */
  repaired?: boolean;
}

async function isInsideExistingWorkTree(gitBin: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(gitBin, ['rev-parse', '--is-inside-work-tree'], {
      cwd,
    });
    return stdout.trim() === 'true';
  } catch {
    // Non-zero `rev-parse` here means "not a work tree" (or an unreadable cwd)
    // for an already-validated git — the caller ran the preflight and resolved
    // `gitBin` before this runs. Fall through to `git init` at this root.
    return false;
  }
}

/**
 * Ensure `projectRoot` lives inside a git working tree. Returns
 * `{ didInit: false }` when `<projectRoot>/.git` is present OR an ancestor
 * directory is already a git repo; otherwise runs
 * `git init --initial-branch=main` at `projectRoot` and returns
 * `{ didInit: true }`.
 *
 * Before invoking git, verifies git is usable via the shared preflight and
 * invokes the exact binary the preflight resolved — so a working git at a
 * fallback path the inherited PATH can't reach is used rather than rejected.
 * Throws the recoverable typed `GitNotAvailableError` / `GitTooOldError`
 * (unwrapped) when no usable git exists. Throws `ProjectGitInitError` only for
 * genuine init failures of the resolved git (spawn failure, or `git init`
 * reporting success while `.git/HEAD` is absent afterwards). Callers are
 * expected to propagate the error (no degraded fallback).
 */
export async function ensureProjectGit(projectRoot: string): Promise<EnsureProjectGitResult> {
  const abs = resolve(projectRoot);
  const gitPath = resolve(abs, '.git');
  const headPath = resolve(gitPath, 'HEAD');

  let needsRepair = false;
  if (existsSync(gitPath)) {
    if (!statSync(gitPath).isDirectory()) {
      // Worktree-pointer file (`gitdir: ...`) — not a real `.git/`, no HEAD to check.
      return { didInit: false };
    }
    if (existsSync(headPath)) {
      return { didInit: false };
    }
    // Directory present without `HEAD` — `git init` is idempotent and leaves
    // foreign subtrees (e.g. `.git/ok/`) untouched.
    log.info({}, 'detected partial .git/ — running git init to repair');
    needsRepair = true;
  }

  // We will invoke git from here on (rev-parse and/or init). Validate that git
  // is usable and invoke the exact binding the preflight resolved — this closes
  // the check/use divergence a bare-`git` invocation leaves open (a working git
  // at a fallback path the inherited PATH can't reach). Placed AFTER the
  // idempotent early-returns above (worktree pointer, already-initialized repo)
  // so already-set-up repos — which invoke no git — never preflight.
  let detected: GitDetected;
  try {
    detected = assertGitAvailable();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
      // Pair the failure span with a structured log (mirrors boot.ts). OTEL is
      // off by default, so this log line is the only field-visible signal for a
      // setup-boundary preflight failure.
      emitPreflightFailureSpan(err);
      log.warn(
        {
          event: 'git_preflight_fail',
          platform: err.platform,
          reason: err instanceof GitTooOldError ? 'too_old' : 'not_available',
          detectedVersion: err instanceof GitTooOldError ? err.detected : '',
        },
        err instanceof GitTooOldError ? 'git binary too old' : 'git binary not found',
      );
    } else {
      // An unexpected (non-typed) error still propagates unwrapped below; log it
      // first so a setup-boundary preflight failure isn't silently swallowed
      // (mirrors clone-flow.ts).
      log.warn(
        {
          event: 'git_preflight_unexpected_error',
          message: err instanceof Error ? err.message : String(err),
        },
        'unexpected error during git preflight',
      );
    }
    // Propagate the recoverable typed error UNWRAPPED — callers branch on it.
    throw err;
  }
  const gitBin = detected.resolvedPath;

  // Only walk up to an ancestor repo when `.git` is absent here (needsRepair is
  // set only when a partial `.git/` is present, which we must re-init in place).
  if (!needsRepair && (await isInsideExistingWorkTree(gitBin, abs))) {
    return { didInit: false };
  }

  let stderr = '';
  try {
    const result = await execFileAsync(gitBin, ['init', '--initial-branch=main', abs]);
    stderr = result.stderr ?? '';
  } catch (err) {
    const capturedStderr =
      err !== null && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr ?? '')
        : '';
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectGitInitError(`git init failed at ${abs}: ${msg}`, capturedStderr, {
      cause: err,
    });
  }

  if (!existsSync(headPath)) {
    throw new ProjectGitInitError(
      `git init reported success but ${gitPath}/HEAD is missing (partial init detected)`,
      stderr,
    );
  }

  if (needsRepair) {
    log.info({ path: abs }, 'backfilled missing .git/HEAD');
    return { didInit: true, repaired: true };
  }

  log.info({ path: abs, branch: 'main' }, 'initialized .git/');

  return { didInit: true };
}
