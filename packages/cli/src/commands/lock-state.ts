import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  isProcessAlive,
  isValidLockPid,
  type LockName,
  lockFilePath,
  type ProcessLockMetadata,
} from '@inkeep/open-knowledge-server';

export type LockState =
  | { status: 'missing'; lockPath: string }
  | { status: 'corrupt'; lockPath: string }
  | { status: 'foreign-host'; lockPath: string; lock: ProcessLockMetadata }
  | { status: 'dead-pid'; lockPath: string; lock: ProcessLockMetadata }
  | { status: 'alive'; lockPath: string; lock: ProcessLockMetadata };

interface InspectLockOptions {
  isAlive?: (pid: number) => boolean;
  host?: string;
}

export function inspectLock(
  lockDir: string,
  lockName: LockName,
  opts: InspectLockOptions = {},
): LockState {
  const lockPath = lockFilePath(lockDir, lockName);
  if (!existsSync(lockPath)) return { status: 'missing', lockPath };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return { status: 'corrupt', lockPath };
  }
  if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid)) {
    return { status: 'corrupt', lockPath };
  }
  const lock = parsed as ProcessLockMetadata;

  const aliveProbe = opts.isAlive ?? isProcessAlive;
  if (!aliveProbe(lock.pid)) {
    return { status: 'dead-pid', lockPath, lock };
  }
  const localHost = opts.host ?? hostname();
  if (lock.hostname !== localHost) {
    return { status: 'foreign-host', lockPath, lock };
  }
  return { status: 'alive', lockPath, lock };
}
