import { RENDERER_LOG_MAX_MESSAGE_BYTES } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emitDiagnosticBreadcrumb, MAX_BREADCRUMB_CHARS } from './diagnostic-breadcrumb';

function captureInfo() {
  return vi.spyOn(console, 'info').mockImplementation(() => undefined);
}

function soleParsedCall(spy: ReturnType<typeof captureInfo>): Record<string, unknown> {
  expect(spy.mock.calls).toHaveLength(1);
  const [first, ...rest] = spy.mock.calls[0];
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
    const spy = captureInfo();
    emitDiagnosticBreadcrumb('ok-test-event', {
      level: 2,
      time: 1,
      pid: 2,
      hostname: 'h',
      msg: 'no',
      name: 'nope',
      runtime: 'nope',
      subsystem: 'nope',
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
    expect(MAX_BREADCRUMB_CHARS).toBeLessThanOrEqual(RENDERER_LOG_MAX_MESSAGE_BYTES / 2);
  });

  test('a payload sized exactly to the cap keeps every field', () => {
    const spy = captureInfo();
    const room =
      MAX_BREADCRUMB_CHARS -
      JSON.stringify({ event: 'ok-test-event', docName: '', index: 4 }).length;
    emitDiagnosticBreadcrumb('ok-test-event', { docName: 'x'.repeat(room), index: 4 });
    const parsed = soleParsedCall(spy);
    expect(parsed.index).toBe(4);
    expect(parsed.oversized).toBeUndefined();
  });
});
