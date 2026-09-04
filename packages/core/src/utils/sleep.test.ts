import { describe, expect, test } from 'vitest';
import { sleep } from './sleep.ts';

describe('sleep', () => {
  test('resolves to undefined after the given delay', async () => {
    const start = Date.now();
    await expect(sleep(20)).resolves.toBeUndefined();
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
