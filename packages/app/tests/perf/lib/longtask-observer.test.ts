/**
 * `installLongtaskObserver(page)` + `readLongtasks(page)` — unit tests.
 *
 * The helper has two halves:
 *   1. installLongtaskObserver: registers an init script that sets up
 *      `globalThis.__okScenLongTasks` and a `PerformanceObserver` that
 *      pushes longtask entries into it.
 *   2. readLongtasks: drains the in-page store via `page.evaluate`.
 *
 * The init script's body runs in the browser. Bun unit tests can't exercise
 * Playwright's browser env, but we CAN exercise the seam — verify that
 * `installLongtaskObserver` calls `page.addInitScript` exactly once with a
 * function whose body is the expected shape, and that `readLongtasks`
 * delegates to `page.evaluate` and propagates the returned array verbatim.
 *
 * The fake-page mocks expose just the two methods the helper touches.
 */

import { describe, expect, test } from 'bun:test';
import type { Page } from '@playwright/test';
import { installLongtaskObserver, type LongTaskRecord, readLongtasks } from './longtask-observer';

interface FakePage {
  addInitScriptCalls: Array<{ fn: unknown }>;
  evaluateCalls: Array<{ fn: unknown }>;
  evaluateReturn: unknown;
  addInitScript(fn: () => void | Promise<void>): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}

function makeFakePage(evaluateReturn: unknown = []): FakePage {
  const fake: FakePage = {
    addInitScriptCalls: [],
    evaluateCalls: [],
    evaluateReturn,
    async addInitScript(fn) {
      fake.addInitScriptCalls.push({ fn });
    },
    async evaluate<T>(fn: () => T | Promise<T>) {
      fake.evaluateCalls.push({ fn });
      return fake.evaluateReturn as T;
    },
  };
  return fake;
}

describe('installLongtaskObserver', () => {
  test('calls page.addInitScript exactly once', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    expect(fake.addInitScriptCalls.length).toBe(1);
  });

  test('init script body references the documented globalThis store name', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    const fn = fake.addInitScriptCalls[0]?.fn;
    expect(typeof fn).toBe('function');
    const src = (fn as () => void).toString();
    // The store name `__okScenLongTasks` is the contract — it's referenced by
    // every scenario that drains it. Verify the init script writes to that
    // exact key, not a typo'd variant.
    expect(src).toContain('__okScenLongTasks');
  });

  test('init script registers a PerformanceObserver for the longtask type', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    const src = (fake.addInitScriptCalls[0]?.fn as () => void).toString();
    expect(src).toContain('PerformanceObserver');
    // bun's bundler minifies string quotes and `true` → `!0` when stringifying
    // function bodies; match against either form for both `longtask` and the
    // `buffered:true` flag (the load-bearing back-fill setting).
    expect(src).toMatch(/longtask/);
    expect(src).toMatch(/buffered:\s*(true|!0)/);
  });

  test('init script wraps observer setup in try/catch (longtask API may be unsupported)', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    const src = (fake.addInitScriptCalls[0]?.fn as () => void).toString();
    expect(src).toContain('try');
    expect(src).toContain('catch');
  });

  test('does not call page.evaluate (install is one-way)', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    expect(fake.evaluateCalls.length).toBe(0);
  });
});

describe('readLongtasks', () => {
  test('returns whatever page.evaluate returns', async () => {
    const records: LongTaskRecord[] = [
      { startTime: 100, duration: 200, name: 'self' },
      { startTime: 500, duration: 50, name: 'self' },
    ];
    const fake = makeFakePage(records);
    const got = await readLongtasks(fake as unknown as Page);
    expect(got).toEqual(records);
  });

  test('returns empty array when store is missing (observer never installed)', async () => {
    // The helper's evaluate body returns `store ?? []`; the in-page evaluator
    // would actually run that ?? branch. Here we mock the resolved value as
    // []; the test verifies the helper does NOT post-process the result.
    const fake = makeFakePage([]);
    const got = await readLongtasks(fake as unknown as Page);
    expect(got).toEqual([]);
  });

  test('passes a single zero-arg evaluator function to page.evaluate', async () => {
    const fake = makeFakePage([]);
    await readLongtasks(fake as unknown as Page);
    expect(fake.evaluateCalls.length).toBe(1);
    expect(typeof fake.evaluateCalls[0]?.fn).toBe('function');
    expect((fake.evaluateCalls[0]?.fn as () => unknown).length).toBe(0);
  });

  test('evaluator references the same globalThis store name as the installer', async () => {
    const fake = makeFakePage([]);
    await readLongtasks(fake as unknown as Page);
    const src = (fake.evaluateCalls[0]?.fn as () => unknown).toString();
    expect(src).toContain('__okScenLongTasks');
  });
});

describe('install + read contract', () => {
  test('LongTaskRecord shape includes startTime, duration, name', () => {
    // Compile-time check: if the interface drifts, this test won't compile.
    const sample: LongTaskRecord = { startTime: 0, duration: 0, name: 'self' };
    expect(sample.startTime).toBe(0);
    expect(sample.duration).toBe(0);
    expect(sample.name).toBe('self');
  });
});
