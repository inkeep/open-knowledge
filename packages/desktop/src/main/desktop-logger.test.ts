import pino from 'pino';
import { describe, expect, test } from 'vitest';
import { flushDesktopLogger, getLogger, getRootDesktopLogger } from './desktop-logger.ts';

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

describe('error serialization (what the raw-err discipline buys)', () => {
  test("this package's root logger binds the stack-preserving serializer on both err keys", () => {
    const serializers = (
      getRootDesktopLogger() as unknown as Record<symbol, Record<string, unknown>>
    )[pino.symbols.serializersSym];
    for (const key of ['err', 'error'] as const) {
      expect(serializers?.[key]).toBe(pino.stdSerializers.err);
      const rendered = (serializers?.[key] as (e: Error) => { message?: string; stack?: string })(
        new Error('boom-probe'),
      );
      expect(rendered.message).toBe('boom-probe');
      expect(rendered.stack ?? '').toContain('boom-probe');
    }
  });
});
