/**
 * Pin the pollUntil contract for sync AND async predicates.
 *
 * The async-predicate path is silent-bug-prone: reverting `await condition()`
 * back to `if (condition())` would not be caught by TypeScript (a Promise is
 * always truthy in a boolean context), and async callers would silently
 * stop polling.
 */

import { describe, expect, test } from 'bun:test';

import { pollUntil } from './test-harness';

describe('pollUntil', () => {
  test('awaits async predicate (does not return on Promise truthy)', async () => {
    // If pollUntil failed to await the async predicate, `if (condition())`
    // would see the Promise object (truthy) and return on the first call,
    // leaving count at 1. Asserting count >= 3 forces multiple iterations.
    let count = 0;
    await pollUntil(
      async () => {
        count++;
        return count >= 3;
      },
      1000,
      25,
    );
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('times out when async predicate never resolves true', async () => {
    await expect(pollUntil(async () => false, 200, 50)).rejects.toThrow(/timed out/);
  });

  test('supports sync predicates (backward-compat with 30+ existing callers)', async () => {
    let n = 0;
    await pollUntil(() => ++n >= 3, 1000, 25);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test('propagates async predicate rejection', async () => {
    // If a future refactor wraps `await condition()` in try/catch (e.g. to
    // "retry on error"), predicate failures would be silently swallowed
    // instead of failing fast. The current contract: rejection from the
    // predicate propagates through pollUntil's promise chain immediately.
    await expect(
      pollUntil(
        async () => {
          throw new Error('predicate-failure');
        },
        1000,
        25,
      ),
    ).rejects.toThrow('predicate-failure');
  });
});
