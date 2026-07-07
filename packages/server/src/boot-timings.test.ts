import { afterEach, describe, expect, test } from 'bun:test';
import {
  bootElapsedMs,
  getBootTimings,
  recordBootPhase,
  resetBootTimingsForTest,
  setBootField,
  startBootTimings,
} from './boot-timings.ts';

afterEach(() => {
  resetBootTimingsForTest();
});

describe('boot-timings', () => {
  test('returns undefined before startBootTimings runs', () => {
    resetBootTimingsForTest();
    expect(getBootTimings()).toBeUndefined();
    expect(bootElapsedMs()).toBeUndefined();
  });

  test('startBootTimings stamps startedAt and arms the monotonic clock', () => {
    startBootTimings('2026-06-30T00:00:00.000Z');
    const t = getBootTimings();
    expect(t).toBeDefined();
    expect(t?.startedAt).toBe('2026-06-30T00:00:00.000Z');
    // All duration fields absent until recorded.
    expect(t?.httpListenMs).toBeUndefined();
    expect(t?.readyMs).toBeUndefined();
    expect(t?.fileCount).toBeUndefined();
    // The monotonic clock is armed, so bootElapsedMs is a finite number.
    expect(typeof bootElapsedMs()).toBe('number');
    expect(bootElapsedMs()).toBeGreaterThanOrEqual(0);
  });

  test('defaults startedAt to an ISO string when omitted', () => {
    startBootTimings();
    const startedAt = getBootTimings()?.startedAt;
    expect(startedAt).toBeDefined();
    // Round-trips through Date without becoming Invalid Date.
    expect(Number.isNaN(Date.parse(startedAt as string))).toBe(false);
  });

  test('recordBootPhase accumulates duration fields', () => {
    startBootTimings('2026-06-30T00:00:00.000Z');
    recordBootPhase('httpListenMs', 12);
    recordBootPhase('seedWalkMs', 34);
    recordBootPhase('indexesMs', 56);
    recordBootPhase('readyMs', 78);
    const t = getBootTimings();
    expect(t).toMatchObject({
      startedAt: '2026-06-30T00:00:00.000Z',
      httpListenMs: 12,
      seedWalkMs: 34,
      indexesMs: 56,
      readyMs: 78,
    });
  });

  test('setBootField records the bounded file count', () => {
    startBootTimings('2026-06-30T00:00:00.000Z');
    setBootField('fileCount', 42);
    expect(getBootTimings()?.fileCount).toBe(42);
  });

  test('recordBootPhase / setBootField are no-ops before startBootTimings', () => {
    resetBootTimingsForTest();
    recordBootPhase('httpListenMs', 99);
    setBootField('fileCount', 99);
    expect(getBootTimings()).toBeUndefined();
  });

  test('resetBootTimingsForTest clears the singleton and disarms the clock', () => {
    startBootTimings('2026-06-30T00:00:00.000Z');
    recordBootPhase('readyMs', 5);
    resetBootTimingsForTest();
    expect(getBootTimings()).toBeUndefined();
    expect(bootElapsedMs()).toBeUndefined();
  });

  test('a fresh startBootTimings drops prior phase values', () => {
    startBootTimings('2026-06-30T00:00:00.000Z');
    recordBootPhase('httpListenMs', 12);
    startBootTimings('2026-06-30T01:00:00.000Z');
    const t = getBootTimings();
    expect(t?.startedAt).toBe('2026-06-30T01:00:00.000Z');
    expect(t?.httpListenMs).toBeUndefined();
  });
});
