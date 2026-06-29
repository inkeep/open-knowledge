import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { readNumericOverride, resetPerfOverrideWarnings } from './env-override';

const hadWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';

describe('readNumericOverride', () => {
  const originalEnv = { ...import.meta.env };
  let warnSpy: ReturnType<typeof spyOn>;

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

  beforeEach(() => {
    resetPerfOverrideWarnings();
    if (typeof window !== 'undefined') {
      delete window.__okPerfOverrides;
    }
    for (const key of Object.keys(import.meta.env)) {
      if (key.startsWith('VITE_OK_PERF_')) {
        delete (import.meta.env as Record<string, unknown>)[key];
      }
    }
    warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of Object.keys(originalEnv)) {
      (import.meta.env as Record<string, unknown>)[key] = (originalEnv as Record<string, unknown>)[
        key
      ];
    }
    warnSpy.mockRestore();
    resetPerfOverrideWarnings();
  });

  test('returns default when no override is set', () => {
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(10);
    expect(readNumericOverride('BYTES_CACHE_THRESHOLD', 500_000)).toBe(500_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('returns window override when set and numeric', () => {
    window.__okPerfOverrides = { MAX_CACHE: 50 };
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(50);
  });

  test('warns exactly once per key when window override fires', () => {
    window.__okPerfOverrides = { MAX_CACHE: 50 };
    readNumericOverride('MAX_CACHE', 10);
    readNumericOverride('MAX_CACHE', 10);
    readNumericOverride('MAX_CACHE', 10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('MAX_CACHE = 50');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('window.__okPerfOverrides');
  });

  test('returns env override when window is unset and env has a numeric value', () => {
    (import.meta.env as Record<string, string>).VITE_OK_PERF_BYTES_CACHE_THRESHOLD = '10000000';
    expect(readNumericOverride('BYTES_CACHE_THRESHOLD', 500_000)).toBe(10_000_000);
  });

  test('window override takes precedence over env override', () => {
    window.__okPerfOverrides = { MAX_CACHE: 99 };
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_CACHE = '42';
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(99);
  });

  test('falls back to default when env value is not numeric', () => {
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_CACHE = 'not-a-number';
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('not numeric');
  });

  test('rejects non-finite window override (NaN / Infinity)', () => {
    window.__okPerfOverrides = { MAX_CACHE: Number.NaN };
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(10);

    window.__okPerfOverrides = { MAX_CACHE: Number.POSITIVE_INFINITY };
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(10);
  });

  test('zero is a valid override value (distinguishes from unset)', () => {
    window.__okPerfOverrides = { MAX_CACHE: 0 };
    expect(readNumericOverride('MAX_CACHE', 10)).toBe(0);
  });

  test('warn-once cache is keyed per override key', () => {
    window.__okPerfOverrides = { MAX_CACHE: 50, VIEW_COUNT_CACHE_THRESHOLD: 100 };
    readNumericOverride('MAX_CACHE', 10);
    readNumericOverride('VIEW_COUNT_CACHE_THRESHOLD', 50);
    readNumericOverride('MAX_CACHE', 10); // suppressed
    readNumericOverride('VIEW_COUNT_CACHE_THRESHOLD', 50); // suppressed
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('resetPerfOverrideWarnings clears the once-cache so tests can re-observe warnings', () => {
    window.__okPerfOverrides = { MAX_CACHE: 50 };
    readNumericOverride('MAX_CACHE', 10);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    resetPerfOverrideWarnings();
    readNumericOverride('MAX_CACHE', 10);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('exposes 9 new substrate dials with documented defaults', () => {
    expect(readNumericOverride('SYNC_TIMEOUT_MS', 30_000)).toBe(30_000);
    expect(readNumericOverride('MAX_BUFFER_BYTES', 1_048_576)).toBe(1_048_576);
    expect(readNumericOverride('MOUNT_STALLED_THRESHOLD_MS', 10_000)).toBe(10_000);
    expect(readNumericOverride('HOVER_INTENT_MS', 80)).toBe(80);
    expect(readNumericOverride('MAX_RING_ENTRIES', 5000)).toBe(5000);
    expect(readNumericOverride('MAX_VITALS_RING_ENTRIES', 200)).toBe(200);
    expect(readNumericOverride('MAX_HISTOGRAM_PRECISION', 3)).toBe(3);
    expect(readNumericOverride('BURST_DEBOUNCE_MS', 400)).toBe(400);
    expect(readNumericOverride('PREWARM_CORRELATION_WINDOW_MS', 5_000)).toBe(5_000);
  });

  test('window override reaches every new substrate dial', () => {
    window.__okPerfOverrides = {
      SYNC_TIMEOUT_MS: 1,
      MAX_BUFFER_BYTES: 2,
      MOUNT_STALLED_THRESHOLD_MS: 3,
      HOVER_INTENT_MS: 4,
      MAX_RING_ENTRIES: 5,
      MAX_VITALS_RING_ENTRIES: 6,
      MAX_HISTOGRAM_PRECISION: 7,
      BURST_DEBOUNCE_MS: 8,
      PREWARM_CORRELATION_WINDOW_MS: 9,
    };
    expect(readNumericOverride('SYNC_TIMEOUT_MS', 30_000)).toBe(1);
    expect(readNumericOverride('MAX_BUFFER_BYTES', 1_048_576)).toBe(2);
    expect(readNumericOverride('MOUNT_STALLED_THRESHOLD_MS', 10_000)).toBe(3);
    expect(readNumericOverride('HOVER_INTENT_MS', 80)).toBe(4);
    expect(readNumericOverride('MAX_RING_ENTRIES', 5000)).toBe(5);
    expect(readNumericOverride('MAX_VITALS_RING_ENTRIES', 200)).toBe(6);
    expect(readNumericOverride('MAX_HISTOGRAM_PRECISION', 3)).toBe(7);
    expect(readNumericOverride('BURST_DEBOUNCE_MS', 400)).toBe(8);
    expect(readNumericOverride('PREWARM_CORRELATION_WINDOW_MS', 5_000)).toBe(9);
  });

  test('env override reaches every new substrate dial', () => {
    (import.meta.env as Record<string, string>).VITE_OK_PERF_SYNC_TIMEOUT_MS = '11';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_BUFFER_BYTES = '12';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MOUNT_STALLED_THRESHOLD_MS = '13';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_HOVER_INTENT_MS = '14';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_RING_ENTRIES = '15';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_VITALS_RING_ENTRIES = '16';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_MAX_HISTOGRAM_PRECISION = '17';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_BURST_DEBOUNCE_MS = '18';
    (import.meta.env as Record<string, string>).VITE_OK_PERF_PREWARM_CORRELATION_WINDOW_MS = '19';
    expect(readNumericOverride('SYNC_TIMEOUT_MS', 30_000)).toBe(11);
    expect(readNumericOverride('MAX_BUFFER_BYTES', 1_048_576)).toBe(12);
    expect(readNumericOverride('MOUNT_STALLED_THRESHOLD_MS', 10_000)).toBe(13);
    expect(readNumericOverride('HOVER_INTENT_MS', 80)).toBe(14);
    expect(readNumericOverride('MAX_RING_ENTRIES', 5000)).toBe(15);
    expect(readNumericOverride('MAX_VITALS_RING_ENTRIES', 200)).toBe(16);
    expect(readNumericOverride('MAX_HISTOGRAM_PRECISION', 3)).toBe(17);
    expect(readNumericOverride('BURST_DEBOUNCE_MS', 400)).toBe(18);
    expect(readNumericOverride('PREWARM_CORRELATION_WINDOW_MS', 5_000)).toBe(19);
  });

  test('PROD short-circuit returns default ignoring all override channels', () => {
    const original = (import.meta.env as Record<string, unknown>).PROD;
    try {
      (import.meta.env as Record<string, unknown>).PROD = true;
      window.__okPerfOverrides = { MAX_CACHE: 999 };
      (import.meta.env as Record<string, string>).VITE_OK_PERF_BYTES_CACHE_THRESHOLD = '10000000';
      expect(readNumericOverride('MAX_CACHE', 10)).toBe(10);
      expect(readNumericOverride('BYTES_CACHE_THRESHOLD', 500_000)).toBe(500_000);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      (import.meta.env as Record<string, unknown>).PROD = original;
    }
  });
});

