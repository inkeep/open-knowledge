import { describe, expect, test } from 'vitest';
import { classifyLinkPreviewRequest, isLoopbackHttpOrigin } from './request-gate.ts';

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
    [undefined, 'absent Origin'],
    ['null', 'opaque / sandboxed-iframe Origin'],
    ['https://evil.com', 'public origin'],
    ['http://127.0.0.1.evil.com', 'loopback-prefixed rebind lookalike'],
    ['http://localhost.evil.com', 'localhost-prefixed lookalike'],
    ['file:///Users/x/app/index.html', 'file scheme (packaged renderer)'],
    ['ftp://localhost', 'non-http scheme'],
    ['not a url', 'unparseable'],
    ['', 'empty string'],
  ] as const)('rejects %s (%s)', (origin, _why) => {
    expect(isLoopbackHttpOrigin(origin)).toBe(false);
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

  test.each([
    ['application/json; charset=utf-8'],
    ['Application/JSON'],
    ['application/merge-patch+json'],
  ] as const)('admits %s, the same JSON types the body reader accepts', (contentType) => {
    expect(classifyLinkPreviewRequest({ origin: 'http://localhost:5173', contentType })).toEqual({
      ok: true,
    });
  });

  test('origin is judged before content type', () => {
    expect(classifyLinkPreviewRequest({ origin: 'null', contentType: 'text/plain' })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });
});
