/**
 * Staged-install commit machinery shared by the two ACP install paths:
 * proprietary agent binaries (`launch.ts` → `ensureBinaryInstalled`) and the
 * managed language runtimes (`managed-runtime.ts` → `ensureManagedRuntime`).
 * One audited copy of the concurrency contract, so a crash-safety or
 * Windows-robustness fix lands in both paths at once:
 *
 *   - Extraction lands in a staging dir BESIDE the destination and is renamed
 *     into place, so the atomic commit stays on one filesystem and a crash
 *     mid-install never leaves a half-populated version dir that would satisfy
 *     the caller's fast-path check.
 *   - Only the commit is serialized (file lock): concurrent installers
 *     download in parallel, and every loser adopts the winner's tree instead
 *     of racing on the rename.
 *   - Stale artifacts from crashed installers — `.install-*` staging dirs,
 *     `*.install.lock` commit locks, `.install-failed-*` markers — are swept
 *     on the next install once they age past a day.
 */

import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileLockTimeoutError, withFileLock } from '@inkeep/open-knowledge-core/server';
import { tracedMkdir, tracedRename, tracedRm } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';

/** Age past which a crashed installer's leftovers are fair game for the sweep. */
export const STALE_INSTALL_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;
const INSTALL_COMMIT_LOCK_TIMEOUT_MS = 60_000;

/**
 * Windows share-violation codes: an antivirus scanner or search indexer
 * briefly holding a handle inside a freshly extracted tree fails rename with
 * one of these even though nothing is wrong with the install. On POSIX the
 * same codes are genuine permission errors — the bounded retry merely delays
 * that verdict by a few seconds.
 */
const RETRIABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 6;
const RENAME_RETRY_BASE_DELAY_MS = 100;

export interface RenameRetryOptions {
  attempts?: number;
  /** Delay before the first retry; doubles on each subsequent one. */
  baseDelayMs?: number;
  /** Test seam — defaults to `tracedRename`. */
  renameImpl?: (from: string, to: string) => Promise<void>;
}

/**
 * `rename` with a bounded retry on transient Windows share violations (see
 * {@link RETRIABLE_RENAME_CODES}) — the failure a freshly extracted `.exe`
 * under real-time scanning hits at commit time. Everything else (ENOENT,
 * EXDEV, ENOTEMPTY, …) rethrows immediately.
 */
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

/**
 * Remove stale install leftovers in `parentDir` (the dir holding the
 * per-version trees): crashed installers orphan `.install-*` staging dirs and
 * `.install-failed-*` markers, and a process that dies while holding
 * `<version>.install.lock` orphans the lockfile forever — once any other path
 * completes the install, every later launch takes the fast path and nothing
 * re-enters the lock to clean it up. The age cutoff keeps live installs safe:
 * an active lock or staging dir is minutes old at most.
 */
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
  /** Final destination; committed atomically via rename from staging. */
  versionDir: string;
  /** Sanitized version label used in the staging dir name. */
  stagingLabel: string;
  /** The installed artifact when a complete tree exists at `versionDir`, else null. */
  findInstalled: () => Promise<T | null>;
  /**
   * Download + verify + extract under `stagingDir` and return the tree to
   * commit. Runs before the commit lock — concurrent installers prepare in
   * parallel. Whatever it throws propagates to the caller unwrapped.
   */
  prepare: (stagingDir: string) => Promise<string>;
  log: PinoLogger;
  /** `[acp-launch]` / `[managed-runtime]` — tags every log line. */
  logPrefix: string;
  /** Stable identifiers (`{id, version}` / `{kind, version}`) carried on every log line. */
  logContext: Record<string, unknown>;
  /** Log message emitted on a successful fresh commit. */
  installedMessage: string;
  /** Error message for a committed tree that still fails `findInstalled`. */
  missingAfterCommitMessage: string;
  /** Test seam for synchronizing concurrent installers immediately before commit. */
  beforeCommit?: () => Promise<void>;
  /** Test seam — defaults to the production commit-lock timeout. */
  commitLockTimeoutMs?: number;
}

/**
 * Install once per version dir; later calls reuse the committed tree via the
 * caller's `findInstalled` fast path. Errors propagate unwrapped so each
 * caller keeps its own error contract.
 */
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

    // A concurrent installer may have finished the same version while we
    // downloaded — adopt it and drop our copy rather than racing on the rename.
    const raced = await opts.findInstalled();
    if (raced !== null) return raced;
    await opts.beforeCommit?.();

    try {
      return await withFileLock(
        `${opts.versionDir}.install.lock`,
        async () => {
          // Only the commit is serialized: concurrent installers download in
          // parallel, but none can remove a complete tree installed by another.
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
