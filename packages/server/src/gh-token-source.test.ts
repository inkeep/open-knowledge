import { describe, expect, test } from 'bun:test';
import { createGhTokenSource } from './gh-token-source.ts';
import type { DetectGhFn } from './github-permissions.ts';

/** A `detectGh` stub that records call count and returns a scripted result. */
function makeDetectGh(result: ReturnType<DetectGhFn>): { fn: DetectGhFn; calls: () => number } {
  let calls = 0;
  return {
    fn: (_host?: string) => {
      calls++;
      return result;
    },
    calls: () => calls,
  };
}

/** A mutable clock so TTL expiry can be driven deterministically. */
function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createGhTokenSource', () => {
  test('returns null throughout when no detectGh is injected', () => {
    const source = createGhTokenSource(undefined);
    expect(source.get('github.com')).toBeNull();
  });

  test('returns null when gh is unavailable', () => {
    const detect = makeDetectGh({ available: false });
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toBeNull();
  });

  test('returns null when gh is available but carries no token', () => {
    const detect = makeDetectGh({ available: true });
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toBeNull();
  });

  test('resolves the token host-scoped when gh is authenticated', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toEqual({ token: 'gho_abc', host: 'github.com' });
  });

  test('caches within the TTL — only one detectGh call', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    clock.advance(59_000);
    source.get('github.com');

    expect(detect.calls()).toBe(1);
  });

  test('re-resolves after the TTL expires', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    clock.advance(60_001);
    source.get('github.com');

    expect(detect.calls()).toBe(2);
  });

  test('caches the negative result too (no token) within the TTL', () => {
    const detect = makeDetectGh({ available: false });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    expect(source.get('github.com')).toBeNull();
    clock.advance(30_000);
    expect(source.get('github.com')).toBeNull();

    expect(detect.calls()).toBe(1);
  });

  test('invalidate() forces the next get to re-resolve', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    source.invalidate();
    source.get('github.com');

    expect(detect.calls()).toBe(2);
  });
});
