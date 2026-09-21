import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  remainingTestBudgetMs,
  waitWithinTestBudget,
} from './wait-within-test-budget.test-helper.ts';

const realSetTimeout = globalThis.setTimeout;

let attemptsSeen = 0;

const OWN_TIMEOUT_MS = 4_000;

const LOST_EVENT_CAP_MS = 5_000;
const LOST_EVENT_REQUEST_MS = LOST_EVENT_CAP_MS * 12;

const CLAMP_GRANT_MS = 250;
const CLAMP_POLL_MS = 25;
const CLAMP_POLL_SLACK = 4;

describe('remainingTestBudgetMs', () => {
  test('reads its own timeout and shrinks as it runs', { timeout: OWN_TIMEOUT_MS }, async () => {
    const atStart = remainingTestBudgetMs();
    expect(atStart).toBeGreaterThan(0);
    expect(atStart).toBeLessThanOrEqual(OWN_TIMEOUT_MS);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const later = remainingTestBudgetMs();
    expect(later).toBeLessThan(atStart ?? 0);
  });

  test('reports no budget when the test timeout is one vitest treats as unbounded', () => {
    expect(remainingTestBudgetMs()).toBeUndefined();
  }, 0);

  test('reports no budget once a retry has made the start stamp stale', { retry: 1 }, () => {
    if (attemptsSeen === 0) {
      attemptsSeen += 1;
      throw new Error('first attempt fails on purpose so the second one runs as a retry');
    }
    expect(remainingTestBudgetMs()).toBeUndefined();
  });

  describe('once a repeat has made the start stamp stale', () => {
    let repeatsSeen = 0;

    afterAll(() => {
      expect(repeatsSeen).toBe(2);
    });

    test('reports no budget', { repeats: 1 }, () => {
      repeatsSeen += 1;
      if (repeatsSeen === 1) {
        expect(remainingTestBudgetMs()).toBeGreaterThan(0);
        return;
      }
      expect(remainingTestBudgetMs()).toBeUndefined();
    });
  });

  test.concurrent('reports no budget in a concurrent test, whose identity the runner singleton cannot pin', ({
    expect,
  }) => {
    expect(remainingTestBudgetMs()).toBeUndefined();
  });
});

describe('waitWithinTestBudget', () => {
  test('returns as soon as the predicate holds', async () => {
    let arrived = false;
    setTimeout(() => {
      arrived = true;
    }, 50);

    await waitWithinTestBudget('the flag to flip', () => arrived, {
      timeoutMs: 5_000,
      pollMs: 10,
    });

    expect(arrived).toBe(true);
  }, 10_000);

  test('a lost event names the wait before its cap', { timeout: LOST_EVENT_CAP_MS }, async () => {
    await expect(
      waitWithinTestBudget('an event that never arrives', () => false, {
        timeoutMs: LOST_EVENT_REQUEST_MS,
        pollMs: 10,
        reserveMs: 3_500,
      }),
    ).rejects.toThrow(/^timed out waiting for an event that never arrives after \d+ms/);
  });

  test('says it clamped, and by how much, when the test budget is the binding limit', async () => {
    const readAt = Date.now();
    const budgetAtStart = remainingTestBudgetMs(readAt) ?? 0;
    expect(budgetAtStart).toBeGreaterThan(CLAMP_GRANT_MS);
    const reserveMs = budgetAtStart - CLAMP_GRANT_MS;

    let polls = 0;
    let firstPollAt = 0;
    const startedAt = Date.now();
    const failure = await waitWithinTestBudget(
      'a clamped wait',
      () => {
        polls += 1;
        if (firstPollAt === 0) firstPollAt = Date.now();
        return false;
      },
      { timeoutMs: 60_000, pollMs: CLAMP_POLL_MS, reserveMs },
    ).then(
      () => 'the wait resolved instead of reporting the clamp',
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(failure).toMatch(
      new RegExp(
        `^timed out waiting for a clamped wait after \\d+ms \\(requested 60000ms, clamped to \\d+ms to leave ${reserveMs}ms for this failure and the test's own teardown to run inside the test's timeout\\)$`,
      ),
    );

    const grantedMs = Number(/clamped to (\d+)ms/.exec(failure)?.[1]);
    expect(grantedMs).toBeLessThanOrEqual(CLAMP_GRANT_MS);
    expect(
      grantedMs,
      'the grant is this request minus the reserve, short only by the time between this test ' +
        'reading its own remaining budget and the wait reading it again, which the run measures ' +
        'rather than assumes, so no machine can drive the grant below this bound',
    ).toBeGreaterThanOrEqual(CLAMP_GRANT_MS - (firstPollAt - readAt));
    expect(elapsedMs).toBeGreaterThanOrEqual(grantedMs);
    expect(
      polls,
      'a wait that runs past the deadline it reported keeps polling, and the reported grant is ' +
        'the one number widening the deadline leaves untouched. Contention only lowers this ' +
        'count, because a slow host spends more of a fixed window on each poll, so the bound ' +
        'reds on a deadline half again too long rather than on a loaded machine',
    ).toBeLessThanOrEqual(Math.ceil(grantedMs / CLAMP_POLL_MS) + CLAMP_POLL_SLACK);
  }, 10_000);

  test('does not shorten a wait the test has room for', async () => {
    const startedAt = Date.now();

    await expect(
      waitWithinTestBudget('a predicate that stays false', () => false, {
        timeoutMs: 300,
        pollMs: 10,
      }),
    ).rejects.toThrow(/\(requested 300ms\)$/);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
  }, 20_000);

  test('says it ran blind when the test own remaining budget could not be read', async () => {
    await expect(
      waitWithinTestBudget('a wait with no readable budget', () => false, {
        timeoutMs: 300,
        pollMs: 10,
      }),
    ).rejects.toThrow(
      /\(requested 300ms, granted the full request: the test's own remaining budget could not be read\)$/,
    );
  }, 0);

  test('grants no time, and says so, when the budget is already inside the reserve', async () => {
    let polls = 0;

    await expect(
      waitWithinTestBudget(
        'a wait with no budget left to grant',
        () => {
          polls += 1;
          return false;
        },
        {
          timeoutMs: 60_000,
          pollMs: 10,
          reserveMs: 30_000,
        },
      ),
    ).rejects.toThrow(
      /\(requested 60000ms, granted no time: only \d+ms of the test's own timeout was left, at or below the 30000ms reserved for this failure and the test's own teardown\)$/,
    );

    expect(polls).toBe(1);
  }, 5_000);

  describe('when a hook has already overdrawn the test budget', () => {
    beforeEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    test('says the budget was overdrawn instead of reporting negative time left', async () => {
      await expect(
        waitWithinTestBudget('a wait that begins overdrawn', () => false, {
          timeoutMs: 60_000,
          pollMs: 10,
        }),
      ).rejects.toThrow(
        /granted no time: the test's own timeout was already overdrawn by \d+ms when this wait began\)$/,
      );
    }, 500);
  });

  test('keeps polling when the caller has installed fake timers', async () => {
    vi.useFakeTimers();
    try {
      let arrived = false;
      realSetTimeout(() => {
        arrived = true;
      }, 100);

      await waitWithinTestBudget('the flag to flip under fake timers', () => arrived, {
        timeoutMs: 4_000,
        pollMs: 10,
      });

      expect(arrived).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 8_000);

  test('still reaches its own deadline when the caller has installed fake timers', async () => {
    vi.useFakeTimers();
    try {
      await expect(
        waitWithinTestBudget('an event that never arrives under fake timers', () => false, {
          timeoutMs: 300,
          pollMs: 10,
        }),
      ).rejects.toThrow(
        /^timed out waiting for an event that never arrives under fake timers after \d+ms/,
      );
    } finally {
      vi.useRealTimers();
    }
  }, 8_000);

  test('accepts an async predicate and awaits it before checking the deadline', async () => {
    let arrived = false;
    setTimeout(() => {
      arrived = true;
    }, 50);

    await waitWithinTestBudget('an async probe to report the flag', async () => arrived, {
      timeoutMs: 5_000,
      pollMs: 10,
    });

    expect(arrived).toBe(true);
  }, 10_000);

  test('a throwing predicate names the wait instead of failing anonymously', async () => {
    await expect(
      waitWithinTestBudget(
        'the disk file to settle',
        () => {
          throw new Error('ENOENT: no such file or directory');
        },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/the disk file to settle/);
  });

  test('a throwing predicate keeps its own failure in the message', async () => {
    await expect(
      waitWithinTestBudget(
        'the disk file to settle',
        () => {
          throw new Error('ENOENT: no such file or directory');
        },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/ENOENT: no such file or directory/);
  });

  test('a rejected async predicate names the wait and keeps its own failure', async () => {
    await expect(
      waitWithinTestBudget(
        'an async probe of the disk file',
        async () => {
          throw new Error('EACCES: permission denied');
        },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(
      /while waiting for an async probe of the disk file: EACCES: permission denied/,
    );
  });

  test('a predicate that throws a non-Error still names the wait', async () => {
    await expect(
      waitWithinTestBudget(
        'the disk file to settle',
        () => {
          throw 'the watcher gave up';
        },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/while waiting for the disk file to settle: the watcher gave up/);
  });

  test('keeps the thrown error as the cause, so its own properties stay readable', async () => {
    const missing = join(tmpdir(), 'wait-within-test-budget-absent-notes.md');

    await expect(
      waitWithinTestBudget('the disk file to settle', () => readFileSync(missing, 'utf8') !== '', {
        timeoutMs: 1_000,
        pollMs: 10,
      }),
    ).rejects.toHaveProperty('cause.code', 'ENOENT');
  });

  test('keeps the frames of the predicate that threw, not the frames of the wrapper', async () => {
    const missing = join(tmpdir(), 'wait-within-test-budget-absent-notes.md');

    await expect(
      waitWithinTestBudget('the disk file to settle', () => readFileSync(missing, 'utf8') !== '', {
        timeoutMs: 1_000,
        pollMs: 10,
      }),
    ).rejects.toHaveProperty('stack', expect.stringMatching(/\n\s+at \S*readFileSync\b/));
  });

  test('a predicate that throws on a later poll still names the wait', async () => {
    let polls = 0;

    await expect(
      waitWithinTestBudget(
        'the disk file to settle',
        () => {
          polls += 1;
          if (polls < 3) return false;
          throw new Error('ENOENT: no such file or directory');
        },
        { timeoutMs: 1_000, pollMs: 10 },
      ),
    ).rejects.toThrow(
      /while waiting for the disk file to settle: ENOENT: no such file or directory/,
    );

    expect(polls).toBe(3);
  });
});
