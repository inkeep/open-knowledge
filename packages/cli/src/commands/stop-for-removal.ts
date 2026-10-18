import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  createProbeFailureReporter,
  isLockProcessRunning,
  isProcessAlive,
  type LockProcessScan,
  type ProcessProbeOptions,
  type ProcessStart,
  scanLockProcesses,
} from '@inkeep/open-knowledge-server';
import { getCliLogger } from '../cli-logger.ts';
import { type HolderProcessStartOptions, readHolderProcessStart } from './holder-process-start.ts';
import { describeLockOwnershipRefusal, inspectLock } from './lock-state.ts';
import { describeUnconfirmedHolderStart, runStop } from './stop.ts';

interface StopForRemovalOptions {
  preserveProjectState?: boolean;
  probe?: (pid: number) => ProcessProbeOptions;
  scanProcesses?: () => Promise<LockProcessScan>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readProcessStart?: (pid: number, options?: HolderProcessStartOptions) => ProcessStart | null;
  isAlive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}

export async function stopServerForRemoval(
  lockDir: string,
  options: StopForRemovalOptions = {},
): Promise<{ stopped: number; failed: Array<{ pid: number; error: string }>; skipped?: string }> {
  const probeOptions = options.probe ?? createProbeFailureReporter();
  const isAlive =
    options.isAlive ?? ((pid: number) => isLockProcessRunning(pid, probeOptions(pid)));
  const hasProcessEntry = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const readHolderStart = (
    pid: number,
    onNativeFailure?: HolderProcessStartOptions['onNativeFailure'],
  ): ProcessStart | null =>
    (options.readProcessStart ?? readHolderProcessStart)(pid, { platform, onNativeFailure });
  const state = inspectLock(lockDir, 'server', { isAlive, readProcessStart: readHolderStart });
  const lockRecovery =
    'Quit OpenKnowledge and stop any OpenKnowledge server processes. ' +
    `Once you have confirmed they have exited, remove the stale lock file at ${state.lockPath} and retry cleanup.`;
  const recordedPid = (): number | undefined => {
    switch (state.status) {
      case 'alive':
      case 'dead-pid':
      case 'reused-pid':
      case 'foreign-host':
        return state.lock.pid;
      case 'unverified-owner':
        return state.pid;
      case 'missing':
      case 'corrupt':
      case 'read-error':
        return undefined;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  };
  const logContext = (): Record<string, unknown> => {
    const lockPid = recordedPid();
    return {
      ...(lockPid === undefined ? {} : { lockPid }),
      lockDir,
      lockPath: state.lockPath,
      status: state.status,
    };
  };
  const refusal = (message: string): Error => {
    getCliLogger()?.warn(logContext(), message);
    return new Error(message);
  };
  if (state.status === 'read-error') {
    throw refusal(
      `Cannot read the server lock at ${state.lockPath}: ${state.error}. Restore file and parent-directory access, then retry cleanup.`,
    );
  }
  const ownershipRefusal =
    state.status === 'unverified-owner' ||
    state.status === 'foreign-host' ||
    (state.status === 'corrupt' && state.foreignHost === true)
      ? state
      : null;
  const foreignHost = ownershipRefusal !== null && ownershipRefusal.status !== 'unverified-owner';
  if (ownershipRefusal !== null && !options.preserveProjectState) {
    throw refusal(describeLockOwnershipRefusal(ownershipRefusal));
  }
  if (state.status === 'dead-pid') {
    return {
      stopped: 0,
      failed: [],
      skipped: `Skipped stale lock at ${state.lockPath}; its recorded local process ${state.lock.pid} has exited. No server was stopped.`,
    };
  }
  if (state.status === 'reused-pid') {
    return {
      stopped: 0,
      failed: [],
      skipped: `Skipped stale lock at ${state.lockPath}; its recorded process ${state.lock.pid} has exited and that process ID now belongs to another program, which was not signalled. No server was stopped.`,
    };
  }
  if (
    state.status === 'corrupt' ||
    state.status === 'foreign-host' ||
    state.status === 'unverified-owner'
  ) {
    const unverifiedOwner = state.status === 'unverified-owner';
    const description = unverifiedOwner
      ? 'unverified'
      : foreignHost
        ? 'foreign-owned'
        : 'malformed';
    const scan = await (options.scanProcesses ?? (() => scanLockProcesses(probeOptions)))();
    const canonical = await realpath(lockDir).catch(() => resolve(lockDir));
    const candidates = scan.candidates.filter(
      (candidate) => candidate.lockDir === canonical && isAlive(candidate.pid),
    );
    if (candidates.length > 0) {
      throw refusal(
        `Cannot verify shutdown from the ${description} lock at ${state.lockPath}: live process candidates ${candidates.map((candidate) => `${candidate.pid} (${candidate.source})`).join(', ')}. No process was signalled. ${lockRecovery}`,
      );
    }
    if (scan.unavailable.length > 0) {
      throw refusal(
        `Cannot rule out a live server for ${state.lockPath}: ${scan.unavailable.join('; ')}. Restore process-inspection access and retry cleanup. ${lockRecovery}`,
      );
    }
    return {
      stopped: 0,
      failed: [],
      skipped: unverifiedOwner
        ? `Retained project lock with an unverified owner at ${state.lockPath}; its recorded process ${state.pid} is running locally, but process and listener inspection could not attribute any server to this directory. No process was signalled. Only local application cleanup may proceed; project state is unchanged. No server was stopped.`
        : foreignHost
          ? `Retained foreign-owned project lock at ${state.lockPath}; process and listener inspection found no local server candidate for this directory. Only local application cleanup may proceed; project state is unchanged. No server was stopped.`
          : `Skipped malformed lock at ${state.lockPath}; process and listener inspection found no live server candidate for this directory. No server was stopped.`,
    };
  }
  const outcome = await runStop({
    lockDir,
    inspect: () => state,
    isAlive,
    readProcessStart: (pid, readOptions) => readHolderStart(pid, readOptions?.onNativeFailure),
    platform,
    force: true,
    refuseHolderStartedAfterLock: true,
    log: () => {},
    error: () => {},
  });
  const unverified = outcome.failed.find((failure) => failure.unverified !== undefined)?.unverified;
  if (unverified !== undefined) {
    switch (unverified.cause) {
      case 'foreign-host':
        throw new Error(
          describeLockOwnershipRefusal({
            status: 'foreign-host',
            lockPath: unverified.lockPath,
            lock: unverified.lock,
          }),
        );
      case 'unverified-owner':
        throw new Error(
          describeLockOwnershipRefusal({
            status: 'unverified-owner',
            lockPath: unverified.lockPath,
            pid: unverified.pid,
          }),
        );
      default:
        throw new Error(
          describeUnconfirmedHolderStart(
            unverified,
            'it was not signalled.',
            `Once you have confirmed no OpenKnowledge server is running for this project, remove ${unverified.lockPath} and retry cleanup.`,
            getCliLogger() !== undefined,
          ),
        );
    }
  }
  const failed = outcome.failed.map((failure) => ({
    pid: failure.target.pid,
    error: failure.error,
  }));
  const pending = new Set(outcome.stopped.map((target) => target.pid));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  while (pending.size > 0) {
    for (const pid of pending) {
      if (!hasProcessEntry(pid)) pending.delete(pid);
    }
    if (pending.size === 0) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await setTimeout(Math.min(options.pollIntervalMs ?? 50, remaining));
  }
  for (const pid of pending) {
    if (!isAlive(pid)) pending.delete(pid);
  }
  for (const pid of pending) {
    failed.push({ pid, error: `still running ${timeoutMs}ms after SIGTERM` });
  }
  return { stopped: outcome.stopped.length - pending.size, failed };
}
