import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileLockTimeoutError, withFileLock } from '@inkeep/open-knowledge-core/server';
import { tracedMkdir, tracedRename, tracedRm } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';

export const STALE_INSTALL_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;
const INSTALL_COMMIT_LOCK_TIMEOUT_MS = 60_000;

const RETRIABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 6;
const RENAME_RETRY_BASE_DELAY_MS = 100;

export interface RenameRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  renameImpl?: (from: string, to: string) => Promise<void>;
}

export async function renameWithRetries(
  from: string,
  to: string,
  opts: RenameRetryOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? RENAME_RETRY_ATTEMPTS;
  const rename = opts.renameImpl ?? tracedRename;
  let delayMs = opts.baseDelayMs ?? RENAME_RETRY_BASE_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !RETRIABLE_RENAME_CODES.has(code)) {
        throw err;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      delayMs *= 2;
    }
  }
}

export async function cleanupStaleInstallArtifacts(
  parentDir: string,
  log: PinoLogger,
  logPrefix: string,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(parentDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, parentDir }, `${logPrefix} could not read install dir for cleanup`);
    }
    return;
  }

  const cutoff = Date.now() - STALE_INSTALL_ARTIFACT_AGE_MS;
  for (const entry of entries) {
    const staleStagingDir = entry.isDirectory() && entry.name.startsWith('.install-');
    const straggler =
      entry.isFile() &&
      (entry.name.endsWith('.install.lock') || entry.name.startsWith('.install-'));
    if (!staleStagingDir && !straggler) continue;
    const path = join(parentDir, entry.name);
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      await tracedRm(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn({ err, path }, `${logPrefix} stale install artifact cleanup failed`);
    }
  }
}

export interface StagedInstallOptions<T> {
  versionDir: string;
  stagingLabel: string;
  findInstalled: () => Promise<T | null>;
  prepare: (stagingDir: string) => Promise<string>;
  log: PinoLogger;
  logPrefix: string;
  logContext: Record<string, unknown>;
  installedMessage: string;
  missingAfterCommitMessage: string;
  beforeCommit?: () => Promise<void>;
  commitLockTimeoutMs?: number;
}

export async function stagedInstall<T>(opts: StagedInstallOptions<T>): Promise<T> {
  const parentDir = dirname(opts.versionDir);
  const existing = await opts.findInstalled();
  if (existing !== null) {
    await cleanupStaleInstallArtifacts(parentDir, opts.log, opts.logPrefix);
    return existing;
  }

  await tracedMkdir(parentDir, { recursive: true });
  await cleanupStaleInstallArtifacts(parentDir, opts.log, opts.logPrefix);
  const stagingDir = join(
    parentDir,
    `.install-${opts.stagingLabel}-${process.pid}-${randomUUID()}`,
  );
  await tracedMkdir(stagingDir, { recursive: true });
  try {
    const extractDir = await opts.prepare(stagingDir);

    const raced = await opts.findInstalled();
    if (raced !== null) return raced;
    await opts.beforeCommit?.();

    try {
      return await withFileLock(
        `${opts.versionDir}.install.lock`,
        async () => {
          const winner = await opts.findInstalled();
          if (winner !== null) return winner;

          await tracedRm(opts.versionDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
          await renameWithRetries(extractDir, opts.versionDir);
          opts.log.info(
            { ...opts.logContext, versionDir: opts.versionDir },
            `${opts.logPrefix} ${opts.installedMessage}`,
          );
          const installed = await opts.findInstalled();
          if (installed === null) {
            throw new Error(opts.missingAfterCommitMessage);
          }
          return installed;
        },
        {
          timeoutMs: opts.commitLockTimeoutMs ?? INSTALL_COMMIT_LOCK_TIMEOUT_MS,
          onWarn: (message, context) => {
            opts.log.warn({ ...context, ...opts.logContext }, `${opts.logPrefix} ${message}`);
          },
        },
      );
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        const winner = await opts.findInstalled();
        if (winner !== null) return winner;
        opts.log.warn(
          { ...opts.logContext, lockPath: err.lockPath, timeoutMs: err.timeoutMs },
          `${opts.logPrefix} install commit lock timed out with no winner installed`,
        );
      }
      throw err;
    }
  } finally {
    await tracedRm(stagingDir, { recursive: true, force: true }).catch((err) => {
      opts.log.warn(
        { err, ...opts.logContext, stagingDir },
        `${opts.logPrefix} install staging cleanup failed`,
      );
    });
  }
}
