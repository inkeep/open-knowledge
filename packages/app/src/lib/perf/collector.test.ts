import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getCollector, recordMark, recordVital } from './collector';

const hadWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
beforeAll(() => {
  if (!hadWindow) {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
});
afterAll(() => {
  if (!hadWindow) {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe('getCollector', () => {
  beforeEach(() => {
    getCollector()?.reset();
  });

  test('returns a collector object in dev builds', () => {
    const c = getCollector();
    expect(c).toBeDefined();
    expect(c?.marks.toArray()).toBeInstanceOf(Array);
    expect(c?.vitals.toArray()).toBeInstanceOf(Array);
    expect(typeof c?.startedAt).toBe('number');
  });

  test('is idempotent — same reference across calls', () => {
    const a = getCollector();
    const b = getCollector();
    expect(a).toBe(b);
  });

  test('attaches the collector at globalThis.__ok_perf', () => {
    getCollector();
    expect((globalThis as { __ok_perf?: unknown }).__ok_perf).toBeDefined();
  });
});

describe('recordMark', () => {
  beforeEach(() => {
    getCollector()?.reset();
  });

  test('appends to collector.marks', () => {
    recordMark({
      name: 'ok/test/one',
      startTime: 0,
      duration: 0,
      track: 'ok/test',
    });
    const c = getCollector();
    expect(c?.marks.length).toBe(1);
    expect(c?.marks.toArray()[0]?.name).toBe('ok/test/one');
  });
});

describe('recordVital', () => {
  beforeEach(() => {
    getCollector()?.reset();
  });

  test('appends to collector.vitals', () => {
    recordVital({
      name: 'INP',
      value: 180,
      rating: 'good',
      delta: 180,
      id: 'v1-1',
    });
    const c = getCollector();
    expect(c?.vitals.length).toBe(1);
    expect(c?.vitals.toArray()[0]?.name).toBe('INP');
  });
});

describe('collector.reset', () => {
  test('clears marks and vitals without changing identity', () => {
    const c = getCollector();
    recordMark({
      name: 'ok/test/pre-reset',
      startTime: 0,
      duration: 0,
      track: 'ok/test',
    });
    recordVital({
      name: 'LCP',
      value: 2000,
      rating: 'needs-improvement',
      delta: 2000,
      id: 'v1-2',
    });
    c?.reset();
    expect(c?.marks.length).toBe(0);
    expect(c?.vitals.length).toBe(0);
    expect(getCollector()).toBe(c);
  });

  test('marks ring evicts oldest at capacity (MAX_RING_ENTRIES)', () => {
    (globalThis as { __ok_perf?: unknown }).__ok_perf = undefined;
    window.__okPerfOverrides = { MAX_RING_ENTRIES: 3 };
    try {
      const c = getCollector();
      expect(c).toBeDefined();
      for (let i = 0; i < 5; i += 1) {
        recordMark({
          name: `ok/test/seq-${i}`,
          startTime: i,
          duration: 0,
          track: 'ok/test',
        });
      }
      expect(c?.marks.length).toBe(3);
      const names = c?.marks.toArray().map((m) => m.name) ?? [];
      expect(names).toEqual(['ok/test/seq-2', 'ok/test/seq-3', 'ok/test/seq-4']);
    } finally {
      delete window.__okPerfOverrides;
      (globalThis as { __ok_perf?: unknown }).__ok_perf = undefined;
    }
  });
});
