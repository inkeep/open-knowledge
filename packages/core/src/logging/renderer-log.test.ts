import { describe, expect, test } from 'vitest';
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

  test('strips the fields the log record producer owns', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({
        event: 'ok-outline-nav',
        level: 2,
        time: 1,
        pid: 3,
        hostname: 'h',
        msg: 'hijack',
        name: 'nope',
        runtime: 'nope',
        subsystem: 'nope',
        trace_id: 'nope',
        span_id: 'nope',
        trace_flags: 'nope',
        docName: 'notes/a',
        index: 4,
      }),
    );
    expect(out?.event).toBe('ok-outline-nav');
    expect(out?.fields).toEqual({ event: 'ok-outline-nav', docName: 'notes/a', index: 4 });
  });

  test('masks the JSON wire form of an authorization header, key and value apart', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({ event: 'ok-provider-auth-failed', authorization: 'Bearer s3cret' }),
    );
    expect(out?.event).toBe('ok-provider-auth-failed');
    expect(JSON.stringify(out?.fields)).not.toContain('s3cret');
  });

  test('the event name is masked too, being what both sinks use as the message', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({ event: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' }),
    );
    expect(out?.event).not.toContain('ghp_0123456789');
  });

  test('scrubs strings nested inside objects and arrays, not just top-level ones', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const out = parseStructuredConsoleMessage(
      JSON.stringify({
        event: 'ok-pool-recycle-all',
        nested: { inner: `token ${secret}` },
        list: [`token ${secret}`],
      }),
    );
    expect(JSON.stringify(out?.fields)).not.toContain(secret);
    expect(JSON.stringify(out?.fields)).toContain('[REDACTED-GH-PAT]');
    expect((out?.fields.nested as Record<string, unknown>).inner).toBeTypeOf('string');
    expect(Array.isArray(out?.fields.list)).toBe(true);
  });

  test('scrubs each string leaf, so a credential in a field is masked', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({
        event: 'ok-provider-token-refresh',
        token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
        index: 4,
      }),
    );
    expect(out?.fields.token).not.toContain('ghp_0123456789');
    expect(out?.fields.token).toContain('[REDACTED-GH-PAT]');
    expect(out?.fields.index).toBe(4);
  });

  test('scrubbing per leaf keeps a payload that a whole-line scrub would destroy', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({
        event: 'ok-pool-recycle-all',
        detail: 'authorization: Bearer abc123',
        docName: 'notes/a',
      }),
    );
    expect(out?.event).toBe('ok-pool-recycle-all');
    expect(out?.fields.docName).toBe('notes/a');
    expect(out?.fields.detail).not.toContain('abc123');
  });

  test('the strip does not disturb the provenance markers the capture sites set', () => {
    const out = parseStructuredConsoleMessage(
      JSON.stringify({ source: 's', transport: 't', sourceId: 'i', lineNumber: 1, clientTs: 2 }),
    );
    expect(out?.fields).toEqual({
      source: 's',
      transport: 't',
      sourceId: 'i',
      lineNumber: 1,
      clientTs: 2,
    });
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
    for (const n of [RENDERER_LOG_MAX_MESSAGE_BYTES + 1, RENDERER_LOG_MAX_MESSAGE_BYTES + 20000]) {
      expect(truncateLogMessage('x'.repeat(n)).length).toBeLessThanOrEqual(
        RENDERER_LOG_MAX_MESSAGE_BYTES,
      );
    }
  });
});
