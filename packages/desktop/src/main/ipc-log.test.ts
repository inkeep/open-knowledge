import { beforeEach, describe, expect, test, vi } from 'vitest';
import { logIpcError, withIpcErrorLogging } from './ipc-log.ts';

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
  test('withIpcErrorLogging records and rethrows unexpected handler failures', async () => {
    const err = new Error('note window constructor failed');
    err.stack = 'STACK: note window constructor failed';
    const captured: CapturedWarn[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push({ args });
    };
    try {
      await expect(
        withIpcErrorLogging(
          {
            channel: 'ok:window:open-note',
            reason: 'unexpected',
            handler: 'openNoteWindow',
          },
          async () => {
            throw err;
          },
        ),
      ).rejects.toBe(err);
    } finally {
      console.warn = original;
    }

    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed).toMatchObject({
      event: 'ipc.error',
      channel: 'ok:window:open-note',
      reason: 'unexpected',
      handler: 'openNoteWindow',
    });
    expect(parsed.cause.stack).toBe('STACK: note window constructor failed');
  });

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

describe('logIpcError — bounded details', () => {
  test('details ride the emitted payload alongside the canonical discriminants', () => {
    const captured = captureWarn(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'network-error',
        handler: 'handleBugReportSend',
        details: { step: 'upload', errCode: 'ENOTFOUND', host: 'intake.example.com' },
      });
    });

    expect(captured).toHaveLength(1);
    expect(JSON.parse(String(captured[0].args[0]))).toEqual({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'network-error',
      handler: 'handleBugReportSend',
      details: { step: 'upload', errCode: 'ENOTFOUND', host: 'intake.example.com' },
    });
  });

  test('omitting details leaves the canonical wire shape byte-identical', () => {
    const captured = captureWarn(() => {
      logIpcError({ event: 'ipc.error', channel: 'c', reason: 'r', handler: 'h' });
    });

    expect(JSON.parse(String(captured[0].args[0]))).toEqual({
      event: 'ipc.error',
      channel: 'c',
      reason: 'r',
      handler: 'h',
    });
  });
});

const pinoWarn = vi.hoisted(() => vi.fn());

vi.mock('./desktop-logger.ts', () => ({
  getLogger: () => ({
    warn: pinoWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('logIpcError — the pino leg (the surface that ships in diagnostic bundles)', () => {
  beforeEach(() => {
    pinoWarn.mockClear();
  });

  function pinoFields(emit: () => void): Record<string, unknown> {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      emit();
    } finally {
      console.warn = originalWarn;
    }
    expect(pinoWarn).toHaveBeenCalledTimes(1);
    return pinoWarn.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  test('the canonical discriminants reach the file logger', () => {
    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'upload-network-error',
        handler: 'handleBugReportSend',
      });
    });

    expect(fields).toMatchObject({
      channel: 'ok:bug-report:dispatch',
      reason: 'upload-network-error',
      handler: 'handleBugReportSend',
    });
  });

  test('an Error cause contributes its class to the file logger', () => {
    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:window:open-note',
        reason: 'unexpected',
        handler: 'openNoteWindow',
        cause: new TypeError('fetch failed'),
      });
    });

    expect(fields.errName).toBe('TypeError');
  });

  test('an errno hidden one level down in cause is recovered', () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND intake'), {
      code: 'ENOTFOUND',
    });
    const outer = new TypeError('fetch failed', { cause: inner });

    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'mint-network-error',
        handler: 'handleBugReportSend',
        cause: outer,
      });
    });

    expect(fields.errName).toBe('TypeError');
    expect(fields.errCode).toBe('ENOTFOUND');
  });

  test('no stack and no free-form message reach the file logger', () => {
    const err = Object.assign(
      new Error("ENOENT: no such file or directory, open '/Users/someone/private/notes.md'"),
      { code: 'ENOENT' },
    );
    err.stack = 'Error: ENOENT\n    at /Users/someone/private/app.ts:1:1';

    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:open-asset',
        reason: 'open-failed',
        handler: 'openAssetSafely',
        cause: err,
      });
    });

    expect(fields.errCode).toBe('ENOENT');
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain('/Users/someone');
    expect(serialized).not.toContain('no such file or directory');
  });

  test('call-site details win over facts derived from the cause', () => {
    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'upload-network-error',
        handler: 'handleBugReportSend',
        cause: Object.assign(new TypeError('fetch failed'), { code: 'GENERIC' }),
        details: { step: 'upload', errCode: 'UND_ERR_SOCKET', host: 'storage.example.com' },
      });
    });

    expect(fields).toMatchObject({
      step: 'upload',
      errCode: 'UND_ERR_SOCKET',
      host: 'storage.example.com',
    });
  });

  test('a cyclic cause chain cannot cost the log line', () => {
    const a = new Error('a');
    const b = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });

    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'write-mcp-configs-threw',
        handler: 'mcpWiringConfirm',
        cause: a,
      });
    });

    expect(fields).toMatchObject({
      channel: 'ok:mcp-wiring:confirm',
      reason: 'write-mcp-configs-threw',
    });
  });

  test('a cause that throws on inspection cannot suppress the log line', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'code', {
      enumerable: true,
      get() {
        throw new Error('inspection refused');
      },
    });

    const fields = pinoFields(() => {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:spawn-cursor',
        reason: 'spawn-failed',
        handler: 'spawnCursor',
        cause: hostile,
      });
    });

    expect(fields).toMatchObject({
      channel: 'ok:shell:spawn-cursor',
      reason: 'spawn-failed',
      handler: 'spawnCursor',
    });
  });
});
