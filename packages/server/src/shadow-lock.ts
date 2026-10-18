import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { getLogger } from './logger.ts';
import { isValidLockPid } from './process-alive.ts';
import {
  assessLockHolder,
  processStartToken,
  readProcessStart,
  verdictHoldsLock,
} from './process-identity.ts';

const log = getLogger('shadow-lock');

export interface LockMetadata {
  pid: number;
  hostname: string;
  startedAt: string;
  worktreeRoot: string;
  processStart?: unknown;
}

export function acquireLock(shadowDir: string, worktreeRoot: string): string {
  const lockPath = resolve(shadowDir, 'lock');

  if (existsSync(lockPath)) {
    let existing: LockMetadata | null = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockMetadata;
    } catch {
      log.warn({ lockPath }, `Corrupt lock file at ${lockPath} — replacing`);
    }

    if (existing && !isValidLockPid(existing.pid)) {
      log.warn(
        { lockPath, lockPid: String(existing.pid) },
        `Invalid lock pid (${String(existing.pid)}) at ${lockPath} — replacing`,
      );
      existing = null;
    }
    if (existing) {
      const sameHost = existing.hostname === hostname();
      const assessment =
        sameHost && existing.pid !== process.pid
          ? assessLockHolder(existing, { sameMachine: true, formatRecordsMachineId: false })
          : undefined;
      if (sameHost && existing.pid === process.pid) {
      } else if (assessment !== undefined && verdictHoldsLock(assessment.verdict)) {
        if (assessment.verdict === 'unverified') {
          log.warn(
            { lockPid: existing.pid, holder: assessment.verdict, cause: assessment.cause },
            `Could not confirm that pid=${existing.pid} wrote ${lockPath}; refusing to replace it`,
          );
        }
        throw new Error(
          `Shadow repo at ${shadowDir} is locked by another writer ` +
            `(pid=${existing.pid}, worktree=${existing.worktreeRoot}, ` +
            `started=${existing.startedAt}). ` +
            `Only one active writer instance may mutate a given shadow root at a time.`,
        );
      } else {
        log.warn(
          {
            lockPid: existing.pid,
            host: existing.hostname,
            ...(assessment !== undefined && { holder: assessment.verdict }),
          },
          `Stale lock detected (pid=${existing.pid}, host=${existing.hostname}) — replacing`,
        );
      }
    }
  }

  const ownStart = readProcessStart(process.pid);
  const processStart = processStartToken(ownStart);
  if (processStart === undefined) {
    const reason = ownStart === null ? 'start-unreadable' : 'boot-id-unreadable';
    log.warn(
      { event: 'process-start-unrecorded', platform: process.platform, reason },
      `Writing the shadow lock without a processStart (${reason}); readers fall back to its startedAt margin`,
    );
  }
  const metadata: LockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    worktreeRoot,
    ...(processStart !== undefined && { processStart }),
  };

  writeFileSync(lockPath, JSON.stringify(metadata, null, 2), 'utf-8');
  return lockPath;
}

export function releaseLock(shadowDir: string): void {
  const lockPath = resolve(shadowDir, 'lock');
  try {
    unlinkSync(lockPath);
  } catch {}
}
