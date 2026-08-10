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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
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

/**
 * Identity for the root commit, used ONLY when the machine has none
 * configured. OK Desktop is a notes app before it is a developer tool, so an
 * unset `user.email` is a realistic first-run state; failing over it would
 * strand the user with the very unborn-HEAD repo this commit exists to
 * prevent. A configured identity is always preferred and never overridden.
 */
const FALLBACK_COMMIT_NAME = 'Open Knowledge';
// Matches the identity the shadow repo already commits under, so OK's own
// writes read the same wherever they land.
const FALLBACK_COMMIT_EMAIL = 'noreply@openknowledge.local';

/**
 * True when git can resolve a committer identity here.
 *
 * Exit code only, never the message: git localizes its failure text (a German
 * locale reports "Bitte geben Sie an, wer Sie sind"), so matching English
 * phrases would silently skip the fallback for exactly the non-developer,
 * non-English users the fallback exists for.
 */
async function hasCommitterIdentity(gitBin: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync(
      gitBin,
      ['var', 'GIT_COMMITTER_IDENT'],
      withHiddenWindowsConsole({ cwd, encoding: 'utf-8' }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the repo holds at least one ref.
 *
 * Broader than `rev-parse --verify HEAD`, which answers only for the CURRENT
 * branch: a salvaged `.git/` can carry history on some other branch while
 * `main` is unborn, and committing there would graft a root commit disjoint
 * from everything already in the repo.
 */
async function hasAnyRef(gitBin: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['for-each-ref', '--count=1', 'refs/'],
      withHiddenWindowsConsole({ cwd, encoding: 'utf-8' }),
    );
    return stdout.trim().length > 0;
  } catch (err) {
    // Unreadable refs — assume history exists rather than risk a disjoint root.
    // Logged because this is the guard the repair path turns on: a transient
    // failure here silently skips the backfill and leaves the user in exactly
    // the unborn-HEAD state this code exists to clear.
    log.warn(
      { path: cwd, stderr: spawnErrorText(err) },
      'could not list refs — assuming history exists and skipping the initial commit',
    );
    return true;
  }
}

/**
 * Conservative fast-path: does this repo have a branch?
 *
 * Deliberately narrower than the full ref namespace — it reads only
 * `refs/heads/` and `packed-refs`, so a repo carrying nothing but tags or
 * remotes answers `false`. That costs one wasted git spawn and nothing more,
 * because `hasAnyRef` re-asks authoritatively over all of `refs/` before any
 * commit is written. Its whole job is to keep the common already-populated
 * case from invoking git or paying the preflight. Not a standalone
 * "does this repo have refs" oracle — do not use it as one.
 */
function hasRefsOnDisk(gitDir: string): boolean {
  const packed = resolve(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    try {
      const body = readFileSync(packed, 'utf-8');
      if (body.split('\n').some((line) => line.trim() !== '' && !line.startsWith('#'))) return true;
    } catch {
      return true;
    }
  }
  try {
    return readdirSync(resolve(gitDir, 'refs/heads')).length > 0;
  } catch {
    // Absent refs/heads on a real repo means no branches have been created.
    return false;
  }
}

/** stderr of a failed spawn, falling back to the error message. */
function spawnErrorText(err: unknown): string {
  const e =
    typeof err === 'object' && err !== null
      ? (err as { stderr?: unknown; message?: unknown })
      : null;
  const raw = e?.stderr;
  if (raw !== undefined && raw !== null) {
    return Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
  }
  return String(e?.message ?? err);
}

/**
 * Give a freshly-initialized repo a root commit so its default branch is a
 * resolvable ref.
 *
 * `git init` alone leaves an unborn HEAD: `.git/HEAD` points at
 * `refs/heads/main` while no such ref exists, so every `main`-relative command
 * fails — most visibly `git worktree add -b <name> <path> -- main`, which dies
 * with `fatal: invalid reference: main`.
 *
 * The commit is deliberately EMPTY. `ensureProjectGit` runs before any
 * scaffolding at all of its call sites, and several of them (`ok init`, the
 * pick-existing consent flow, the utility-process boot) can target a folder
 * that already holds the user's un-versioned files. Staging those would put a
 * whole notes tree under version control in a commit nobody asked for. An
 * empty root commit restores the invariant while touching no content.
 *
 * Best-effort by contract: a failure leaves a valid repo that merely still
 * can't resolve its default branch, which the worktree-create path reports as
 * `empty-repo`. Project setup must not fail over it.
 */
async function createInitialCommit(gitBin: string, cwd: string): Promise<void> {
  // Never graft a root commit onto a repo that already holds anything.
  if (await hasAnyRef(gitBin, cwd)) return;

  // `--no-verify` and `--no-gpg-sign`: this is OK's own bookkeeping commit, not
  // the user's work. A pre-commit hook inherited from `init.templateDir`, or a
  // signing key the packaged app's minimal PATH can't reach, must not be able
  // to fail project setup.
  const commitArgs = [
    'commit',
    '--allow-empty',
    '--no-verify',
    '--no-gpg-sign',
    '-m',
    'Initial commit',
  ];

  // Supply a fallback identity ONLY when git can't resolve one. `-c` overrides
  // configured values, so passing it unconditionally would misattribute the
  // commit for every user who does have an identity set.
  const identified = await hasCommitterIdentity(gitBin, cwd);
  const args = identified
    ? commitArgs
    : [
        '-c',
        `user.name=${FALLBACK_COMMIT_NAME}`,
        '-c',
        `user.email=${FALLBACK_COMMIT_EMAIL}`,
        ...commitArgs,
      ];

  try {
    await execFileAsync(gitBin, args, withHiddenWindowsConsole({ cwd, encoding: 'utf-8' }));
    if (!identified) {
      log.info({ path: cwd }, 'created initial commit with fallback identity (git identity unset)');
    }
  } catch (err) {
    log.warn({ path: cwd, stderr: spawnErrorText(err) }, 'could not create initial commit');
  }
}

async function isInsideExistingWorkTree(gitBin: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['rev-parse', '--is-inside-work-tree'],
      withHiddenWindowsConsole({ cwd, encoding: 'utf-8' }),
    );
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
  // A repo that has HEAD but not a single ref never got a root commit, so its
  // default branch does not resolve. Projects that shipped OK created before
  // the initial-commit fix are all in this state, and nothing else backfills
  // them — they stay broken forever otherwise, and they are precisely the
  // population that reported the bug. Adopting one costs nothing: with zero
  // refs there is no history to conflict with or diverge from.
  let strandedUnborn = false;
  if (existsSync(gitPath)) {
    if (!statSync(gitPath).isDirectory()) {
      // Worktree-pointer file (`gitdir: ...`) — not a real `.git/`, no HEAD to check.
      return { didInit: false };
    }
    if (existsSync(headPath)) {
      // Filesystem probe first: an already-populated repo (the common case)
      // still returns here without invoking git or paying the preflight.
      if (hasRefsOnDisk(gitPath)) {
        return { didInit: false };
      }
      strandedUnborn = true;
    } else {
      // Directory present without `HEAD` — `git init` is idempotent and leaves
      // foreign subtrees (e.g. `.git/ok/`) untouched.
      log.info({}, 'detected partial .git/ — running git init to repair');
      needsRepair = true;
    }
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
          err,
        },
        'unexpected error during git preflight',
      );
    }
    // Propagate the recoverable typed error UNWRAPPED — callers branch on it.
    throw err;
  }
  const gitBin = detected.resolvedPath;

  // Backfill the root commit on an already-initialized but ref-less repo. No
  // `git init` runs here, so `didInit` stays false — the repo existed; only its
  // missing root commit is supplied.
  if (strandedUnborn) {
    await createInitialCommit(gitBin, abs);
    return { didInit: false };
  }

  // Only walk up to an ancestor repo when `.git` is absent here (needsRepair is
  // set only when a partial `.git/` is present, which we must re-init in place).
  if (!needsRepair && (await isInsideExistingWorkTree(gitBin, abs))) {
    return { didInit: false };
  }

  let stderr = '';
  try {
    const result = await execFileAsync(
      gitBin,
      ['init', '--initial-branch=main', abs],
      withHiddenWindowsConsole({ encoding: 'utf-8' }),
    );
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

  // Internally guarded on "the repo holds no refs", so the salvaged-`.git/`
  // repair path can never graft a root disjoint from recovered history.
  await createInitialCommit(gitBin, abs);

  if (needsRepair) {
    log.info({ path: abs }, 'backfilled missing .git/HEAD');
    return { didInit: true, repaired: true };
  }

  log.info({ path: abs, branch: 'main' }, 'initialized .git/');

  return { didInit: true };
}
