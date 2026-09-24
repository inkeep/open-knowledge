import { stripVTControlCharacters } from 'node:util';
import type { Page } from '@playwright/test';
import { describe, expect, test } from 'vitest';
import { readRailColumnWidth, waitForCollapsedWidth } from './rail-column';

const COLUMN = '#agents-column';
const PLAYWRIGHT_INHERITED_EXPECT_TIMEOUT_MS = 5_000;
const CI_ATTEMPT_ZERO_READ_MS = 5_260;
const DECLARED_BOUND_MS = 300;
const UNCOLLAPSED_WIDTH_PX = 320;
const DESTROYED = 'Execution context was destroyed, most likely because of a navigation';

const answerAfter = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

const neverAnswers = (): Promise<number> => new Promise<number>(() => {});

async function rejectionOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => {
      throw new Error('the settle wait resolved where it had to reject');
    },
    (error: unknown) =>
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
  );
}

type FakeRailElement = { getBoundingClientRect: () => { width: number } };

function pageMatching(widths: readonly number[]): Page {
  const elements: FakeRailElement[] = widths.map((width) => ({
    getBoundingClientRect: () => ({ width }),
  }));
  return {
    locator: () => ({
      evaluateAll: async (read: (nodes: FakeRailElement[]) => number[]) => read(elements),
    }),
  } as unknown as Page;
}

describe('collapsed rail column settle', () => {
  test('replays CI attempt 0: a read that answers zero after the inherited expect default still settles the column', async () => {
    expect(CI_ATTEMPT_ZERO_READ_MS).toBeGreaterThan(PLAYWRIGHT_INHERITED_EXPECT_TIMEOUT_MS);
    let reads = 0;

    await waitForCollapsedWidth(
      () => {
        reads += 1;
        return answerAfter(CI_ATTEMPT_ZERO_READ_MS, 0);
      },
      { column: COLUMN },
    );

    expect(reads).toBeGreaterThan(0);
  });

  test('reports a read that never answers inside the declared bound as no reading, naming the column and the bound', async () => {
    const message = await rejectionOf(
      waitForCollapsedWidth(neverAnswers, { column: COLUMN, timeout: DECLARED_BOUND_MS }),
    );

    expect(message).toContain(COLUMN);
    expect(message).toMatch(new RegExp(`\\b${DECLARED_BOUND_MS} ms\\b`, 'u'));
    expect(message).toMatch(/no width reading completed/u);
    expect(message).not.toMatch(/Received/u);
  });

  test('reports a column that answered a non-zero width as that width, never as a missing reading', async () => {
    const message = await rejectionOf(
      waitForCollapsedWidth(() => Promise.resolve(UNCOLLAPSED_WIDTH_PX), {
        column: COLUMN,
        timeout: DECLARED_BOUND_MS,
      }),
    );

    expect(message).toMatch(new RegExp(`\\b${UNCOLLAPSED_WIDTH_PX}\\b`, 'u'));
    expect(message).not.toMatch(/no width reading completed/u);
  });

  test('settles once the column reaches zero after wider readings', async () => {
    const widths = [UNCOLLAPSED_WIDTH_PX, UNCOLLAPSED_WIDTH_PX, 0];
    let reads = 0;

    await waitForCollapsedWidth(
      () => {
        const width = widths[Math.min(reads, widths.length - 1)] ?? 0;
        reads += 1;
        return Promise.resolve(width);
      },
      { column: COLUMN },
    );

    expect(reads).toBeGreaterThanOrEqual(widths.length);
  });

  test('surfaces a read that keeps failing as the read failure, never as a width', async () => {
    const message = await rejectionOf(
      waitForCollapsedWidth(() => Promise.reject(new Error(DESTROYED)), {
        column: COLUMN,
        timeout: DECLARED_BOUND_MS,
      }),
    );

    expect(message).toContain(DESTROYED);
    expect(message).not.toMatch(/Received/u);
  });
});
describe('rail column cardinality', () => {
  test('reads the width when exactly one element matches', async () => {
    await expect(readRailColumnWidth(pageMatching([UNCOLLAPSED_WIDTH_PX]), COLUMN)).resolves.toBe(
      UNCOLLAPSED_WIDTH_PX,
    );
  });

  test('refuses a selector that matches no element, naming the selector and the count', async () => {
    const message = await rejectionOf(readRailColumnWidth(pageMatching([]), COLUMN));

    expect(message).toContain(COLUMN);
    expect(message).toMatch(/found 0\b/u);
  });

  test('refuses a selector that matches more than one collapsed element, naming the selector and the count', async () => {
    const message = await rejectionOf(readRailColumnWidth(pageMatching([0, 0]), COLUMN));

    expect(message).toContain(COLUMN);
    expect(message).toMatch(/found 2\b/u);
  });
});
