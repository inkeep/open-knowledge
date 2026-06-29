
import { describe, expect, test } from 'bun:test';
import type { ComponentType } from 'react';
import { lazyWithPreload } from './lazy-with-preload';

const FakeComponent: ComponentType<{ label: string }> = () => null;

describe('lazyWithPreload', () => {
  test('factory runs at most once across N preload calls', async () => {
    let callCount = 0;
    const factory = () => {
      callCount += 1;
      return Promise.resolve({ default: FakeComponent });
    };
    const Lazy = lazyWithPreload(factory);

    expect(callCount).toBe(0);

    const first = Lazy.preload();
    const second = Lazy.preload();
    const third = Lazy.preload();

    expect(callCount).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);

    const mod = await first;
    expect(mod.default).toBe(FakeComponent);

    const fourth = Lazy.preload();
    expect(callCount).toBe(1);
    expect(fourth).toBe(first);
    expect(await fourth).toBe(mod);
  });

  test('preload(): Promise<{ default: T }> resolves to the loaded module', async () => {
    const factory = () => Promise.resolve({ default: FakeComponent });
    const Lazy = lazyWithPreload(factory);

    const result = await Lazy.preload();

    expect(typeof result).toBe('object');
    expect(result.default).toBe(FakeComponent);
  });

  test('preload() does not throw synchronously even when the factory rejects', () => {
    const factory = () => Promise.reject(new Error('chunk fetch failed'));
    const Lazy = lazyWithPreload(factory);
    expect(() => {
      Lazy.preload();
    }).not.toThrow();
  });

  test('the returned promise itself remains rejected — observable to React.lazy', async () => {
    const factory = () => Promise.reject(new Error('chunk-fail'));
    const Lazy = lazyWithPreload(factory);
    await expect(Lazy.preload()).rejects.toThrow('chunk-fail');
  });

  test('a rejected preload does not surface as an unhandled rejection', async () => {
    let unhandled = 0;
    const handler = (reason: unknown) => {
      if (reason instanceof Error && reason.message === 'preload-test-rejection') {
        unhandled += 1;
      }
    };
    process.on('unhandledRejection', handler);
    try {
      const factory = () => Promise.reject(new Error('preload-test-rejection'));
      const Lazy = lazyWithPreload(factory);
      Lazy.preload();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  test('idempotency holds even when the factory promise has already resolved', async () => {
    let callCount = 0;
    const factory = () => {
      callCount += 1;
      return Promise.resolve({ default: FakeComponent });
    };
    const Lazy = lazyWithPreload(factory);
    const promise = Lazy.preload();
    await promise;
    expect(callCount).toBe(1);

    const repeat1 = Lazy.preload();
    const repeat2 = Lazy.preload();
    expect(repeat1).toBe(promise);
    expect(repeat2).toBe(promise);
    expect(callCount).toBe(1);
  });
});
