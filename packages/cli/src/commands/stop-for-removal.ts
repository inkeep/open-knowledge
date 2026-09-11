import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  isProcessAlive,
  type LockProcessScan,
  scanLockProcesses,
} from '@inkeep/open-knowledge-server';
import { getCliLogger } from '../cli-logger.ts';
import { describeLockOwnershipRefusal, inspectLock } from './lock-state.ts';
import { readRemovalProcessStart } from './removal-process-start.ts';
import { runStop } from './stop.ts';

interface StopForRemovalOptions {
  preserveProjectState?: boolean;
  scanProcesses?: () => Promise<LockProcessScan>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readProcessStart?: (pid: number) => number | null;
  isAlive?: (pid: number) => boolean;
}

export async function stopServerForRemoval(
  lockDir: string,
  options: StopForRemovalOptions = {},
): Promise<{ stopped: number; failed: Array<{ pid: number; error: string }>; skipped?: string }> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const state = inspectLock(lockDir, 'server', { isAlive });
  const lockRecovery =
    'Quit OpenKnowledge and stop any OpenKnowledge server processes. ' +
    `Once you have confirmed they have exited, remove the stale lock file at ${state.lockPath} and retry cleanup.`;
  const refusal = (message: string): Error => {
    getCliLogger()?.warn({ lockDir, lockPath: state.lockPath, status: state.status }, message);
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
    const scan = await (options.scanProcesses ?? scanLockProcesses)();
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
  if (state.status === 'alive') {
    const lockStartedAt =
      typeof state.lock.startedAt === 'string' ? Date.parse(state.lock.startedAt) : Number.NaN;
    if (!Number.isFinite(lockStartedAt)) {
      throw refusal(`The server lock has no valid start time. ${lockRecovery}`);
    }
    const processStartedAt = (options.readProcessStart ?? readRemovalProcessStart)(state.lock.pid);
    if (processStartedAt === null) {
      if (!isAlive(state.lock.pid)) return { stopped: 0, failed: [] };
      const probeRecovery =
        process.platform === 'linux'
          ? 'Linux requires ps supporting -p and -o lstart= (such as procps). Install a compatible ps and retry, or stop the server manually. '
          : 'Stop the server manually. ';
      throw refusal(
        `Cannot verify the identity of process ${state.lock.pid}; the OS process-start query failed or is unavailable, so it was not signalled. ` +
          probeRecovery +
          'Confirm the OpenKnowledge server has exited before retrying cleanup after a manual stop.',
      );
    }
    if (processStartedAt > lockStartedAt) {
      throw refusal(
        `Process ${state.lock.pid} started after the server lock was acquired; it was not signalled. ${lockRecovery}`,
      );
    }
  }
  const outcome = await runStop({
    lockDir,
    inspect: () => state,
    force: true,
    log: () => {},
    error: () => {},
  });
  const failed = outcome.failed.map((failure) => ({
    pid: failure.target.pid,
    error: failure.error,
  }));
  const pending = new Set(outcome.stopped.map((target) => target.pid));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  while (pending.size > 0) {
    for (const pid of pending) {
      if (!isAlive(pid)) pending.delete(pid);
    }
    if (pending.size === 0) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await setTimeout(Math.min(options.pollIntervalMs ?? 50, remaining));
  }
  for (const pid of pending) {
    failed.push({ pid, error: `still running ${timeoutMs}ms after SIGTERM` });
  }
  return { stopped: outcome.stopped.length - pending.size, failed };
}
