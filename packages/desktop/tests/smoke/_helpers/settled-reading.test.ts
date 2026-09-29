import { stripVTControlCharacters } from 'node:util';
import { expect as playwrightExpect } from '@playwright/test';
import { describe, expect, test } from 'vitest';
import { waitForCollapsedWidth } from './rail-column';
import { expectSettledReading, settleBudget } from './settled-reading';

const LABEL = 'rail admission after the window narrows to 900 px';
const TOTAL_MS = 10_000;
const CLOCK_ORIGIN_MS = 50_000;
const COLUMN = '#agents-column';
const UNCOLLAPSED_WIDTH_PX = 320;
const LIVENESS_BOUND_MS = 500;
const REMAINING_MS = 300;
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

const uncollapsedUntil = (raceOver: () => boolean) => (): Promise<number> =>
  raceOver()
    ? Promise.reject(new Error('the liveness race is over'))
    : Promise.resolve(UNCOLLAPSED_WIDTH_PX);

const neverAnswers = (): Promise<number> => new Promise<number>(() => {});

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
  const entryPoints = [
    [
      'expectSettledReading',
      (raceOver: () => boolean, timeout: number) =>
        expectSettledReading(uncollapsedUntil(raceOver), (width) => expect(width).toBe(0), {
          reading: 'width',
          of: COLUMN,
          timeout,
        }),
    ],
    [
      'waitForCollapsedWidth',
      (raceOver: () => boolean, timeout: number) =>
        waitForCollapsedWidth(uncollapsedUntil(raceOver), { column: COLUMN, timeout }),
    ],
  ] as const;
  const bounds = [
    ['a zero bound', 0],
    ['a NaN bound', Number.NaN],
    ['a negative bound', -1],
  ] as const;

  test.each(
    entryPoints.flatMap(([entry, wait]) =>
      bounds.map(([bound, timeout]) => [entry, bound, wait, timeout] as const),
    ),
  )(
    '%s rejects %s promptly by naming the positive-bound contract',
    async (_entry, _bound, wait, timeout) => {
      const outcome = await outcomeWithinLiveness((raceOver) => wait(raceOver, timeout));

      expect(outcome).toMatch(/positive/u);
    },
  );
});

describe('settled reading bounded by a shared settle budget', () => {
  const entryPoints = [
    [
      'expectSettledReading',
      (read: () => Promise<number>) =>
        expectSettledReading(read, (width) => playwrightExpect(width).toBe(0), {
          reading: 'width',
          of: COLUMN,
          budget: budgetWithRemainder(),
        }),
    ],
    [
      'waitForCollapsedWidth',
      (read: () => Promise<number>) =>
        waitForCollapsedWidth(read, { column: COLUMN, budget: budgetWithRemainder() }),
    ],
  ] as const;
  const failingReads = [
    ['rejects', (): Promise<number> => Promise.reject(new Error(DESTROYED))],
    [
      'throws before it returns a promise',
      (): Promise<number> => {
        throw new Error(DESTROYED);
      },
    ],
  ] as const;

  test.each(entryPoints)(
    '%s reports a read that never answers as no reading within the time the budget has left, naming its label and total',
    async (_entry, wait) => {
      const message = await rejectionOf(wait(neverAnswers));

      expect(message).toMatch(/no width reading completed/u);
      expect(message).toContain(LABEL);
      expect(message).toMatch(new RegExp(`\\b${REMAINING_MS} ms\\b`, 'u'));
      expect(message).toMatch(new RegExp(`\\b${TOTAL_MS} ms\\b`, 'u'));
    },
  );

  test.each(entryPoints)(
    '%s reports a width that never settles within the time the budget has left and keeps its Expected/Received reason',
    async (_entry, wait) => {
      const message = await rejectionOf(wait(() => Promise.resolve(UNCOLLAPSED_WIDTH_PX)));

      expect(message).toMatch(/never settled/u);
      expect(message).toContain(COLUMN);
      expect(message).toContain(LABEL);
      expect(message).toMatch(new RegExp(`\\b${REMAINING_MS} ms\\b`, 'u'));
      expect(message).toMatch(new RegExp(`\\b${TOTAL_MS} ms\\b`, 'u'));
      expect(message).toMatch(/Expected: 0\b/u);
      expect(message).toMatch(new RegExp(`Received: ${UNCOLLAPSED_WIDTH_PX}\\b`, 'u'));
    },
  );

  test.each(
    entryPoints.flatMap(([entry, wait]) =>
      failingReads.map(([how, read]) => [entry, how, wait, read] as const),
    ),
  )(
    '%s surfaces a read that %s as that failure, never as a missing or unsettled reading',
    async (_entry, _how, wait, read) => {
      const message = await rejectionOf(wait(read));

      expect(message).toContain(DESTROYED);
      expect(message).not.toMatch(/no width reading completed|never settled|Received/u);
    },
  );
});
