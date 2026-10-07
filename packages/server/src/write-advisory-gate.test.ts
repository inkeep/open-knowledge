import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from './logger.ts';
import {
  createWriteAdvisoryGate,
  WRITE_ADVISORY_GATE_CLOSED_LOG,
  WRITE_ADVISORY_GATE_LOG_INTERVAL_MS,
  WRITE_ADVISORY_GATE_REOPENED_LOG,
  type WriteAdvisoryGate,
} from './write-advisory-gate.ts';

const LATE_FAILURE_MESSAGE = '[write-advisory] deferred advisory failed after its deadline';

function warnMessages(warn: { mock: { calls: unknown[][] } }): unknown[] {
  return warn.mock.calls.map((call) => call[1]);
}

function captureGateLines(): () => Array<[string, unknown]> {
  const lines: Array<[string, unknown]> = [];
  const logger = getLogger('write-advisory');
  const capture = (data: unknown, message: string): void => {
    if (
      message === WRITE_ADVISORY_GATE_CLOSED_LOG ||
      message === WRITE_ADVISORY_GATE_REOPENED_LOG
    ) {
      lines.push([message, data]);
    }
  };
  vi.spyOn(logger, 'warn').mockImplementation(capture);
  vi.spyOn(logger, 'info').mockImplementation(capture);
  return () => [...lines];
}

function stalled<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('write advisory gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('returns the advisory when it answers before the deadline', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });

    const result = gate.run(
      'link-check',
      async () => ['checked'],
      () => ['fallback'],
    );

    await expect(result).resolves.toEqual(['checked']);
  });

  test('answers with the fallback at the deadline while the advisory is still waiting', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const slow = stalled<string>();
    let settled: string | undefined;

    void gate
      .run(
        'orphan-hints',
        () => slow.promise,
        () => 'deferred',
      )
      .then((value) => {
        settled = value;
      });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe('deferred');
    slow.resolve('late');
  });

  test('propagates an advisory failure that arrives before the deadline', async () => {
    const warn = vi.spyOn(getLogger('write-advisory'), 'warn');
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });

    const result = gate.run(
      'link-check',
      async () => {
        throw new Error('index closed');
      },
      () => 'fallback',
    );

    await expect(result).rejects.toThrow('index closed');
    await vi.advanceTimersByTimeAsync(0);
    expect(warnMessages(warn)).not.toContain(LATE_FAILURE_MESSAGE);
  });

  test('logs an advisory failure that arrives after the deadline with its kind and error', async () => {
    const warn = vi.spyOn(getLogger('write-advisory'), 'warn');
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const failing = stalled<string>();
    const first = gate.run(
      'lint-links',
      () => failing.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe('deferred');
    const failure = new Error('index closed late');

    failing.reject(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith(
      { err: failure, advisory: 'lint-links' },
      LATE_FAILURE_MESSAGE,
    );
  });

  async function closeFor(gate: WriteAdvisoryGate, closedMs: number): Promise<void> {
    const slow = stalled<string>();
    const deferred = gate.run(
      'orphan-hints',
      () => slow.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(deferred).resolves.toBe('deferred');
    await vi.advanceTimersByTimeAsync(closedMs);
    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
  }

  test('logs the gate reopening with how long it was closed and how many advisories it skipped', async () => {
    const gateLines = captureGateLines();
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const slow = stalled<string>();
    const first = gate.run(
      'link-check',
      () => slow.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe('deferred');
    const closedLine: [string, unknown] = [
      WRITE_ADVISORY_GATE_CLOSED_LOG,
      { advisory: 'link-check', deadlineMs: 1_000, closings: 1, busySkipped: 0, closedMs: 0 },
    ];
    expect(gateLines()).toEqual([closedLine]);

    await gate.run(
      'lint-links',
      async () => 'checked',
      () => 'busy',
    );
    await gate.run(
      'orphan-hints',
      async () => 'checked',
      () => 'busy',
    );
    await vi.advanceTimersByTimeAsync(4_000);
    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(gateLines()).toEqual([closedLine]);

    await vi.advanceTimersByTimeAsync(WRITE_ADVISORY_GATE_LOG_INTERVAL_MS);

    expect(gateLines()).toEqual([
      closedLine,
      [WRITE_ADVISORY_GATE_REOPENED_LOG, { closings: 0, busySkipped: 2, closedMs: 4_000 }],
    ]);
  });

  test('a gate that never reopens logs its closing once and no reopening', async () => {
    const gateLines = captureGateLines();
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const stuck = stalled<string>();
    const first = gate.run(
      'orphan-hints',
      () => stuck.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe('deferred');

    for (let index = 0; index < 5; index++) {
      await gate.run(
        'link-check',
        async () => 'checked',
        () => 'busy',
      );
    }
    await vi.advanceTimersByTimeAsync(3 * WRITE_ADVISORY_GATE_LOG_INTERVAL_MS);

    expect(gateLines()).toEqual([
      [
        WRITE_ADVISORY_GATE_CLOSED_LOG,
        { advisory: 'orphan-hints', deadlineMs: 1_000, closings: 1, busySkipped: 0, closedMs: 0 },
      ],
    ]);
    stuck.resolve('late');
  });

  test('closings inside one log interval are carried by the line that ends it', async () => {
    const gateLines = captureGateLines();
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });

    await closeFor(gate, 2_000);
    await closeFor(gate, 3_000);
    await closeFor(gate, 500);
    expect(gateLines()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WRITE_ADVISORY_GATE_LOG_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(2 * WRITE_ADVISORY_GATE_LOG_INTERVAL_MS);

    expect(gateLines()).toEqual([
      [
        WRITE_ADVISORY_GATE_CLOSED_LOG,
        { advisory: 'orphan-hints', deadlineMs: 1_000, closings: 1, busySkipped: 0, closedMs: 0 },
      ],
      [WRITE_ADVISORY_GATE_REOPENED_LOG, { closings: 2, busySkipped: 0, closedMs: 5_500 }],
    ]);
  });

  test('a reopening after a quiet log interval is logged at once', async () => {
    const gateLines = captureGateLines();
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });

    await closeFor(gate, WRITE_ADVISORY_GATE_LOG_INTERVAL_MS);

    expect(gateLines()).toEqual([
      [
        WRITE_ADVISORY_GATE_CLOSED_LOG,
        { advisory: 'orphan-hints', deadlineMs: 1_000, closings: 1, busySkipped: 0, closedMs: 0 },
      ],
      [
        WRITE_ADVISORY_GATE_REOPENED_LOG,
        { closings: 0, busySkipped: 0, closedMs: WRITE_ADVISORY_GATE_LOG_INTERVAL_MS },
      ],
    ]);
  });

  test('skips new advisories without starting them while an earlier one is overdue, then resumes', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const slow = stalled<string>();
    const first = gate.run(
      'link-check',
      () => slow.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe('deferred');
    const work = vi.fn(async () => 'checked');

    await expect(gate.run('lint-links', work, () => 'busy')).resolves.toBe('busy');
    expect(work).not.toHaveBeenCalled();

    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);

    await expect(gate.run('lint-links', work, () => 'busy')).resolves.toBe('checked');
    expect(work).toHaveBeenCalledTimes(1);
  });

  test('stays closed until every overdue advisory has settled', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const first = stalled<string>();
    const second = stalled<string>();
    const firstRun = gate.run(
      'link-check',
      () => first.promise,
      () => 'deferred',
    );
    const secondRun = gate.run(
      'orphan-hints',
      () => second.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstRun).resolves.toBe('deferred');
    await expect(secondRun).resolves.toBe('deferred');
    const work = vi.fn(async () => 'checked');

    first.resolve('late');
    await vi.advanceTimersByTimeAsync(0);

    await expect(gate.run('lint-links', work, () => 'busy')).resolves.toBe('busy');
    expect(work).not.toHaveBeenCalled();

    second.resolve('late');
    await vi.advanceTimersByTimeAsync(0);

    await expect(gate.run('lint-links', work, () => 'busy')).resolves.toBe('checked');
    expect(work).toHaveBeenCalledTimes(1);
  });

  test('an overdue advisory that later fails also reopens the gate', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });
    const failing = stalled<string>();
    const first = gate.run(
      'link-check',
      () => failing.promise,
      () => 'deferred',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe('deferred');

    failing.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      gate.run(
        'link-check',
        async () => 'checked',
        () => 'busy',
      ),
    ).resolves.toBe('checked');
  });

  test('advisories that answer in time never close the gate', async () => {
    const gate = createWriteAdvisoryGate({ deadlineMs: 1_000 });

    for (let index = 0; index < 5; index++) {
      await expect(
        gate.run(
          'orphan-hints',
          async () => index,
          () => -1,
        ),
      ).resolves.toBe(index);
    }
  });
});
