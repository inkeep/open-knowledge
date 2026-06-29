
import { describe, expect, test } from 'bun:test';

import { pollUntil } from './test-harness';

describe('pollUntil', () => {
  test('awaits async predicate (does not return on Promise truthy)', async () => {
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
