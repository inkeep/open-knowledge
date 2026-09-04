import { describe, expect, test } from 'vitest';
import { flushDesktopLogger, getLogger } from './desktop-logger.ts';

describe('flushDesktopLogger', () => {
  test('does not throw when called before any logging has initialized the destination', () => {
    expect(() => flushDesktopLogger()).not.toThrow();
  });

  test('does not throw after the destination has been initialized by a log call', () => {
    getLogger('test-flush').info({}, 'init destination');
    expect(() => flushDesktopLogger()).not.toThrow();
    expect(() => flushDesktopLogger()).not.toThrow();
  });
});
