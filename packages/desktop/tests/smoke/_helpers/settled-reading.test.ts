import { stripVTControlCharacters } from 'node:util';
import { expect as playwrightExpect } from '@playwright/test';
import { describe, expect, test } from 'vitest';
import { expectSettledReading, LAYOUT_SETTLE_TIMEOUT_MS, settleBudget } from './settled-reading';

const LABEL = 'the dock after the window narrows to 900 px';
const TOTAL_MS = 10_000;
const CLOCK_ORIGIN_MS = 50_000;
const SURFACE = '#dock-unit-terminal';
const UNSETTLED_WIDTH_PX = 320;
const LIVENESS_BOUND_MS = 500;
const REMAINING_MS = 300;
const DECLARED_BOUND_MS = 300;
const PLAYWRIGHT_INHERITED_EXPECT_TIMEOUT_MS = 5_000;
const CI_ATTEMPT_ZERO_READ_MS = 5_260;
const DESTROYED = 'Execution context was destroyed, most likely because of a navigation';

function budgetOnClock(timeout: number) {
  const clock = { now: CLOCK_ORIGIN_MS };
  const budget = settleBudget(LABEL, { timeout, now: () => clock.now });
  return {
    budget,
    advance(ms: number): void {
      clock.now += ms;
    },
  };
}

async function outcomeWithinLiveness(
  start: (raceOver: () => boolean) => Promise<unknown>,
): Promise<string> {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    start(() => over).then(
      () => 'resolved',
      (error: unknown) =>
        stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('still waiting'), LIVENESS_BOUND_MS);
    }),
  ]);
  over = true;
  clearTimeout(timer);
  return outcome;
}

const unsettledUntil = (raceOver: () => boolean) => (): Promise<number> =>
  raceOver()
    ? Promise.reject(new Error('the liveness race is over'))
    : Promise.resolve(UNSETTLED_WIDTH_PX);

const neverAnswers = (): Promise<number> => new Promise<number>(() => {});

const answerAfter = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

async function rejectionOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => {
      throw new Error('the settled reading resolved where it had to reject');
    },
    (error: unknown) =>
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
  );
}

function budgetWithRemainder() {
  const { budget, advance } = budgetOnClock(TOTAL_MS);
  advance(TOTAL_MS - REMAINING_MS);
  return budget;
}

function settlesAtZero(read: () => Promise<number>, timeout: number): Promise<void> {
  return expectSettledReading(read, (width) => playwrightExpect(width).toBe(0), {
    reading: 'width',
    of: SURFACE,
    timeout,
  });
}

describe('settle budget shared by the waits on one layout transition', () => {
  test('spends the time elapsed on its clock from the remaining budget', () => {
    const { budget, advance } = budgetOnClock(TOTAL_MS);

    expect(budget.remainingMs()).toBe(TOTAL_MS);
    advance(4_000);
    expect(budget.remainingMs()).toBe(TOTAL_MS - 4_000);
    advance(5_000);
    expect(budget.remainingMs()).toBe(TOTAL_MS - 9_000);
  });

  test.each([
    ['exactly spent', TOTAL_MS],
    ['overspent', TOTAL_MS + 1],
  ])(
    'throws naming the label and the total once %s, instead of handing out a remainder Playwright would misread',
    (_label, elapsedMs) => {
      const { budget, advance } = budgetOnClock(TOTAL_MS);

      advance(elapsedMs);

      expect(() => budget.remainingMs()).toThrow(LABEL);
      expect(() => budget.remainingMs()).toThrow(new RegExp(`\\b${TOTAL_MS} ms\\b`, 'u'));
    },
  );

  test.each([
    ['a zero total', 0],
    ['a negative total', -1],
    ['a NaN total', Number.NaN],
    ['an infinite total', Number.POSITIVE_INFINITY],
  ])('refuses %s by naming the positive-bound contract', (_label, total) => {
    expect(() => budgetOnClock(total)).toThrow(/positive/u);
  });
});

describe('declared bound of a settled reading', () => {
  test.each([
    ['a zero bound', 0],
    ['a NaN bound', Number.NaN],
    ['a negative bound', -1],
  ])('rejects %s promptly by naming the positive-bound contract', async (_bound, timeout) => {
    const outcome = await outcomeWithinLiveness((raceOver) =>
      settlesAtZero(unsettledUntil(raceOver), timeout),
    );

    expect(outcome).toMatch(/positive/u);
  });

  test('replays CI attempt 0: a reading that answers after the inherited expect default still settles within its declared bound', async () => {
    expect(CI_ATTEMPT_ZERO_READ_MS).toBeGreaterThan(PLAYWRIGHT_INHERITED_EXPECT_TIMEOUT_MS);
    let reads = 0;

    await settlesAtZero(() => {
      reads += 1;
      return answerAfter(CI_ATTEMPT_ZERO_READ_MS, 0);
    }, LAYOUT_SETTLE_TIMEOUT_MS);

    expect(reads).toBeGreaterThan(0);
  });

  test('reports a read that never answers inside the declared bound as no reading, naming the surface and the bound', async () => {
    const message = await rejectionOf(settlesAtZero(neverAnswers, DECLARED_BOUND_MS));

    expect(message).toContain(SURFACE);
    expect(message).toMatch(new RegExp(`\\b${DECLARED_BOUND_MS} ms\\b`, 'u'));
    expect(message).toMatch(/no width reading completed/u);
    expect(message).not.toMatch(/Received/u);
  });

  test('reports a reading that never matches as that reading, never as a missing one', async () => {
    const message = await rejectionOf(
      settlesAtZero(() => Promise.resolve(UNSETTLED_WIDTH_PX), DECLARED_BOUND_MS),
    );

    expect(message).toMatch(new RegExp(`\\b${UNSETTLED_WIDTH_PX}\\b`, 'u'));
    expect(message).not.toMatch(/no width reading completed/u);
  });

  test('settles once the reading matches after earlier readings that did not', async () => {
    const widths = [UNSETTLED_WIDTH_PX, UNSETTLED_WIDTH_PX, 0];
    let reads = 0;

    await settlesAtZero(() => {
      const width = widths[Math.min(reads, widths.length - 1)] ?? 0;
      reads += 1;
      return Promise.resolve(width);
    }, LAYOUT_SETTLE_TIMEOUT_MS);

    expect(reads).toBeGreaterThanOrEqual(widths.length);
  });

  test('surfaces a read that keeps failing as the read failure, never as a reading', async () => {
    const message = await rejectionOf(
      settlesAtZero(() => Promise.reject(new Error(DESTROYED)), DECLARED_BOUND_MS),
    );

    expect(message).toContain(DESTROYED);
    expect(message).not.toMatch(/Received/u);
  });
});

describe('settled reading bounded by a shared settle budget', () => {
  const settlesWithinBudget = (read: () => Promise<number>) =>
    expectSettledReading(read, (width) => playwrightExpect(width).toBe(0), {
      reading: 'width',
      of: SURFACE,
      budget: budgetWithRemainder(),
    });

  test('reports a read that never answers as no reading within the time the budget has left, naming its label and total', async () => {
    const message = await rejectionOf(settlesWithinBudget(neverAnswers));

    expect(message).toMatch(/no width reading completed/u);
    expect(message).toContain(LABEL);
    expect(message).toMatch(new RegExp(`\\b${REMAINING_MS} ms\\b`, 'u'));
    expect(message).toMatch(new RegExp(`\\b${TOTAL_MS} ms\\b`, 'u'));
  });

  test('reports a width that never settles within the time the budget has left and keeps its Expected/Received reason', async () => {
    const message = await rejectionOf(
      settlesWithinBudget(() => Promise.resolve(UNSETTLED_WIDTH_PX)),
    );

    expect(message).toMatch(/never settled/u);
    expect(message).toContain(SURFACE);
    expect(message).toContain(LABEL);
    expect(message).toMatch(new RegExp(`\\b${REMAINING_MS} ms\\b`, 'u'));
    expect(message).toMatch(new RegExp(`\\b${TOTAL_MS} ms\\b`, 'u'));
    expect(message).toMatch(/Expected: 0\b/u);
    expect(message).toMatch(new RegExp(`Received: ${UNSETTLED_WIDTH_PX}\\b`, 'u'));
  });

  test.each([
    ['rejects', (): Promise<number> => Promise.reject(new Error(DESTROYED))],
    [
      'throws before it returns a promise',
      (): Promise<number> => {
        throw new Error(DESTROYED);
      },
    ],
  ] as const)(
    'surfaces a read that %s as that failure, never as a missing or unsettled reading',
    async (_how, read) => {
      const message = await rejectionOf(settlesWithinBudget(read));

      expect(message).toContain(DESTROYED);
      expect(message).not.toMatch(/no width reading completed|never settled|Received/u);
    },
  );
});
