import { describe, expect, test } from 'bun:test';
import { logIpcError } from './ipc-log.ts';

interface CapturedWarn {
  readonly args: readonly unknown[];
}

function captureWarn(fn: () => void): CapturedWarn[] {
  const captured: CapturedWarn[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push({ args });
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

describe('logIpcError — cause boundary normalization', () => {
  test('plain-object cause round-trips faithfully', () => {
    const captured = captureWarn(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:spawn-cursor',
        reason: 'invalid-path',
        handler: 'spawnCursor',
        cause: { capturedSenderId: 1, gotSenderId: 2 },
      });
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed.cause).toEqual({ capturedSenderId: 1, gotSenderId: 2 });
  });

  test('Error-instance cause preserves message and name on the wire', () => {
    const err = new Error('write-mcp-configs-threw boom');
    const captured = captureWarn(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'write-mcp-configs-threw',
        handler: 'mcpWiringConfirm',
        cause: err,
      });
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed.cause).toBeDefined();
    expect(parsed.cause.message).toBe('write-mcp-configs-threw boom');
    expect(parsed.cause.name).toBe('Error');
  });

  test('circular cause does not throw — emits a degraded-but-safe log line', () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;
    let threw: unknown = null;
    const captured = captureWarn(() => {
      try {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:mcp-wiring:confirm',
          reason: 'write-mcp-configs-threw',
          handler: 'mcpWiringConfirm',
          cause: obj,
        });
      } catch (e) {
        threw = e;
      }
    });
    expect(threw).toBeNull();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.channel).toBe('ok:mcp-wiring:confirm');
    expect(parsed.reason).toBe('write-mcp-configs-threw');
    expect(parsed.handler).toBe('mcpWiringConfirm');
  });

  test('circular Error.cause chain does not throw — emits a degraded-but-safe log line', () => {
    const a: Error & { cause?: unknown } = new Error('outer');
    const b: Error & { cause?: unknown } = new Error('inner');
    a.cause = b;
    b.cause = a;
    let threw: unknown = null;
    const captured = captureWarn(() => {
      try {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:mcp-wiring:confirm',
          reason: 'write-mcp-configs-threw',
          handler: 'mcpWiringConfirm',
          cause: a,
        });
      } catch (e) {
        threw = e;
      }
    });
    expect(threw).toBeNull();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.cause.message).toBe('outer');
    expect(parsed.cause.cause.message).toBe('inner');
    expect(parsed.cause.cause.cause.message).toBe('outer');
    expect(parsed.cause.cause.cause.cause).toBe('<circular>');
  });

  test('cause undefined elides the cause field from the wire shape', () => {
    const captured = captureWarn(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:spawn-cursor',
        reason: 'spawn-error',
        handler: 'spawnCursor',
      });
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed).not.toHaveProperty('cause');
  });

  test('BigInt cause triggers the outer-fallback serialization path', () => {
    const captured = captureWarn(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'write-mcp-configs-threw',
        handler: 'mcpWiringConfirm',
        cause: { value: 42n },
      });
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed._causeSerializationFailed).toBe(true);
    expect(parsed).not.toHaveProperty('cause');
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.channel).toBe('ok:mcp-wiring:confirm');
    expect(parsed.reason).toBe('write-mcp-configs-threw');
    expect(parsed.handler).toBe('mcpWiringConfirm');
  });
});
