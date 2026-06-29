
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { isProcessAlive, isValidLockPid } from './process-alive.ts';

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
      console.warn(`[shadow-lock] Corrupt lock file at ${lockPath} — replacing`);
    }

    if (existing && !isValidLockPid(existing.pid)) {
      console.warn(
        `[shadow-lock] Invalid lock pid (${String(existing.pid)}) at ${lockPath} — replacing`,
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
        console.warn(
          `[shadow-lock] Stale lock detected (pid=${existing.pid}, host=${existing.hostname}) — replacing`,
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
  } catch {
  }
}
