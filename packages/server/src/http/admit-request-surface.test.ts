import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  __resetWarnedForwardedHeaderRefusalForTests,
  buildIngressPolicy,
  warnForwardedHeaderRefusalOnce,
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import { admitRequestSurface } from './http-app.ts';

beforeEach(() => {
  __resetWarnedForwardedHeaderRefusalForTests();
});

function capturingLog(): { log: PinoLogger; warns: string[] } {
  const warns: string[] = [];
  const log = {
    warn: (_fields: unknown, message?: string) => {
      if (typeof message === 'string') warns.push(message);
    },
  } as unknown as PinoLogger;
  return { log, warns };
}

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

  test('a Host refusal does not emit the forwarded-header diagnostic', () => {
    const { log, warns } = capturingLog();
    const { res } = fakeRes();
    expect(admitRequestSurface(req('evil.example'), res, consentPolicy, 'mcp-mount', log)).toBe(
      false,
    );
    expect(warns).toEqual([]);
  });

  test('a tolerated forwarded request emits no diagnostic', () => {
    const { log, warns } = capturingLog();
    const { res } = fakeRes();
    expect(
      admitRequestSurface(
        req('laptop.tail:55222', '100.64.0.7', { 'x-forwarded-for': '203.0.113.7' }),
        res,
        consentPolicy,
        'mcp-mount',
        log,
      ),
    ).toBe(true);
    expect(warns).toEqual([]);
  });

  test('the latch is shared across callers — a WS-site warn suppresses the HTTP-site one', () => {
    const { log, warns } = capturingLog();
    const local = buildIngressPolicy({});
    warnForwardedHeaderRefusalOnce(log, 'ws-upgrade');
    expect(warns.length).toBe(1);
    expect(
      admitRequestSurface(
        req('localhost', '127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }),
        fakeRes().res,
        local,
        'mcp-mount',
        log,
      ),
    ).toBe(false);
    expect(warns.length).toBe(1);
  });

  test('the first forwarded-header refusal warns ONCE with the two-knob remedy; repeats stay quiet', () => {
    const { log, warns } = capturingLog();
    const local = buildIngressPolicy({});
    const forwarded = () => req('localhost', '127.0.0.1', { 'x-forwarded-for': '203.0.113.7' });
    expect(admitRequestSurface(forwarded(), fakeRes().res, local, 'mcp-mount', log)).toBe(false);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('server.externalUrl');
    expect(warns[0]).toContain('server.allowExternal');
    expect(warns[0]).toContain('.ok/local/config.yml');
    expect(warns[0]).toContain('ok.api.error.count');
    expect(admitRequestSurface(forwarded(), fakeRes().res, local, 'mcp-mount', log)).toBe(false);
    expect(warns.length).toBe(1);
  });
});
