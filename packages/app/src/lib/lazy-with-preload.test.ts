/**
 * Behavioral tests for `lazyWithPreload`.
 *
 * Why behavioral, not raw-source — the wrapper's value is the
 * idempotency + safe-rejection contract, not its source shape. These
 * tests exercise the surface directly:
 *   - preload triggers the factory at most once across N calls
 *   - the lazy component's first render reuses the preloaded promise
 *     (the factory does not run a second time)
 *   - preload before render swallows a chunk-fetch rejection without
 *     surfacing as unhandled (React.lazy still routes errors through
 *     its own subscription on render — out of scope for a unit test)
 *
 * The wrapper itself is React-agnostic at the .preload() surface; we
 * only inspect the React.lazy wiring indirectly (.preload returns the
 * factory's promise, and a second .preload call returns the SAME
 * promise — both pre- and post-resolution).
 */

import { describe, expect, test } from 'bun:test';
import type { ComponentType } from 'react';
import { lazyWithPreload } from './lazy-with-preload';

// The component is never mounted — these tests exercise the preload
// surface only. A function component returning null is the smallest
// valid `ComponentType<P>` that satisfies React's type contract.
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
    // The synchronous call surface must NEVER throw — the consumer
    // wires this into a setTimeout-debounced hover handler that has
    // no try/catch envelope. The rejection lives only on the returned
    // promise (which the wrapper itself silences via a no-op catch).
    //
    // Block-body arrow so the matcher receives undefined, not the
    // rejected promise — bun:test's `.toThrow()` inspects an awaited
    // promise return when the arrow expression-returns one, which
    // would tautologically fail the assertion we want to make about
    // SYNC throws.
    const factory = () => Promise.reject(new Error('chunk fetch failed'));
    const Lazy = lazyWithPreload(factory);
    expect(() => {
      Lazy.preload();
    }).not.toThrow();
  });

  test('the returned promise itself remains rejected — observable to React.lazy', async () => {
    // The no-op `.catch` exists to silence the unhandled-rejection channel,
    // NOT to swap the returned promise's settlement state. If a refactor
    // reassigned the memoized promise (`promise = promise.catch(() => {})`)
    // it would resolve to undefined; React.lazy would then read
    // `undefined.default` on render instead of routing the rejection through
    // the nearest ErrorBoundary. This assertion makes that regression loud.
    const factory = () => Promise.reject(new Error('chunk-fail'));
    const Lazy = lazyWithPreload(factory);
    await expect(Lazy.preload()).rejects.toThrow('chunk-fail');
  });

  test('a rejected preload does not surface as an unhandled rejection', async () => {
    // lazyWithPreload attaches a no-op `.catch` to the factory promise so a
    // preload()-before-render rejection is absorbed by the wrapper instead of
    // logging "Uncaught (in promise)" before React.lazy subscribes via render.
    // That `.catch` is the ONLY guard for the contract, so this assertion must
    // genuinely fail if it is removed. We listen via `process.on('unhandledRejection')`
    // — NOT `globalThis.addEventListener('unhandledrejection')`: this file is a
    // non-DOM Bun `*.test.ts` (no jsdom preload), where `globalThis.addEventListener`
    // is undefined, so the DOM-event path would never register a listener and
    // `expect(unhandled).toBe(0)` would pass vacuously even with the `.catch`
    // deleted. `process.on('unhandledRejection')` IS available in Bun's non-DOM
    // runtime, making the regression guard effective.
    let unhandled = 0;
    const handler = (reason: unknown) => {
      // Match only our rejection; ignore incidental runner rejections.
      if (reason instanceof Error && reason.message === 'preload-test-rejection') {
        unhandled += 1;
      }
    };
    process.on('unhandledRejection', handler);
    try {
      const factory = () => Promise.reject(new Error('preload-test-rejection'));
      const Lazy = lazyWithPreload(factory);
      Lazy.preload();
      // Let the microtask queue + the runtime's unhandledRejection dispatch
      // drain. Two macrotask hops is enough in practice.
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
    // Once the chunk has resolved, repeated `.preload()` calls still
    // return the SAME settled promise — never re-running the factory.
    // (Awaiting a settled promise yields its resolved value on every
    // await, but the wrapper's contract is identity-equality of the
    // returned promise as well.)
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
