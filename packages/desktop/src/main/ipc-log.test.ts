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
