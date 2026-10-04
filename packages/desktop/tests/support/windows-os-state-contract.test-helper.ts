import assert from 'node:assert/strict';
import type { PtyOsObservation } from '../../src/utility/pty-host.ts';

const allowedStrings = new Set([
  'captured',
  'partial',
  'unavailable',
  'deadline',
  'no-budget',
  'unsupported-platform',
  'query-start-failed',
  'query-exited',
  'invalid-json',
  'invalid-shape',
  'output-limit',
  'owner-loss',
  'process-absent',
  'access-unavailable',
  'identity-changed',
  'worker-request-deadline',
  'worker-unavailable',
  'console-identity-unavailable',
  'candidate-parent-relation',
  'initialized',
  'ready',
  'running',
  'standby',
  'terminated',
  'wait',
  'transition',
  'unknown',
  'executive',
  'free-page',
  'page-in',
  'pool-allocation',
  'execution-delay',
  'suspended',
  'user-request',
  'event-pair-high',
  'event-pair-low',
  'lpc-receive',
  'lpc-reply',
  'virtual-memory',
  'page-out',
  'not-applicable',
  'not-attempted',
  'no-pid',
  'already-exited',
  'accepted',
  'rejected',
  'threw',
  'not-observed',
  'observed-before-request',
  'observed-after-request',
  'cooperative-deadline',
  'cooperative-owner-loss',
]);

function verifyLeaves(value: unknown): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
    return;
  }
  if (typeof value === 'string') {
    assert.ok(allowedStrings.has(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) verifyLeaves(item);
    return;
  }
  assert.equal(typeof value, 'object');
  for (const item of Object.values(value as Record<string, unknown>)) verifyLeaves(item);
}

export function assertCapturedWindowsOsState(
  value: unknown,
  expectedPid: number,
  requireWorker: boolean,
): asserts value is PtyOsObservation {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  verifyLeaves(value);
  const observation = value as PtyOsObservation;
  assert.equal(observation.version, 1);
  assert.equal(observation.requestedPid, expectedPid);
  assert.equal(observation.shell.status, 'captured');
  assert.equal(observation.machine.status, 'captured');
  assert.equal(observation.console.status, 'captured');
  if (
    observation.shell.status !== 'captured' ||
    observation.machine.status !== 'captured' ||
    observation.console.status !== 'captured'
  )
    return;
  assert.equal(observation.shell.value.pid, expectedPid);
  assert.ok(observation.shell.value.createdAtMs > 0);
  assert.ok(observation.shell.value.first.threadCount >= 1);
  assert.ok(observation.shell.value.second.threadCount >= 1);
  assert.ok(observation.shell.value.threads.length >= 1);
  assert.ok(observation.machine.value.first.logicalCpus >= 1);
  assert.ok(observation.machine.value.second.logicalCpus >= 1);
  assert.ok(observation.startedAtMs !== null);
  assert.ok(observation.completedAtMs !== null);
  assert.ok(observation.startedAtMs <= observation.machine.value.first.atMs);
  assert.ok(observation.machine.value.second.atMs >= observation.machine.value.first.atMs);
  assert.ok(observation.machine.value.second.atMs <= observation.completedAtMs);
  const consoleState = observation.console.value;
  assert.ok(Number.isSafeInteger(consoleState.candidateCount));
  assert.ok(consoleState.candidateCount >= 0);
  const failedCandidates = consoleState.unavailableCandidates.reduce((count, item) => {
    assert.ok(['process-absent', 'access-unavailable', 'identity-changed'].includes(item.reason));
    assert.ok(Number.isSafeInteger(item.count) && item.count > 0);
    return count + item.count;
  }, 0);
  assert.equal(
    consoleState.candidateCount,
    consoleState.candidates.length + failedCandidates + consoleState.omittedCandidates,
  );
  assert.equal(observation.helper.requested, false);
  assert.equal(observation.helper.exit, 'observed-before-request');
  if (requireWorker) {
    assert.equal(observation.worker.status, 'captured');
    if (observation.worker.status === 'captured') {
      assert.ok(observation.worker.value.nodeThreadId > 0);
      assert.ok(observation.worker.value.repliedAtMs >= observation.worker.value.requestedAtMs);
    }
  }
}
