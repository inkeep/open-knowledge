import { setTimeout } from 'node:timers/promises';
import { isProcessAlive } from '@inkeep/open-knowledge-server';
import { getCliLogger } from '../cli-logger.ts';
import { inspectLock } from './lock-state.ts';
import { readRemovalProcessStart } from './removal-process-start.ts';
import { runStop } from './stop.ts';

interface StopForRemovalOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  readProcessStart?: (pid: number) => number | null;
  isAlive?: (pid: number) => boolean;
}

export async function stopServerForRemoval(
  lockDir: string,
  options: StopForRemovalOptions = {},
): Promise<{ stopped: number; failed: Array<{ pid: number; error: string }> }> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const state = inspectLock(lockDir, 'server', { isAlive });
  const lockRecovery =
    'Quit OpenKnowledge and stop any OpenKnowledge server processes. ' +
    `Once you have confirmed they have exited, remove the stale lock file at ${state.lockPath} and retry cleanup.`;
  const refusal = (message: string): Error => {
    getCliLogger()?.warn({ lockDir, lockPath: state.lockPath, status: state.status }, message);
    return new Error(message);
  };
  if (state.status === 'corrupt') {
    throw refusal(
      `Cannot verify shutdown from the unreadable server lock at ${state.lockPath}. ${lockRecovery}`,
    );
  }
  if (state.status === 'foreign-host') {
    throw refusal(
      `Cannot verify shutdown: the server lock at ${state.lockPath} belongs to another machine. ` +
        'Stop OpenKnowledge on the owning machine. Confirm that no OpenKnowledge server is using this directory on the owning machine or any other machine sharing it. ' +
        `Only then remove the stale lock file at ${state.lockPath} and retry cleanup.`,
    );
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
