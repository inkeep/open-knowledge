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
    expect(src).toContain('__okScenLongTasks');
  });

  test('init script registers a PerformanceObserver for the longtask type', async () => {
    const fake = makeFakePage();
    await installLongtaskObserver(fake as unknown as Page);
    const src = (fake.addInitScriptCalls[0]?.fn as () => void).toString();
    expect(src).toContain('PerformanceObserver');
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
    const sample: LongTaskRecord = { startTime: 0, duration: 0, name: 'self' };
    expect(sample.startTime).toBe(0);
    expect(sample.duration).toBe(0);
    expect(sample.name).toBe('self');
  });
});
