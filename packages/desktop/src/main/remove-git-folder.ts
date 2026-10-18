import { existsSync, promises as fsPromises, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { runStop } from '@inkeep/open-knowledge';
import type { DesktopLogger } from './desktop-logger.ts';

const REJECT_PREFIX = 'ok:fs:remove-git-folder rejected:';

interface RemoveGitFolderDeps {
  readonly allowedGitRoots: ReadonlySet<string>;
}

interface StopThenRemoveGitFolderDeps extends RemoveGitFolderDeps {
  readonly lockDirFor: (gitRoot: string) => string;
  readonly runStop: (deps: Parameters<typeof runStop>[0]) => ReturnType<typeof runStop>;
  readonly log: Pick<DesktopLogger, 'info' | 'warn'>;
}

const NOT_STOPPED = 'remove-git-folder: the worktree server was not stopped; removing .git anyway';

export async function stopServerThenRemoveGitFolder(
  gitRoot: unknown,
  deps: StopThenRemoveGitFolderDeps,
): Promise<void> {
  if (typeof gitRoot === 'string' && deps.allowedGitRoots.has(gitRoot)) {
    await stopServerBeforeGitRemoval(gitRoot, deps);
  }
  await removeGitFolder(gitRoot, deps);
}

async function stopServerBeforeGitRemoval(
  gitRoot: string,
  deps: StopThenRemoveGitFolderDeps,
): Promise<void> {
  const { log } = deps;
  let outcome: Awaited<ReturnType<typeof runStop>>;
  try {
    outcome = await deps.runStop({
      lockDir: deps.lockDirFor(gitRoot),
      force: true,
      log: (msg) => log.info({ gitRoot }, `[remove-git-folder] ${msg}`),
    });
  } catch (err) {
    log.warn({ gitRoot, err }, NOT_STOPPED);
    return;
  }
  if (outcome.stopped.length > 0) {
    log.info(
      { gitRoot, stopped: outcome.stopped.length },
      'remove-git-folder: stopped worktree server before .git removal',
    );
  }
  if (outcome.declined !== undefined) {
    log.warn({ gitRoot, declined: outcome.declined }, NOT_STOPPED);
  }
  for (const { target, error, unverified } of outcome.failed) {
    log.warn(
      {
        gitRoot,
        lockPid: target.pid,
        lockPath: unverified?.lockPath,
        cause: unverified?.cause,
        ...(unverified !== undefined &&
        'nativeFailures' in unverified &&
        unverified.nativeFailures.length > 0
          ? { nativeFailures: unverified.nativeFailures }
          : {}),
        error,
      },
      NOT_STOPPED,
    );
  }
}

export async function removeGitFolder(gitRoot: unknown, deps: RemoveGitFolderDeps): Promise<void> {
  if (typeof gitRoot !== 'string' || gitRoot.length === 0) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be a non-empty string`);
  }
  if (!isAbsolute(gitRoot) || resolve(gitRoot) !== gitRoot) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be an absolute, resolved path`);
  }
  if (!deps.allowedGitRoots.has(gitRoot)) {
    throw new Error(`${REJECT_PREFIX} gitRoot was not surfaced by a recent probe`);
  }
  const target = join(gitRoot, '.git');
  if (!existsSync(target)) {
    return;
  }
  try {
    const canonical = realpathSync(target);
    if (basename(canonical) !== '.git') {
      throw new Error(`${REJECT_PREFIX} resolved symlink target is not a .git entry`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (err instanceof Error && err.message.startsWith(REJECT_PREFIX)) throw err;
    throw new Error(`${REJECT_PREFIX} could not resolve path (${code ?? 'unknown'})`, {
      cause: err,
    });
  }
  await fsPromises.rm(target, { recursive: true, force: true });
}
