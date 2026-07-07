import { describe, expect, test } from 'bun:test';
import { flushDesktopLogger, getLogger } from './desktop-logger.ts';

// `flushDesktopLogger` runs on the shutdown path (`will-quit`, before
// `quitAndInstall`). It must be best-effort and never throw — a flush that
// blew up there would derail the very shutdown it's trying to make observable.
describe('flushDesktopLogger', () => {
  test('does not throw when called before any logging has initialized the destination', () => {
    expect(() => flushDesktopLogger()).not.toThrow();
  });

  test('does not throw after the destination has been initialized by a log call', () => {
    getLogger('test-flush').info({}, 'init destination');
    expect(() => flushDesktopLogger()).not.toThrow();
    // Idempotent — a second drain on an already-flushed buffer is still a no-throw no-op.
    expect(() => flushDesktopLogger()).not.toThrow();
  });
});
