import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { admitRequestSurface } from './http-app.ts';

function req(
  host: string | undefined,
  remoteAddress = '127.0.0.1',
  extraHeaders: Record<string, string> = {},
): IncomingMessage {
  return {
    headers: { ...(host === undefined ? {} : { host }), ...extraHeaders },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; status: () => number | undefined } {
  let status: number | undefined;
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status };
}

const consentPolicy = buildIngressPolicy({
  serverRuntime: {
    port: undefined,
    bind: ['127.0.0.1', '100.64.0.7'],
    externalUrl: 'http://laptop.tail:55222',
    allowExternal: true,
    openBrowser: false,
    idleShutdown: 'off',
    loopbackOnly: false,
  } satisfies ServerRuntimeConfig,
});

describe('admitRequestSurface under allowExternal consent', () => {
  test('admits loopback, the bind literal, and the declared externalUrl host', () => {
    for (const host of ['localhost:5173', '100.64.0.7:55222', 'laptop.tail:55222']) {
      const { res, status } = fakeRes();
      expect(admitRequestSurface(req(host), res, consentPolicy, 'mcp-mount')).toBe(true);
      expect(status()).toBeUndefined();
    }
  });

  test('refuses a foreign Host (rebinding shape) with a 403', () => {
    const { res, status } = fakeRes();
    expect(admitRequestSurface(req('evil.example'), res, consentPolicy, 'mcp-mount')).toBe(false);
    expect(status()).toBe(403);
  });

  test('Gate 1: refuses forwarding headers the policy does not tolerate, before Gate 2 (403)', () => {
    const { res, status } = fakeRes();
    expect(
      admitRequestSurface(
        req('localhost', '127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }),
        res,
        buildIngressPolicy({}),
        'mcp-mount',
      ),
    ).toBe(false);
    expect(status()).toBe(403);
  });

  test('Gate 1: a consented policy with a externalUrl tolerates forwarding headers', () => {
    const { res, status } = fakeRes();
    expect(
      admitRequestSurface(
        req('laptop.tail:55222', '100.64.0.7', { 'x-forwarded-for': '203.0.113.7' }),
        res,
        consentPolicy,
        'mcp-mount',
      ),
    ).toBe(true);
    expect(status()).toBeUndefined();
  });

  test('a pure-local policy (no exposure) does NOT Host-gate the surface here', () => {
    const local = buildIngressPolicy({});
    const { res, status } = fakeRes();
    expect(admitRequestSurface(req('evil.example'), res, local, 'mcp-mount')).toBe(true);
    expect(status()).toBeUndefined();
  });
});
