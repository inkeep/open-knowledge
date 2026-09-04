import { describe, expect, test } from 'vitest';
import {
  CAPACITY_PROBLEM_TYPE,
  CAPACITY_RETRY_BACKOFF_MS,
  isCapacityRefusal,
  runProjectFixSweep,
  SWEEP_PACE_DELAY_MS,
  SWEEP_PROGRESS_CHUNK,
  SWEEP_PROGRESS_MIN_UPDATES,
  type SweepFixOutcome,
  shouldFlushSweepProgress,
  sweepProgressInterval,
} from './problems-sweep.ts';

const LARGE_SWEEP = 2083;

function doneValues(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index + 1);
}

describe('shouldFlushSweepProgress', () => {
  test('flushes at each chunk boundary', () => {
    expect(shouldFlushSweepProgress(SWEEP_PROGRESS_CHUNK, LARGE_SWEEP)).toBe(true);
    expect(shouldFlushSweepProgress(SWEEP_PROGRESS_CHUNK * 2, LARGE_SWEEP)).toBe(true);
  });

  test('does not flush between chunk boundaries', () => {
    expect(shouldFlushSweepProgress(SWEEP_PROGRESS_CHUNK - 1, LARGE_SWEEP)).toBe(false);
    expect(shouldFlushSweepProgress(SWEEP_PROGRESS_CHUNK + 1, LARGE_SWEEP)).toBe(false);
  });

  test('flushes on the final file even when the total is not a chunk multiple', () => {
    expect(LARGE_SWEEP % SWEEP_PROGRESS_CHUNK).not.toBe(0);
    expect(shouldFlushSweepProgress(LARGE_SWEEP, LARGE_SWEEP)).toBe(true);
    expect(shouldFlushSweepProgress(LARGE_SWEEP - 1, LARGE_SWEEP)).toBe(false);
  });

  test('a sweep smaller than one chunk still advances the counter before the end', () => {
    const total = 45;
    const beforeLast = doneValues(total).filter((done) => done < total);
    const flushesBeforeEnd = beforeLast.filter((done) => shouldFlushSweepProgress(done, total));
    expect(flushesBeforeEnd.length).toBeGreaterThanOrEqual(4);
    expect(shouldFlushSweepProgress(total, total)).toBe(true);
  });

  test('every sweep size publishes while it runs, never only at the end', () => {
    for (const total of [2, 6, 17, 45, 49, 120, 999]) {
      const beforeLast = doneValues(total).filter((done) => done < total);
      expect(
        beforeLast.some((done) => shouldFlushSweepProgress(done, total)),
        `total=${total} published nothing before its final file`,
      ).toBe(true);
    }
  });

  test('a sweep of one file publishes once, on that file', () => {
    expect(shouldFlushSweepProgress(1, 1)).toBe(true);
  });

  test('the publish interval is capped at one chunk, so large sweeps are unchanged', () => {
    expect(sweepProgressInterval(LARGE_SWEEP)).toBe(SWEEP_PROGRESS_CHUNK);
    const flushes = doneValues(LARGE_SWEEP).filter((done) =>
      shouldFlushSweepProgress(done, LARGE_SWEEP),
    );
    expect(flushes).toEqual([
      ...Array.from(
        { length: Math.floor(LARGE_SWEEP / SWEEP_PROGRESS_CHUNK) },
        (_, i) => (i + 1) * SWEEP_PROGRESS_CHUNK,
      ),
      LARGE_SWEEP,
    ]);
  });

  test('publishes tens of updates, not one per file, across a large sweep', () => {
    const flushes = doneValues(LARGE_SWEEP).filter((done) =>
      shouldFlushSweepProgress(done, LARGE_SWEEP),
    ).length;
    expect(flushes).toBeGreaterThan(1);
    expect(flushes).toBeLessThan(LARGE_SWEEP / 10);
  });
});

describe('isCapacityRefusal', () => {
  test('a 503 carrying the capacity URN is retryable', () => {
    expect(isCapacityRefusal({ status: 503, problemType: CAPACITY_PROBLEM_TYPE })).toBe(true);
  });

  test('a 503 with a different problem type is not a capacity refusal', () => {
    expect(isCapacityRefusal({ status: 503, problemType: 'urn:ok:error:conflict' })).toBe(false);
  });

  test('a 503 with no problem type is not a capacity refusal', () => {
    expect(isCapacityRefusal({ status: 503, problemType: null })).toBe(false);
  });

  test('the capacity URN under a non-503 status is not a capacity refusal', () => {
    expect(isCapacityRefusal({ status: 409, problemType: CAPACITY_PROBLEM_TYPE })).toBe(false);
  });

  test('a network failure with no status is not a capacity refusal', () => {
    expect(isCapacityRefusal({ status: null, problemType: null })).toBe(false);
  });
});

describe('runProjectFixSweep', () => {
  function recordingSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
    const waited: number[] = [];
    return {
      sleep: async (ms: number) => {
        waited.push(ms);
      },
      waited,
    };
  }

  const CAPACITY: SweepFixOutcome = {
    ok: false,
    errorDetail: 'busy',
    status: 503,
    problemType: CAPACITY_PROBLEM_TYPE,
  };

  test('retries a capacity refusal until it clears, reporting no failure', async () => {
    const outcomes: SweepFixOutcome[] = [CAPACITY, CAPACITY, { ok: true }];
    const attempts: string[] = [];
    const { sleep, waited } = recordingSleep();
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        return outcomes.shift() ?? { ok: true };
      },
      sleep,
      onProgress: () => {},
      shouldContinue: () => true,
    });
    expect(result.failures).toEqual([]);
    expect(attempts).toEqual(['a.md', 'a.md', 'a.md']);
    expect(waited).toEqual(CAPACITY_RETRY_BACKOFF_MS.slice(0, 2));
  });

  test('reports a file as failed after exhausting the retry budget', async () => {
    const attempts: string[] = [];
    const { sleep, waited } = recordingSleep();
    const result = await runProjectFixSweep({
      items: [{ file: 'stuck.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        return CAPACITY;
      },
      sleep,
      onProgress: () => {},
      shouldContinue: () => true,
    });
    expect(attempts).toHaveLength(1 + CAPACITY_RETRY_BACKOFF_MS.length);
    expect(waited).toEqual([...CAPACITY_RETRY_BACKOFF_MS]);
    expect(result.failures).toEqual([{ item: { file: 'stuck.md' }, detail: 'busy' }]);
  });

  test('does not retry a non-capacity failure', async () => {
    const attempts: string[] = [];
    const { sleep, waited } = recordingSleep();
    const result = await runProjectFixSweep({
      items: [{ file: 'conflict.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        return { ok: false, errorDetail: 'merge conflict', status: 409, problemType: null };
      },
      sleep,
      onProgress: () => {},
      shouldContinue: () => true,
    });
    expect(attempts).toEqual(['conflict.md']);
    expect(waited).toEqual([]);
    expect(result.failures).toEqual([{ item: { file: 'conflict.md' }, detail: 'merge conflict' }]);
  });

  test('paces between files but not before the first', async () => {
    const { sleep, waited } = recordingSleep();
    await runProjectFixSweep({
      items: [{ file: 'a.md' }, { file: 'b.md' }, { file: 'c.md' }],
      fixItem: async () => ({ ok: true }),
      sleep,
      onProgress: () => {},
      shouldContinue: () => true,
    });
    expect(waited).toEqual([SWEEP_PACE_DELAY_MS, SWEEP_PACE_DELAY_MS]);
    expect(SWEEP_PACE_DELAY_MS).toBeGreaterThan(0);
  });

  test('publishes progress in chunks and lands the final count exactly', async () => {
    const total = SWEEP_PROGRESS_CHUNK * SWEEP_PROGRESS_MIN_UPDATES + 3;
    const progress: number[] = [];
    await runProjectFixSweep({
      items: Array.from({ length: total }, (_, index) => ({ file: `f${index}.md` })),
      fixItem: async () => ({ ok: true }),
      sleep: async () => {},
      onProgress: (done) => progress.push(done),
      shouldContinue: () => true,
    });
    expect(progress).toEqual([
      ...Array.from(
        { length: SWEEP_PROGRESS_MIN_UPDATES },
        (_, i) => (i + 1) * SWEEP_PROGRESS_CHUNK,
      ),
      total,
    ]);
  });

  test('a sub-chunk sweep publishes while it runs, not only as it tears down', async () => {
    const total = 45;
    const progress: number[] = [];
    await runProjectFixSweep({
      items: Array.from({ length: total }, (_, index) => ({ file: `f${index}.md` })),
      fixItem: async () => ({ ok: true }),
      sleep: async () => {},
      onProgress: (done) => progress.push(done),
      shouldContinue: () => true,
    });
    expect(progress.filter((done) => done < total).length).toBeGreaterThanOrEqual(4);
    expect(progress.at(-1)).toBe(total);
  });

  test('stops when the caller tears down mid-sweep', async () => {
    const attempts: string[] = [];
    let live = true;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }, { file: 'b.md' }, { file: 'c.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        live = false;
        return { ok: true };
      },
      sleep: async () => {},
      onProgress: () => {},
      shouldContinue: () => live,
    });
    expect(attempts).toEqual(['a.md']);
    expect(result.cancelled).toBe(true);
  });

  test('stops during a capacity backoff when the caller tears down mid-wait', async () => {
    const attempts: string[] = [];
    let live = true;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        return CAPACITY;
      },
      sleep: async () => {
        live = false;
      },
      onProgress: () => {},
      shouldContinue: () => live,
    });
    expect(attempts).toEqual(['a.md']);
    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([{ item: { file: 'a.md' }, detail: 'busy' }]);
  });

  test('skips the backoff wait entirely when the capacity fix itself tears the caller down', async () => {
    const attempts: string[] = [];
    const { sleep, waited } = recordingSleep();
    let live = true;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        live = false;
        return CAPACITY;
      },
      sleep,
      onProgress: () => {},
      shouldContinue: () => live,
    });
    expect(attempts).toEqual(['a.md']);
    expect(waited).toEqual([]);
    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([{ item: { file: 'a.md' }, detail: 'busy' }]);
  });

  test('reports the in-flight file when a user stop lands on its failed fix', async () => {
    let stopped = false;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }, { file: 'b.md' }],
      fixItem: async (item) => {
        if (item.file === 'a.md') return { ok: true };
        stopped = true;
        return { ok: false, errorDetail: 'boom', status: 500, problemType: null };
      },
      sleep: async () => {},
      onProgress: () => {},
      shouldContinue: () => !stopped,
    });
    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([{ item: { file: 'b.md' }, detail: 'boom' }]);
  });
});
