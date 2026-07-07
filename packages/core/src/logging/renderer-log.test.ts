import { describe, expect, test } from 'bun:test';
import {
  mapConsoleLevel,
  parseStructuredConsoleMessage,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
  truncateLogMessage,
} from './renderer-log.ts';

describe('mapConsoleLevel', () => {
  test('maps error/warning/warn/info/log to renderer levels', () => {
    expect(mapConsoleLevel('error')).toBe('error');
    expect(mapConsoleLevel('warning')).toBe('warn');
    expect(mapConsoleLevel('warn')).toBe('warn');
    expect(mapConsoleLevel('info')).toBe('info');
    expect(mapConsoleLevel('log')).toBe('info');
  });

  test('drops debug/verbose/unknown (returns null)', () => {
    expect(mapConsoleLevel('debug')).toBeNull();
    expect(mapConsoleLevel('verbose')).toBeNull();
    expect(mapConsoleLevel('trace')).toBeNull();
    expect(mapConsoleLevel('')).toBeNull();
    expect(mapConsoleLevel('INFO')).toBeNull();
  });
});

describe('parseStructuredConsoleMessage', () => {
  test('lifts a JSON object message into event + fields', () => {
    const msg = JSON.stringify({
      event: 'ok-provider-server-driven-close-reauth',
      docName: 'notes',
      reason: 'Failed to connect',
    });
    const out = parseStructuredConsoleMessage(msg);
    expect(out).not.toBeNull();
    expect(out?.event).toBe('ok-provider-server-driven-close-reauth');
    expect(out?.fields.reason).toBe('Failed to connect');
    expect(out?.fields.docName).toBe('notes');
  });

  test('event is undefined when the object has no string `event`', () => {
    const out = parseStructuredConsoleMessage(JSON.stringify({ docName: 'x' }));
    expect(out).not.toBeNull();
    expect(out?.event).toBeUndefined();
    expect(out?.fields.docName).toBe('x');
  });

  test('returns null for non-JSON, arrays, primitives, and empty', () => {
    expect(parseStructuredConsoleMessage('plain log line')).toBeNull();
    expect(parseStructuredConsoleMessage('[1,2,3]')).toBeNull();
    expect(parseStructuredConsoleMessage('42')).toBeNull();
    expect(parseStructuredConsoleMessage('')).toBeNull();
    expect(parseStructuredConsoleMessage('{not json')).toBeNull();
  });
});

describe('truncateLogMessage', () => {
  test('passes short messages through unchanged', () => {
    expect(truncateLogMessage('short')).toBe('short');
  });

  test('truncates messages over the cap and marks the cut', () => {
    const long = 'a'.repeat(RENDERER_LOG_MAX_MESSAGE_BYTES + 50);
    const out = truncateLogMessage(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  test('truncated output stays within the cap (suffix reserved) so the server schema accepts it', () => {
    // The server Zod schema enforces max(RENDERER_LOG_MAX_MESSAGE_BYTES); an
    // over-long result would reject the whole batch. Cover the suffix-overflow
    // regression directly.
    for (const n of [RENDERER_LOG_MAX_MESSAGE_BYTES + 1, RENDERER_LOG_MAX_MESSAGE_BYTES + 20000]) {
      expect(truncateLogMessage('x'.repeat(n)).length).toBeLessThanOrEqual(
        RENDERER_LOG_MAX_MESSAGE_BYTES,
      );
    }
  });
});
