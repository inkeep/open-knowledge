/**
 * `logIpcError` boundary normalization — pins the canonical-payload contract
 * for the structured IPC failure log shape against three classes of `cause`
 * input that the canonical-payload contract must preserve:
 *
 *   1. Plain object cause — round-trips faithfully (existing baseline).
 *   2. Error instance cause — message + name + stack are preserved on the
 *      wire. `JSON.stringify(new Error('boom'))` returns `'{}'` because
 *      Error's standard properties are non-enumerable, so without a
 *      boundary-side normalize step every `cause: err` site in
 *      mcp-wiring.ts (and the pattern that future handlers will copy) would
 *      emit `{"cause":{}}` and silently lose the very context the
 *      observability discipline exists to preserve.
 *   3. Circular-reference cause — emits a degraded-but-safe log line
 *      instead of throwing. `JSON.stringify` throws TypeError on cyclic
 *      structures; without a boundary-side try/catch the throw escapes the
 *      IPC handler's catch block and the renderer sees an unhandled invoke
 *      rejection instead of the structured `{ ok: false; error: <message> }`
 *      return shape that retriable-consent dialogs depend on.
 */

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
    // Most-load-bearing assertion: the message is on the wire (the field the
    // operator greps when triaging "which exact write failed?"). Without the
    // boundary normalize, this would be `cause: {}` because the JSON.stringify
    // default omits non-enumerable Error properties.
    expect(parsed.cause.message).toBe('write-mcp-configs-threw boom');
    // Name should also survive — distinguishes Error subclass at triage time
    // (TypeError vs SyntaxError vs custom).
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
    // Most-load-bearing assertion: the function does NOT throw on circular
    // input. Without the boundary try/catch, this would propagate out of
    // every handler that wraps a real Error with a circular .cause chain.
    expect(threw).toBeNull();
    // Some log line still emits — the structured shape (event/channel/reason/
    // handler) is preserved even when the cause itself is unserializable.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.channel).toBe('ok:mcp-wiring:confirm');
    expect(parsed.reason).toBe('write-mcp-configs-threw');
    expect(parsed.handler).toBe('mcpWiringConfirm');
  });

  test('circular Error.cause chain does not throw — emits a degraded-but-safe log line', () => {
    // Without a per-call visited tracker
    // in `normalizeCause`, a self-referential Error.cause chain
    // (`a.cause = b; b.cause = a`) recurses infinitely and stack-overflows
    // synchronously BEFORE the outer try/catch around JSON.stringify wraps
    // anything. The RangeError would then escape `logIpcError` entirely —
    // breaking the contract that the IPC handler's catch block can rely on
    // structured-logging never throwing.
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
    // Most-load-bearing assertion: no throw escapes. Stack overflow would
    // surface as `RangeError: Maximum call stack size exceeded`.
    expect(threw).toBeNull();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(captured[0].args[0] as string);
    // Wire shape preserved. The chain is truncated at the first cycle —
    // outer Error's `cause` (which is b) gets normalized; b's chained
    // cause (which is a — already seen) is replaced with the marker.
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.cause.message).toBe('outer');
    expect(parsed.cause.cause.message).toBe('inner');
    // The chain truncates exactly when `a` is seen again — at the third
    // level. That node carries `a`'s fields one more time with the cycle
    // marker on its `cause` slot (terminating the recursion). The literal
    // `'<circular>'` lives one level deeper.
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
    // Direct exercise of the outer try/catch at the bottom of `logIpcError`.
    // `normalizeCause` is a pass-through for non-Error inputs, so a plain
    // object containing a BigInt makes it through to `JSON.stringify` —
    // which throws TypeError on BigInt. The outer catch must drop `cause`
    // and emit the structured-but-degraded `_causeSerializationFailed: true`
    // wire shape so the surrounding IPC handler's catch isn't bypassed.
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
    // Structured shape (event/channel/reason/handler) still reaches the wire.
    expect(parsed.event).toBe('ipc.error');
    expect(parsed.channel).toBe('ok:mcp-wiring:confirm');
    expect(parsed.reason).toBe('write-mcp-configs-threw');
    expect(parsed.handler).toBe('mcpWiringConfirm');
  });
});

describe('logIpcError — bounded details', () => {
  test('details ride the emitted payload alongside the canonical discriminants', () => {
    // `details` exists so a failed send is diagnosable from the bundle the
    // user submits rather than only from a terminal someone was tailing: the
    // fields below are what separate "this machine's DNS is broken" from "the
    // intake is down" from "the TLS clock is skewed", all of which reached the
    // log as the bare token `network-error` before.
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

/**
 * The pino leg is the ONLY `logIpcError` surface that reaches
 * `~/.ok/logs/desktop.*.log`, and therefore the only one that reaches a
 * diagnostic bundle a reporter sends us. `console.warn` goes to main-process
 * stdio, which nothing captures in a packaged app launched from Finder.
 *
 * Every other test in this file asserts `console.warn`. That asymmetry is why
 * a failed bug-report send reached support as one bare line carrying no cause
 * and no errno: the leg that ships was never exercised, so nothing noticed it
 * was being handed three fields while the leg nobody reads got the rest.
 */
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

  /** Emit once with `console.warn` silenced and return what pino was handed. */
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
    // Every channel that catches an unknown and passes `cause: err` gets this
    // without hand-building `details` — which is what makes the fix worth
    // making here rather than at one call site.
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
    // undici reports every transport failure as the same opaque
    // `TypeError: fetch failed` and hangs the real error in `cause`, so reading
    // `code` off the caught value alone yields nothing on exactly the failures
    // worth triaging.
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
    // `details` (and everything derived alongside it) is collected into
    // user-submitted bundles, so it takes only values bounded by construction.
    // A stack carries absolute paths out of the reporter's home directory and
    // an errno message carries the filename that could not be opened; neither
    // may be written into a file the reporter hands to support. The class and
    // the errno are what discriminate the failure, and they are bounded.
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
    // A handler that has already classified its own failure knows more than a
    // generic walk of the caught value can.
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
    // `normalizeCause` guards the console leg against this; anything that walks
    // the same hostile input for the pino leg has to guard it too, or the
    // failure that most needs recording is the one that records nothing.
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
    // Deriving the bounded facts must not run inside the try that already
    // wraps the emit: a throw there would swallow the whole line and leave the
    // failure with no record at all, which is strictly worse than the bare
    // line this change exists to improve on.
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
