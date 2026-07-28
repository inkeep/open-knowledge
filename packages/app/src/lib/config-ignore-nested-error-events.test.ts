import { describe, expect, test, vi } from 'vitest';
import {
  emitConfigIgnoreNestedError,
  subscribeToConfigIgnoreNestedError,
} from './config-ignore-nested-error-events';

const SAMPLE_PAYLOAD = {
  v: 1 as const,
  ch: 'config-ignore-nested-error' as const,
  seq: 1,
  path: 'subdir/.okignore',
  error: 'unparseable line',
};

describe('config-ignore-nested-error-events pubsub', () => {
  test('subscribed listener fires on emit', () => {
    const listener = vi.fn(() => {});
    const unsub = subscribeToConfigIgnoreNestedError(listener);
    emitConfigIgnoreNestedError(SAMPLE_PAYLOAD);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(SAMPLE_PAYLOAD);
    unsub();
  });

  test('unsubscribe stops the listener', () => {
    const listener = vi.fn(() => {});
    const unsub = subscribeToConfigIgnoreNestedError(listener);
    unsub();
    emitConfigIgnoreNestedError(SAMPLE_PAYLOAD);
    expect(listener).not.toHaveBeenCalled();
  });

  test('multiple subscribers all fire', () => {
    const a = vi.fn(() => {});
    const b = vi.fn(() => {});
    const ua = subscribeToConfigIgnoreNestedError(a);
    const ub = subscribeToConfigIgnoreNestedError(b);
    emitConfigIgnoreNestedError(SAMPLE_PAYLOAD);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    ua();
    ub();
  });

  test('listener exception is caught; other listeners still fire', () => {
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn(() => {});
    const u1 = subscribeToConfigIgnoreNestedError(thrower);
    const u2 = subscribeToConfigIgnoreNestedError(ok);
    expect(() => emitConfigIgnoreNestedError(SAMPLE_PAYLOAD)).not.toThrow();
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  test('payload pass-through preserves all fields including unknown extras (forward-compat)', () => {
    let received: unknown;
    const unsub = subscribeToConfigIgnoreNestedError((event) => {
      received = event;
    });
    const withExtras = {
      ...SAMPLE_PAYLOAD,
      seq: 7,
      path: 'a/b/c/.okignore',
      error: 'syntax',
      extra: 'whatever',
    } as unknown as typeof SAMPLE_PAYLOAD;
    emitConfigIgnoreNestedError(withExtras);
    expect(received).toEqual(withExtras);
    unsub();
  });
});
