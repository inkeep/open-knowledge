import { describe, expect, test } from 'vitest';
import { sleep } from './sleep.ts';

describe('sleep', () => {
  test('resolves to undefined after the given delay', async () => {
    const start = Date.now();
    await expect(sleep(20)).resolves.toBeUndefined();
    // Timers can fire marginally early across runtimes; assert ~80% of nominal
    // rather than exact elapsed time to stay flakiness-safe while still catching
    // a halved-delay regression (e.g. `setTimeout(resolve, ms / 2)`).
    expect(Date.now() - start).toBeGreaterThanOrEqual(16);
  });

  test('sleep(0) yields asynchronously (does not resolve synchronously)', async () => {
    let resolved = false;
    const p = sleep(0).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });
});
