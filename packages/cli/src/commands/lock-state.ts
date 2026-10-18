import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { currentCliCommandName } from '@inkeep/open-knowledge-core';
import {
  assessLockHolder,
  isLockFromThisMachine,
  isValidLockPid,
  type LockName,
  type LockOwnerFields,
  lockFilePath,
  machineIdFilePath,
  type ProcessLockMetadata,
  type ProcessStartReader,
  recordsLockOwner,
  toProcessLockMetadata,
} from '@inkeep/open-knowledge-server';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';

export type LockState =
  | { status: 'missing'; lockPath: string }
  | { status: 'corrupt'; lockPath: string; text: string; foreignHost?: boolean }
  | { status: 'read-error'; lockPath: string; error: string }
  | {
      status: 'foreign-host';
      lockPath: string;
      lock: ProcessLockMetadata;
    }
  | { status: 'unverified-owner'; lockPath: string; pid: number }
  | { status: 'dead-pid'; lockPath: string; lock: ProcessLockMetadata; text: string }
  | { status: 'reused-pid'; lockPath: string; lock: ProcessLockMetadata; text: string }
  | { status: 'alive'; lockPath: string; lock: ProcessLockMetadata };

interface InspectLockOptions {
  isAlive?: (pid: number) => boolean;
  readProcessStart?: ProcessStartReader;
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
    return { status: 'corrupt', lockPath, text: raw };
  }
  const metadata: LockOwnerFields = parsed && typeof parsed === 'object' ? parsed : {};
  const hasOwner = recordsLockOwner(metadata);
  const foreignHost = hasOwner && !isLockFromThisMachine(metadata, opts);
  if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid)) {
    return {
      status: 'corrupt',
      lockPath,
      text: raw,
      ...(foreignHost ? { foreignHost: true } : {}),
    };
  }
  const lock = toProcessLockMetadata(parsed as { pid: number });
  const { pid } = lock;
  if (foreignHost) {
    return { status: 'foreign-host', lockPath, lock };
  }
  const assessment = assessLockHolder(lock, {
    isAlive: opts.isAlive,
    readProcessStart: opts.readProcessStart,
    sameMachine: hasOwner,
  });
  switch (assessment.verdict) {
    case 'gone':
      return { status: 'dead-pid', lockPath, lock, text: raw };
    case 'replaced':
      return { status: 'reused-pid', lockPath, lock, text: raw };
    case 'unverified':
      return assessment.cause === 'unverified-owner'
        ? { status: 'unverified-owner', lockPath, pid }
        : { status: 'alive', lockPath, lock };
    case 'writer':
      return { status: 'alive', lockPath, lock };
    default: {
      const exhaustive: never = assessment;
      return exhaustive;
    }
  }
}

export function describeUnrecordedOwner(pid: number): string {
  return `does not record its owning machine, and its recorded process ${pid} is still running on this machine`;
}

export function describeForeignOwner(lock: ProcessLockMetadata): string {
  return typeof lock.machineId === 'string'
    ? `records a machine ID different from the one in ${machineIdFilePath()}`
    : `records only the host ${escapeDisplayPath(lock.hostname)}, not this machine's ${hostname()}`;
}

function homeFolderVariable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'USERPROFILE' : 'HOME';
}

function describeMissingProcessStart(lock: ProcessLockMetadata): string {
  return lock.processStart === undefined
    ? ` This lock records no process start; a server started by this release records one, which lets \`${currentCliCommandName()} stop\` confirm it from any home folder.`
    : '';
}

export function describeOtherHomeFolderRemedy(
  lock: ProcessLockMetadata,
  platform: NodeJS.Platform,
): string {
  const stop = `\`${currentCliCommandName()} stop\``;
  return (
    `If the server was started on this machine from another account, run ${stop} as that account. ` +
    `If it was started from this account with a different home folder, run ${stop} with \`${homeFolderVariable(platform)}\` set to that folder. ` +
    `Otherwise stop it from the machine that owns the lock.${describeMissingProcessStart(lock)}`
  );
}

function describeOtherHomeFolderCleanupRemedy(
  lock: ProcessLockMetadata,
  platform: NodeJS.Platform,
): string {
  const command = currentCliCommandName();
  return (
    `If the server was started on this machine from another account, run \`${command} stop\` as that account while it is running, or \`${command} clean\` once it has exited. ` +
    `If it was started from this account with a different home folder, run the same command with \`${homeFolderVariable(platform)}\` set to that folder. ` +
    `Otherwise run the same command on the machine that owns the lock.${describeMissingProcessStart(lock)}`
  );
}

function keepTheLockUntilConfirmed(lockPath: string): string {
  return (
    'Confirm that no OpenKnowledge server is using this directory on the owning machine or any other machine sharing it. ' +
    `Only then remove the stale lock file at ${lockPath} and retry cleanup.`
  );
}

export function describeForeignHostRemedy(
  state: Extract<LockState, { status: 'foreign-host' }>,
  platform: NodeJS.Platform = process.platform,
): string {
  const { lock, lockPath } = state;
  const remedy =
    typeof lock.machineId === 'string'
      ? describeOtherHomeFolderCleanupRemedy(lock, platform)
      : `If ${escapeDisplayPath(lock.hostname)} is another machine, stop OpenKnowledge there; if it is an earlier name of this machine, stop OpenKnowledge here if it is still running.`;
  return `${remedy} ${keepTheLockUntilConfirmed(lockPath)}`;
}

export function describeLockOwnershipRefusal(
  state: Extract<LockState, { status: 'foreign-host' | 'corrupt' | 'unverified-owner' }>,
  platform: NodeJS.Platform = process.platform,
): string {
  const { lockPath } = state;
  if (state.status === 'unverified-owner') {
    return (
      `Cannot verify shutdown: the server lock at ${lockPath} ${describeUnrecordedOwner(state.pid)}. ` +
      `Check whether process ${state.pid} is an OpenKnowledge server. If it is, stop it and retry. ` +
      'Do not remove the lock file while that process is running.'
    );
  }
  if (state.status === 'corrupt') {
    return (
      `Cannot verify shutdown: the server lock at ${lockPath} records a machine ID or host name that is not this machine's, so its server may run on another machine, or on this one from another account, with a different home folder, or under an earlier host name. ` +
      `Stop OpenKnowledge wherever it was started. ${keepTheLockUntilConfirmed(lockPath)}`
    );
  }
  return `Cannot verify shutdown: the server lock at ${lockPath} ${describeForeignOwner(state.lock)}. ${describeForeignHostRemedy(state, platform)}`;
}
