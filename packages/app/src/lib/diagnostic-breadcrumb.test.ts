import { RENDERER_LOG_MAX_MESSAGE_BYTES } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emitDiagnosticBreadcrumb, MAX_BREADCRUMB_CHARS } from './diagnostic-breadcrumb';

function captureInfo() {
  return vi.spyOn(console, 'info').mockImplementation(() => undefined);
}

function soleParsedCall(spy: ReturnType<typeof captureInfo>): Record<string, unknown> {
  expect(spy.mock.calls).toHaveLength(1);
  const [first, ...rest] = spy.mock.calls[0];
  // The capture sites only parse a message whose FIRST argument is a lone JSON
  // object; a second argument would be joined into the message text on the web
  // transport and dropped entirely on the Electron one.
  expect(rest).toEqual([]);
  expect(typeof first).toBe('string');
  return JSON.parse(first as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('emitDiagnosticBreadcrumb', () => {
  test('emits one console.info carrying a single JSON object argument', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', { docName: 'notes/a', index: 3, claimed: true });
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      docName: 'notes/a',
      index: 3,
      claimed: true,
    });
  });

  test('emits at info, the only level both capture transports keep', () => {
    // `mapConsoleLevel` maps 'debug' to null and the web forwarder never patches
    // `console.debug`, so a debug breadcrumb reaches no log file on either
    // distribution. warn/error survive but misreport routine diagnostics.
    const info = captureInfo();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    emitDiagnosticBreadcrumb('ok-test-event');
    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('omits undefined fields rather than serializing them', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', { present: 0, absent: undefined });
    const parsed = soleParsedCall(spy);
    expect(parsed).toEqual({ event: 'ok-test-event', present: 0 });
    expect('absent' in parsed).toBe(false);
  });

  test('keeps a false or zero field, which an undefined check must not swallow', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', { claimed: false, scrollTop: 0, found: -1 });
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      claimed: false,
      scrollTop: 0,
      found: -1,
    });
  });

  test('a payload cannot rename its own event and hide from a grep', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-real-event', { event: 'ok-impostor', docName: 'notes/a' });
    expect(soleParsedCall(spy)).toEqual({ event: 'ok-real-event', docName: 'notes/a' });
  });

  test('drops a nested field and counts it rather than shipping unredactable depth', () => {
    // Pino's keyed redact reaches one level, so a nested object cannot be
    // masked; a cyclic one would additionally throw on serialize.
    const spy = captureInfo();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      emitDiagnosticBreadcrumb('ok-test-event', { cyclic, nested: { a: 1 }, index: 2 }),
    ).not.toThrow();
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      index: 2,
      droppedNonScalarFields: 2,
    });
  });

  test('a field named after a pino key is dropped, not left to corrupt the record', () => {
    // pino appends these fields to its own without deduping, so a collision
    // reaches the file as a repeated key that whichever parser reads it next
    // has to arbitrate. Enforced at the boundary because `mark()` forwards the
    // props of marks that do not exist yet.
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', {
      level: 2,
      time: 1,
      pid: 2,
      hostname: 'h',
      msg: 'no',
      // Base bindings and the desktop logger's own key. `subsystem` is the
      // worst of them: that logger merges as `{ subsystem, ...data }`, so a
      // field of this name wins in plain JS before pino runs and silently
      // re-files the record under another subsystem.
      name: 'nope',
      runtime: 'nope',
      subsystem: 'nope',
      // The server logger's OTel mixin keys, which pino resolves in the merge
      // object's favour — so one of these would re-file the line against a
      // trace that does not contain it.
      trace_id: 'nope',
      span_id: 'nope',
      trace_flags: 'nope',
      headingLevel: 2,
    });
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      headingLevel: 2,
      droppedReservedFields: 11,
    });
  });

  test('a BigInt costs one field, not the whole line', () => {
    // `JSON.stringify` throws on a BigInt, and a denylist keyed on `typeof
    // 'object'` would let it through to the outer catch — which discards the
    // breadcrumb, event name included. `mark()` forwards props verbatim from
    // marks that do not exist yet, so the value type cannot be assumed.
    const spy = captureInfo();
    expect(() => emitDiagnosticBreadcrumb('ok-test-event', { big: 10n, index: 3 })).not.toThrow();
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      index: 3,
      droppedNonScalarFields: 1,
    });
  });

  test('a symbol or function is dropped the same way', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', {
      sym: Symbol('x'),
      fn: () => undefined,
      index: 1,
    });
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      index: 1,
      droppedNonScalarFields: 2,
    });
  });

  test('a dropped field is counted, so the gap is visible rather than silent', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', { level: 2, nested: { a: 1 }, index: 7 });
    expect(soleParsedCall(spy)).toEqual({
      event: 'ok-test-event',
      index: 7,
      droppedNonScalarFields: 1,
      droppedReservedFields: 1,
    });
  });

  test('null survives — it is a value, not a missing field', () => {
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', { resolved: null });
    expect(soleParsedCall(spy)).toEqual({ event: 'ok-test-event', resolved: null });
  });

  test('an oversized payload degrades to a parseable line instead of an unparseable one', () => {
    // The Electron capture site truncates BEFORE parsing and the parse is
    // all-or-nothing, so a line over the transport cap arrives there with no
    // event name and no fields at all. Degrade deliberately instead, which also
    // makes the two transports agree on what an oversized payload looks like.
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', {
      docName: 'x'.repeat(MAX_BREADCRUMB_CHARS),
      index: 4,
    });
    const parsed = soleParsedCall(spy);
    expect(parsed).toEqual({ event: 'ok-test-event', oversized: true, fieldCount: 2 });
    expect(JSON.stringify(parsed).length).toBeLessThan(MAX_BREADCRUMB_CHARS);
  });

  test('the cap keeps the documented headroom under the 8192 transport limit', () => {
    // Pinned against the transport's own constant rather than left to drift:
    // the headroom is what absorbs UTF-16-length-versus-UTF-8-bytes on a
    // multibyte payload, and raising the cap to the transport limit would
    // spend it silently.
    expect(MAX_BREADCRUMB_CHARS).toBeLessThanOrEqual(RENDERER_LOG_MAX_MESSAGE_BYTES / 2);
  });

  test('a payload sized exactly to the cap keeps every field', () => {
    const spy = captureInfo();
    // Exactly at the cap, which the comparison admits — the boundary is where a
    // one-off in either direction shows up, and any lower cap degrades this and
    // fails the assertion.
    const room =
      MAX_BREADCRUMB_CHARS -
      JSON.stringify({ event: 'ok-test-event', docName: '', index: 4 }).length;
    emitDiagnosticBreadcrumb('ok-test-event', { docName: 'x'.repeat(room), index: 4 });
    const parsed = soleParsedCall(spy);
    expect(parsed.index).toBe(4);
    expect(parsed.oversized).toBeUndefined();
  });
});
