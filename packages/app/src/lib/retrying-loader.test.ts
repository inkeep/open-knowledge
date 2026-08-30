import { describe, expect, test, vi } from 'vitest';
import { createRetryingLoader } from './retrying-loader.ts';

describe('createRetryingLoader', () => {
  test('caches a resolved module across calls', async () => {
    const load = vi.fn(async () => ({ id: 'mod' }));
    const loader = createRetryingLoader(load);
    const first = await loader();
    const second = await loader();
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers share one in-flight promise', async () => {
    const load = vi.fn(async () => ({ id: 'mod' }));
    const loader = createRetryingLoader(load);
    const [a, b] = await Promise.all([loader(), loader()]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a rejection clears the cache so the next call retries', async () => {
    const load = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValue({ id: 'mod' });
    const loader = createRetryingLoader(load);
    await expect(loader()).rejects.toThrow('chunk load failed');
    // The failed promise must not be handed out again.
    await expect(loader()).resolves.toEqual({ id: 'mod' });
    expect(load).toHaveBeenCalledTimes(2);
    // And the successful retry is cached like any first success.
    await loader();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
