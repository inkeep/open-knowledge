import { describe, expect, test } from 'bun:test';
import {
  classifyLinkPreviewRequest,
  isJsonContentType,
  isLoopbackHttpOrigin,
} from './request-gate.ts';

describe('isLoopbackHttpOrigin', () => {
  test.each([
    ['http://localhost', true],
    ['http://localhost:5173', true],
    ['https://localhost', true],
    ['http://127.0.0.1', true],
    ['http://127.0.0.1:8080', true],
    ['http://127.13.99.4', true],
    ['http://[::1]', true],
    ['http://[::1]:5173', true],
  ] as const)('admits loopback http(s) origin %s', (origin, expected) => {
    expect(isLoopbackHttpOrigin(origin)).toBe(expected);
  });

  test.each([
    // The two the shared gate would wave through — the whole point of this gate.
    [undefined, 'absent Origin'],
    ['null', 'opaque / sandboxed-iframe Origin'],
    // Non-loopback and lookalike authorities.
    ['https://evil.com', 'public origin'],
    ['http://127.0.0.1.evil.com', 'loopback-prefixed rebind lookalike'],
    ['http://localhost.evil.com', 'localhost-prefixed lookalike'],
    // Wrong scheme / unparseable.
    ['file:///Users/x/app/index.html', 'file scheme (packaged renderer)'],
    ['ftp://localhost', 'non-http scheme'],
    ['not a url', 'unparseable'],
    ['', 'empty string'],
  ] as const)('rejects %s (%s)', (origin, _why) => {
    expect(isLoopbackHttpOrigin(origin)).toBe(false);
  });
});

describe('isJsonContentType', () => {
  test.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    ['  application/json  ', true],
  ] as const)('admits JSON content type %s', (ct, expected) => {
    expect(isJsonContentType(ct)).toBe(expected);
  });

  test.each([
    [undefined, 'missing'],
    ['', 'empty'],
    ['text/plain', 'simple-request text'],
    ['text/plain;charset=UTF-8', 'simple-request text with charset'],
    ['multipart/form-data; boundary=x', 'simple-request multipart'],
    ['application/x-www-form-urlencoded', 'simple-request form'],
    ['application/json-patch+json', 'json-adjacent but not json'],
  ] as const)('rejects %s content type (%s)', (ct, _why) => {
    expect(isJsonContentType(ct)).toBe(false);
  });
});

describe('classifyLinkPreviewRequest', () => {
  test('admits a loopback-origin JSON POST', () => {
    expect(
      classifyLinkPreviewRequest({
        origin: 'http://127.0.0.1:5173',
        contentType: 'application/json',
      }),
    ).toEqual({ ok: true });
  });

  test.each([
    [undefined, 'absent Origin'],
    ['null', 'null Origin (sandboxed iframe)'],
    ['https://evil.com', 'cross-origin'],
  ] as const)('refuses %s for reason=origin (%s)', (origin, _why) => {
    expect(classifyLinkPreviewRequest({ origin, contentType: 'application/json' })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });

  test.each([
    [undefined, 'missing content type'],
    ['text/plain', 'text/plain bypass'],
    ['multipart/form-data', 'multipart bypass'],
  ] as const)('refuses %s for reason=content-type (%s)', (contentType, _why) => {
    expect(classifyLinkPreviewRequest({ origin: 'http://localhost:5173', contentType })).toEqual({
      ok: false,
      reason: 'content-type',
    });
  });

  test('origin is judged before content type', () => {
    // A null origin with a non-JSON body is refused for the origin, the more
    // informative reason — not masked by the content-type check.
    expect(classifyLinkPreviewRequest({ origin: 'null', contentType: 'text/plain' })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });
});
