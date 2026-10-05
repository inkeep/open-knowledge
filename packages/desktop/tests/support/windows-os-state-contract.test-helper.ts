import assert from 'node:assert/strict';
import type { PtyOsObservation } from '../../src/utility/pty-host.ts';
import {
  WINDOWS_OS_MAX_CANDIDATES,
  WINDOWS_OS_MAX_RESULT_BYTES,
  WINDOWS_OS_MAX_TARGETS,
  WINDOWS_OS_MAX_THREADS,
} from './windows-os-state.test-helper.ts';

const unavailableReasons = new Set([
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
]);
const threadStates = new Set([
  'initialized',
  'ready',
  'running',
  'standby',
  'terminated',
  'wait',
  'transition',
  'unknown',
]);
const waitReasons = new Set([
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
  'unknown',
  'not-applicable',
]);
const candidateFailureReasons = new Set([
  'process-absent',
  'access-unavailable',
  'identity-changed',
]);

function assertRecord(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
}

function assertEnum(value: unknown, values: Set<string>): void {
  assert.ok(typeof value === 'string' && values.has(value));
}

function assertNonnegativeNumber(value: unknown): void {
  assert.ok(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER,
  );
}

function assertNonnegativeInteger(value: unknown): void {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function assertPositiveInteger(value: unknown): void {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function assertProcess(value: unknown): void {
  assertRecord(value, [
    'pid',
    'parentPid',
    'createdAtMs',
    'first',
    'second',
    'threads',
    'omittedThreads',
  ]);
  assertPositiveInteger(value.pid);
  if (value.parentPid !== null) assertNonnegativeInteger(value.parentPid);
  assertNonnegativeNumber(value.createdAtMs);
  for (const sample of [value.first, value.second]) {
    assertRecord(sample, ['userMs', 'kernelMs', 'threadCount']);
    assertNonnegativeNumber(sample.userMs);
    assertNonnegativeNumber(sample.kernelMs);
    assertNonnegativeInteger(sample.threadCount);
  }
  assert.ok(Array.isArray(value.threads) && value.threads.length <= WINDOWS_OS_MAX_THREADS);
  for (const thread of value.threads) {
    assertRecord(thread, ['id', 'state', 'waitReason']);
    assertPositiveInteger(thread.id);
    assertEnum(thread.state, threadStates);
    assertEnum(thread.waitReason, waitReasons);
    assert.equal(thread.state === 'wait', thread.waitReason !== 'not-applicable');
  }
  assertNonnegativeInteger(value.omittedThreads);
}

function assertMachineSample(value: unknown): void {
  assertRecord(value, ['atMs', 'logicalCpus', 'userMs', 'systemMs', 'idleMs', 'irqMs', 'niceMs']);
  assertNonnegativeNumber(value.atMs);
  assertPositiveInteger(value.logicalCpus);
  for (const field of ['userMs', 'systemMs', 'idleMs', 'irqMs', 'niceMs']) {
    assertNonnegativeNumber(value[field]);
  }
}

function assertConsole(value: unknown): void {
  assertRecord(value, [
    'association',
    'candidateCount',
    'candidates',
    'unavailableCandidates',
    'omittedCandidates',
  ]);
  assert.equal(value.association, 'candidate-parent-relation');
  assertNonnegativeInteger(value.candidateCount);
  assert.ok(
    Array.isArray(value.candidates) && value.candidates.length <= WINDOWS_OS_MAX_CANDIDATES,
  );
  for (const candidate of value.candidates) assertProcess(candidate);
  assert.ok(
    Array.isArray(value.unavailableCandidates) &&
      value.unavailableCandidates.length <= WINDOWS_OS_MAX_CANDIDATES,
  );
  let unavailableCount = 0;
  for (const candidate of value.unavailableCandidates) {
    assertRecord(candidate, ['reason', 'count']);
    assertEnum(candidate.reason, candidateFailureReasons);
    assertPositiveInteger(candidate.count);
    unavailableCount += candidate.count as number;
  }
  assertNonnegativeInteger(value.omittedCandidates);
  assert.equal(
    value.candidateCount,
    value.candidates.length + unavailableCount + (value.omittedCandidates as number),
  );
}

function assertWorker(value: unknown): void {
  assertRecord(value, ['nodeThreadId', 'requestedAtMs', 'repliedAtMs', 'userMs', 'systemMs']);
  assertPositiveInteger(value.nodeThreadId);
  assertNonnegativeNumber(value.requestedAtMs);
  assertNonnegativeNumber(value.repliedAtMs);
  assert.ok((value.repliedAtMs as number) >= (value.requestedAtMs as number));
  assertNonnegativeNumber(value.userMs);
  assertNonnegativeNumber(value.systemMs);
}

function assertSection(value: unknown, assertCaptured: (captured: unknown) => void): void {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const section = value as Record<string, unknown>;
  if (section.status === 'unavailable') {
    assertRecord(section, ['status', 'reason']);
    assertEnum(section.reason, unavailableReasons);
    return;
  }
  assertRecord(section, ['status', 'value']);
  assert.equal(section.status, 'captured');
  assertCaptured(section.value);
}

export function assertBoundedWindowsOsState(
  value: unknown,
  expectedPid: number,
): asserts value is PtyOsObservation {
  assertRecord(value, [
    'version',
    'status',
    'reason',
    'requestedPid',
    'targets',
    'startedAtMs',
    'completedAtMs',
    'shell',
    'machine',
    'console',
    'worker',
    'helper',
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= WINDOWS_OS_MAX_RESULT_BYTES);
  assert.equal(value.version, 1);
  assert.equal(value.requestedPid, expectedPid);
  assertPositiveInteger(value.requestedPid);
  assert.ok(['captured', 'partial', 'unavailable'].includes(value.status as string));
  if (value.reason !== null) assertEnum(value.reason, unavailableReasons);
  if (value.startedAtMs !== null) assertNonnegativeNumber(value.startedAtMs);
  if (value.completedAtMs !== null) assertNonnegativeNumber(value.completedAtMs);
  assert.ok(Array.isArray(value.targets) && value.targets.length <= WINDOWS_OS_MAX_TARGETS);
  for (const target of value.targets) {
    assertRecord(target, ['requestedPid', 'shell']);
    assertPositiveInteger(target.requestedPid);
    assertSection(target.shell, assertProcess);
    if ((target.shell as PtyOsObservation['shell']).status === 'captured') {
      assert.equal(
        (target.shell as Extract<PtyOsObservation['shell'], { status: 'captured' }>).value.pid,
        target.requestedPid,
      );
    }
  }
  if (value.targets.length > 0) {
    assert.equal(value.targets[0]?.requestedPid, expectedPid);
    assert.deepEqual(value.targets[0]?.shell, value.shell);
  } else {
    assert.equal(value.reason, 'output-limit');
  }
  assertSection(value.shell, assertProcess);
  if ((value.shell as PtyOsObservation['shell']).status === 'captured') {
    assert.equal(
      (value.shell as Extract<PtyOsObservation['shell'], { status: 'captured' }>).value.pid,
      expectedPid,
    );
  }
  assertSection(value.machine, (captured) => {
    assertRecord(captured, ['first', 'second']);
    assertMachineSample(captured.first);
    assertMachineSample(captured.second);
    assert.ok(
      (captured.second as { atMs: number }).atMs >= (captured.first as { atMs: number }).atMs,
    );
  });
  assertSection(value.console, assertConsole);
  assertSection(value.worker, assertWorker);
  assertRecord(value.helper, ['requested', 'reason', 'delivery', 'exit', 'exitCode']);
  assert.equal(typeof value.helper.requested, 'boolean');
  if (value.helper.reason !== null) {
    assertEnum(value.helper.reason, new Set(['deadline', 'output-limit', 'owner-loss']));
  }
  assert.equal(value.helper.requested, value.helper.reason !== null);
  assertEnum(
    value.helper.delivery,
    new Set(['not-attempted', 'no-pid', 'already-exited', 'accepted', 'rejected', 'threw']),
  );
  assertEnum(
    value.helper.exit,
    new Set([
      'not-observed',
      'observed-before-request',
      'observed-after-request',
      'cooperative-deadline',
      'cooperative-owner-loss',
    ]),
  );
  if (value.helper.exitCode !== null) assertNonnegativeInteger(value.helper.exitCode);
  if (value.status === 'captured') {
    assert.equal(value.reason, null);
    assert.equal((value.shell as PtyOsObservation['shell']).status, 'captured');
    assert.equal((value.machine as PtyOsObservation['machine']).status, 'captured');
    assert.equal((value.console as PtyOsObservation['console']).status, 'captured');
    assert.equal((value.worker as PtyOsObservation['worker']).status, 'captured');
    assert.equal(
      (value.console as Extract<PtyOsObservation['console'], { status: 'captured' }>).value
        .unavailableCandidates.length,
      0,
    );
  } else {
    assert.notEqual(value.reason, null);
    if (value.status === 'partial') {
      assert.equal((value.shell as PtyOsObservation['shell']).status, 'captured');
      assert.ok(
        (value.machine as PtyOsObservation['machine']).status !== 'captured' ||
          (value.console as PtyOsObservation['console']).status !== 'captured' ||
          (value.worker as PtyOsObservation['worker']).status !== 'captured' ||
          (value.console as Extract<PtyOsObservation['console'], { status: 'captured' }>).value
            .unavailableCandidates.length > 0,
      );
    } else {
      assert.equal((value.shell as PtyOsObservation['shell']).status, 'unavailable');
    }
  }
}
