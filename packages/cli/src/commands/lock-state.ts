import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  getMachineId,
  isProcessAlive,
  isValidLockPid,
  type LockName,
  lockFilePath,
  type ProcessLockMetadata,
} from '@inkeep/open-knowledge-server';

export type LockState =
  | { status: 'missing'; lockPath: string }
  | { status: 'corrupt'; lockPath: string; foreignHost?: boolean }
  | { status: 'read-error'; lockPath: string; error: string }
  | {
      status: 'foreign-host';
      lockPath: string;
      lock: ProcessLockMetadata;
    }
  | { status: 'unverified-owner'; lockPath: string; pid: number }
  | { status: 'dead-pid'; lockPath: string; lock: ProcessLockMetadata }
  | { status: 'alive'; lockPath: string; lock: ProcessLockMetadata };

interface InspectLockOptions {
  isAlive?: (pid: number) => boolean;
  host?: string;
  machineId?: string;
}

export function inspectLock(
  lockDir: string,
  lockName: LockName,
  opts: InspectLockOptions = {},
): LockState {
  const lockPath = lockFilePath(lockDir, lockName);
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'missing', lockPath };
    }
    return {
      status: 'read-error',
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', lockPath };
  }
  const metadata = parsed && typeof parsed === 'object' ? parsed : {};
  const foreignHost =
    'machineId' in metadata && typeof metadata.machineId === 'string'
      ? metadata.machineId !== (opts.machineId ?? getMachineId())
      : 'hostname' in metadata &&
        typeof metadata.hostname === 'string' &&
        metadata.hostname !== (opts.host ?? hostname());
  if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid)) {
    return { status: 'corrupt', lockPath, ...(foreignHost ? { foreignHost: true } : {}) };
  }
  const pid = (parsed as { pid: number }).pid;
  const hasOwner =
    ('machineId' in metadata && typeof metadata.machineId === 'string') ||
    ('hostname' in metadata && typeof metadata.hostname === 'string');
  if (foreignHost) {
    return { status: 'foreign-host', lockPath, lock: parsed as ProcessLockMetadata };
  }
  if (!(opts.isAlive ?? isProcessAlive)(pid)) {
    return { status: 'dead-pid', lockPath, lock: parsed as ProcessLockMetadata };
  }
  if (!hasOwner) return { status: 'unverified-owner', lockPath, pid };
  return { status: 'alive', lockPath, lock: parsed as ProcessLockMetadata };
}

export function describeLockOwnershipRefusal(
  state: Extract<LockState, { status: 'foreign-host' | 'corrupt' | 'unverified-owner' }>,
): string {
  if (state.status === 'unverified-owner') {
    return (
      `Cannot verify shutdown: the server lock at ${state.lockPath} does not record its owning machine, ` +
      `and its recorded process ${state.pid} is still running on this machine. ` +
      `Check whether process ${state.pid} is an OpenKnowledge server. If it is, stop it and retry. ` +
      'Do not remove the lock file while that process is running.'
    );
  }
  return (
    `Cannot verify shutdown: the server lock at ${state.lockPath} belongs to another machine. ` +
    'Stop OpenKnowledge on the owning machine. Confirm that no OpenKnowledge server is using this directory on the owning machine or any other machine sharing it. ' +
    `Only then remove the stale lock file at ${state.lockPath} and retry cleanup.`
  );
}
