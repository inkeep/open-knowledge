import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { getLogger } from './logger.ts';
import { isProcessAlive, isValidLockPid } from './process-alive.ts';

const log = getLogger('shadow-lock');

export interface LockMetadata {
  pid: number;
  hostname: string;
  startedAt: string;
  worktreeRoot: string;
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
        { lockPath, pid: String(existing.pid) },
        `Invalid lock pid (${String(existing.pid)}) at ${lockPath} — replacing`,
      );
      existing = null;
    }
    if (existing) {
      const sameHost = existing.hostname === hostname();
      if (sameHost && existing.pid === process.pid) {
      } else if (sameHost && isProcessAlive(existing.pid)) {
        throw new Error(
          `Shadow repo at ${shadowDir} is locked by another writer ` +
            `(pid=${existing.pid}, worktree=${existing.worktreeRoot}, ` +
            `started=${existing.startedAt}). ` +
            `Only one active writer instance may mutate a given shadow root at a time.`,
        );
      } else {
        log.warn(
          { pid: existing.pid, host: existing.hostname },
          `Stale lock detected (pid=${existing.pid}, host=${existing.hostname}) — replacing`,
        );
      }
    }
  }

  const metadata: LockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    worktreeRoot,
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
