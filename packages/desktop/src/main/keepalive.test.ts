import { describe, expect, test } from 'bun:test';
import type { DesktopLogger } from './desktop-logger.ts';
import { createDesktopKeepaliveFactory, toKeepaliveLogger } from './keepalive.ts';
import type { ServerLockMetadataLike } from './window-manager.ts';

const FAKE_LOCK: ServerLockMetadataLike = {
  pid: 12345,
  hostname: 'my-host',
  port: 51234,
  startedAt: '2026-05-21T00:00:00.000Z',
  worktreeRoot: '/tmp/keepalive-test',
  kind: 'interactive',
  capabilities: ['http', 'ws'],
};

// The factory requires a logger (observability is the point); tests that only
// exercise the lock-reader contract pass a no-op.
const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

describe('createDesktopKeepaliveFactory', () => {
  test('returns a handle with close()/isConnected()', () => {
    const factory = createDesktopKeepaliveFactory({
      readServerLock: () => FAKE_LOCK,
      logger: NOOP_LOGGER,
    });
    const handle = factory({ lockDir: '/tmp/keepalive-test/.ok/local' });
    expect(typeof handle.close).toBe('function');
    expect(typeof handle.isConnected).toBe('function');
    expect(handle.isConnected()).toBe(false); // hasn't connected yet (microtask gate)
    handle.close();
  });

  test('close() is idempotent — second call does not throw', () => {
    const factory = createDesktopKeepaliveFactory({
      readServerLock: () => FAKE_LOCK,
      logger: NOOP_LOGGER,
    });
    const handle = factory({ lockDir: '/tmp/k/.ok/local' });
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  test('resolveWsUrl returns undefined when readServerLock returns null', async () => {
    // We can't observe resolveWsUrl directly from the public handle, but we
    // can validate the dep contract by passing a reader that ALWAYS returns
    // null and confirming the factory neither throws nor opens a connection.
    let nullReads = 0;
    const factory = createDesktopKeepaliveFactory({
      readServerLock: () => {
        nullReads++;
        return null;
      },
      logger: NOOP_LOGGER,
    });
    const handle = factory({ lockDir: '/tmp/nope/.ok/local' });
    // The keepalive's initial connect is queued on a microtask; give it a
    // tick so the resolveWsUrl callback fires at least once.
    await new Promise<void>((r) => setImmediate(r));
    expect(nullReads).toBeGreaterThanOrEqual(1);
    expect(handle.isConnected()).toBe(false);
    handle.close();
  });

  test('resolveWsUrl returns undefined when port is zero (server still starting)', async () => {
    let zeroPortReads = 0;
    const factory = createDesktopKeepaliveFactory({
      readServerLock: () => {
        zeroPortReads++;
        return { ...FAKE_LOCK, port: 0 };
      },
      logger: NOOP_LOGGER,
    });
    const handle = factory({ lockDir: '/tmp/starting/.ok/local' });
    await new Promise<void>((r) => setImmediate(r));
    expect(zeroPortReads).toBeGreaterThanOrEqual(1);
    expect(handle.isConnected()).toBe(false);
    handle.close();
  });
});

describe('toKeepaliveLogger', () => {
  type Call = { data: Record<string, unknown>; msg: string };

  function makeRecordingLogger(): { logger: DesktopLogger; calls: Record<string, Call[]> } {
    const calls: Record<string, Call[]> = { info: [], warn: [], error: [], debug: [] };
    const record =
      (level: string) =>
      (data: Record<string, unknown>, msg: string): void => {
        calls[level].push({ data, msg });
      };
    return {
      logger: {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
      },
      calls,
    };
  }

  test('swaps (msg, ctx) → the DesktopLogger (data, msg) argument order', () => {
    const { logger, calls } = makeRecordingLogger();
    const ka = toKeepaliveLogger(logger);

    ka.info('connected', { url: 'ws://localhost:51234' });
    ka.warn('reconnect failed', { error: 'boom' });
    ka.error('down', { code: 1006 });
    ka.debug('scheduling reconnect', { backoffMs: 2000 });

    expect(calls.info).toEqual([{ data: { url: 'ws://localhost:51234' }, msg: 'connected' }]);
    expect(calls.warn).toEqual([{ data: { error: 'boom' }, msg: 'reconnect failed' }]);
    expect(calls.error).toEqual([{ data: { code: 1006 }, msg: 'down' }]);
    expect(calls.debug).toEqual([{ data: { backoffMs: 2000 }, msg: 'scheduling reconnect' }]);
  });

  test('omitted ctx becomes an empty data object (never undefined) at every level', () => {
    const { logger, calls } = makeRecordingLogger();
    const ka = toKeepaliveLogger(logger);

    ka.info('connected');
    ka.warn('flaky');
    ka.error('down');
    ka.debug('tick');

    expect(calls.info).toEqual([{ data: {}, msg: 'connected' }]);
    expect(calls.warn).toEqual([{ data: {}, msg: 'flaky' }]);
    expect(calls.error).toEqual([{ data: {}, msg: 'down' }]);
    expect(calls.debug).toEqual([{ data: {}, msg: 'tick' }]);
  });
});
