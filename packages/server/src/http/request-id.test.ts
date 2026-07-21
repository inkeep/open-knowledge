import type { IncomingMessage } from 'node:http';
import { describe, expect, test } from 'vitest';
import {
  getRequestId,
  REQUEST_ID_HEADER,
  rememberRequestId,
  resolveRequestId,
} from './request-id.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeReq(headerValue?: string | string[]): IncomingMessage {
  return {
    headers: headerValue === undefined ? {} : { [REQUEST_ID_HEADER]: headerValue },
  } as IncomingMessage;
}

describe('resolveRequestId', () => {
  test('mints a UUID when no header is present', () => {
    expect(resolveRequestId(makeReq())).toMatch(UUID_RE);
  });

  test('honors a well-formed incoming id', () => {
    expect(resolveRequestId(makeReq('mcp-shim.0042_a'))).toBe('mcp-shim.0042_a');
  });

  test('takes the first value of a multi-valued header', () => {
    expect(resolveRequestId(makeReq(['first-id', 'second-id']))).toBe('first-id');
  });

  test('replaces out-of-charset ids with a minted UUID', () => {
    for (const hostile of ['has space', 'crlf\r\ninject', 'ünïcode', 'semi;colon', '']) {
      const resolved = resolveRequestId(makeReq(hostile));
      expect(resolved).not.toBe(hostile);
      expect(resolved).toMatch(UUID_RE);
    }
  });

  test('replaces over-length ids with a minted UUID', () => {
    const long = 'a'.repeat(129);
    expect(resolveRequestId(makeReq(long))).toMatch(UUID_RE);
    expect(resolveRequestId(makeReq('a'.repeat(128)))).toBe('a'.repeat(128));
  });
});

describe('remember/getRequestId', () => {
  test('round-trips per request object', () => {
    const a = makeReq();
    const b = makeReq();
    rememberRequestId(a, 'id-a');
    expect(getRequestId(a)).toBe('id-a');
    expect(getRequestId(b)).toBeUndefined();
  });
});
