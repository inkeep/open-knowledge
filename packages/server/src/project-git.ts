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
import { assertNotHomeProjectRoot } from './home-project-root.ts';
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
  repaired?: boolean;
}

const FALLBACK_COMMIT_NAME = 'Open Knowledge';
const FALLBACK_COMMIT_EMAIL = 'noreply@openknowledge.local';

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

async function hasAnyRef(gitBin: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['for-each-ref', '--count=1', 'refs/'],
      withHiddenWindowsConsole({ cwd, encoding: 'utf-8' }),
    );
    return stdout.trim().length > 0;
  } catch (err) {
    log.warn(
      { path: cwd, stderr: spawnErrorText(err) },
      'could not list refs — assuming history exists and skipping the initial commit',
    );
    return true;
  }
}

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
    return false;
  }
}

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

async function createInitialCommit(gitBin: string, cwd: string): Promise<void> {
  if (await hasAnyRef(gitBin, cwd)) return;

  const commitArgs = [
    'commit',
    '--allow-empty',
    '--no-verify',
    '--no-gpg-sign',
    '-m',
    'Initial commit',
  ];

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
    return false;
  }
}

export async function ensureProjectGit(projectRoot: string): Promise<EnsureProjectGitResult> {
  const abs = resolve(projectRoot);
  assertNotHomeProjectRoot(abs);
  const gitPath = resolve(abs, '.git');
  const headPath = resolve(gitPath, 'HEAD');

  let needsRepair = false;
  let strandedUnborn = false;
  if (existsSync(gitPath)) {
    if (!statSync(gitPath).isDirectory()) {
      return { didInit: false };
    }
    if (existsSync(headPath)) {
      if (hasRefsOnDisk(gitPath)) {
        return { didInit: false };
      }
      strandedUnborn = true;
    } else {
      log.info({}, 'detected partial .git/ — running git init to repair');
      needsRepair = true;
    }
  }

  let detected: GitDetected;
  try {
    detected = assertGitAvailable();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
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
      log.warn(
        {
          event: 'git_preflight_unexpected_error',
          err,
        },
        'unexpected error during git preflight',
      );
    }
    throw err;
  }
  const gitBin = detected.resolvedPath;

  if (strandedUnborn) {
    await createInitialCommit(gitBin, abs);
    return { didInit: false };
  }

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

  await createInitialCommit(gitBin, abs);

  if (needsRepair) {
    log.info({ path: abs }, 'backfilled missing .git/HEAD');
    return { didInit: true, repaired: true };
  }

  log.info({ path: abs, branch: 'main' }, 'initialized .git/');

  return { didInit: true };
}
