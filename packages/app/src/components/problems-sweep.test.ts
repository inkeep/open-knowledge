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

// A realistic large sweep — the corpus size the panel's project scope is sized
// for (thousands of fixable files).
const LARGE_SWEEP = 2083;

// The 1-based `done` values a sweep of `total` files passes through, [1..total].
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
    // Without the final-file clause the counter would stall at the last chunk
    // boundary (2050) and never reach 2083 — the no-off-by-one guarantee.
    expect(LARGE_SWEEP % SWEEP_PROGRESS_CHUNK).not.toBe(0);
    expect(shouldFlushSweepProgress(LARGE_SWEEP, LARGE_SWEEP)).toBe(true);
    expect(shouldFlushSweepProgress(LARGE_SWEEP - 1, LARGE_SWEEP)).toBe(false);
  });

  test('a sweep smaller than one chunk still advances the counter before the end', () => {
    // A 45-file sweep against a slow server ran 20s showing "Fixing 0 of 45" for
    // its whole duration: the only flush was the last file, and the teardown that
    // clears the counter superseded it before it painted. A sweep under one chunk
    // must publish while it is still running.
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
    // The floor may only ever make a SMALL sweep chattier; it must not increase
    // the update count of the corpus size chunking was introduced for.
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
    // The responsiveness win: a screen reader hears ~40 announcements over a
    // 2,000-file sweep, not ~2,000. A per-file regression would make this equal
    // the file count.
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
    // Both the status AND the URN must match — a stray URN on another status is
    // a real failure to report, not a capacity refusal to wait out.
    expect(isCapacityRefusal({ status: 409, problemType: CAPACITY_PROBLEM_TYPE })).toBe(false);
  });

  test('a network failure with no status is not a capacity refusal', () => {
    expect(isCapacityRefusal({ status: null, problemType: null })).toBe(false);
  });
});

describe('runProjectFixSweep', () => {
  // A sleep that never touches the clock: it records the delay it was asked to
  // wait and resolves immediately, so retry/backoff/pacing are exercised without
  // real time passing.
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
    // Two capacity refusals, then success — the file ends up fixed, not failed.
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
    // One initial attempt plus one per refusal that then cleared.
    expect(attempts).toEqual(['a.md', 'a.md', 'a.md']);
    // Backoff grew across the two retries following the schedule.
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
    // Bounded: one initial attempt plus one per backoff step, then it gives up —
    // never an unbounded loop against a persistently saturated pool.
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
    // A terminal failure is reported on the first attempt, with no backoff wait.
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
    // A clean sweep waits once between each adjacent pair (no capacity backoff),
    // deliberately holding the sustained rate below the session ceiling — and no
    // needless leading delay before the first file.
    expect(waited).toEqual([SWEEP_PACE_DELAY_MS, SWEEP_PACE_DELAY_MS]);
    expect(SWEEP_PACE_DELAY_MS).toBeGreaterThan(0);
  });

  test('publishes progress in chunks and lands the final count exactly', async () => {
    // Large enough that the interval sits at the full chunk, and not a chunk
    // multiple, to pin the exact-final-count guarantee.
    const total = SWEEP_PROGRESS_CHUNK * SWEEP_PROGRESS_MIN_UPDATES + 3;
    const progress: number[] = [];
    await runProjectFixSweep({
      items: Array.from({ length: total }, (_, index) => ({ file: `f${index}.md` })),
      fixItem: async () => ({ ok: true }),
      sleep: async () => {},
      onProgress: (done) => progress.push(done),
      shouldContinue: () => true,
    });
    // A flush at every chunk boundary, then a final flush on the exact total.
    expect(progress).toEqual([
      ...Array.from(
        { length: SWEEP_PROGRESS_MIN_UPDATES },
        (_, i) => (i + 1) * SWEEP_PROGRESS_CHUNK,
      ),
      total,
    ]);
  });

  test('a sub-chunk sweep publishes while it runs, not only as it tears down', async () => {
    // The shipped regression: 45 fixable files against a slow server showed
    // "Fixing 0 of 45" for the whole 20s run, because the only flush was the one
    // the teardown superseded.
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
        live = false; // the panel unmounts right after the first fix lands
        return { ok: true };
      },
      sleep: async () => {},
      onProgress: () => {},
      shouldContinue: () => live,
    });
    // The remaining files are never touched once the caller has gone away.
    expect(attempts).toEqual(['a.md']);
    expect(result.cancelled).toBe(true);
  });

  test('stops during a capacity backoff when the caller tears down mid-wait', async () => {
    // The panel unmounts while the sweep is waiting out a capacity backoff. The
    // liveness re-check after the backoff sleep must stop the retry before a
    // second POST goes out against a server the UI no longer renders.
    const attempts: string[] = [];
    let live = true;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        return CAPACITY;
      },
      sleep: async () => {
        live = false; // the panel unmounts during the backoff wait
      },
      onProgress: () => {},
      shouldContinue: () => live,
    });
    // The initial attempt hit capacity; the teardown during the backoff wait
    // stopped the retry, so only the one POST ever went out.
    expect(attempts).toEqual(['a.md']);
    expect(result.cancelled).toBe(true);
    // The one attempt that did run came back refused, so it is reported as a
    // failure even though the teardown stopped the retry.
    expect(result.failures).toEqual([{ item: { file: 'a.md' }, detail: 'busy' }]);
  });

  test('skips the backoff wait entirely when the capacity fix itself tears the caller down', async () => {
    // The fix lands, comes back a capacity refusal, and unmounts the panel in
    // the same tick. The liveness re-check before the backoff sleep must skip
    // the wait — no needless pause against a panel that has gone away.
    const attempts: string[] = [];
    const { sleep, waited } = recordingSleep();
    let live = true;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }],
      fixItem: async (item) => {
        attempts.push(item.file);
        live = false; // the panel unmounts as this capacity refusal comes back
        return CAPACITY;
      },
      sleep,
      onProgress: () => {},
      shouldContinue: () => live,
    });
    expect(attempts).toEqual(['a.md']);
    expect(waited).toEqual([]);
    expect(result.cancelled).toBe(true);
    // The refusal is still reported: the fix ran to a verdict before the
    // teardown, so it is a real outcome rather than work that never happened.
    expect(result.failures).toEqual([{ item: { file: 'a.md' }, detail: 'busy' }]);
  });

  test('reports the in-flight file when a user stop lands on its failed fix', async () => {
    // The Stop control makes cancellation user-reachable mid-sweep, so the
    // cancel path now has a consumer that reads `failures` (the panel logs
    // them). A file whose fix already came back failed must survive the bail —
    // dropping it would silently undercount the diagnostic log purely because
    // the stop landed in that window.
    let stopped = false;
    const result = await runProjectFixSweep({
      items: [{ file: 'a.md' }, { file: 'b.md' }],
      fixItem: async (item) => {
        if (item.file === 'a.md') return { ok: true };
        stopped = true; // the user hits Stop as this failed fix comes back
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
