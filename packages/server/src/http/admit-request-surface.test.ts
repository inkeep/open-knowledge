import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { admitRequestSurface } from './http-app.ts';

// admitRequestSurface is the surface-wide admission prelude the mount runs
// BEFORE dispatch for EVERY request — /mcp, /api, the static SPA shell, and
// project content assets. These pin the #6 fix: under `allowExternal` consent
// (no legacy --remote), it validates Host with the consolidated predicate
// (loopback + bind literals + publicUrl), so a rebound / foreign Host cannot
// read the static shell or content while the peer is admitted.

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
    publicUrl: 'http://laptop.tail:55222',
    publicUrlSource: 'server',
    allowExternal: true,
    openBrowser: false,
    idleShutdown: 'off',
    loopbackOnly: false,
  } satisfies ServerRuntimeConfig,
});

describe('admitRequestSurface under allowExternal consent', () => {
  test('admits loopback, the bind literal, and the declared publicUrl host', () => {
    for (const host of ['localhost:5173', '100.64.0.7:55222', 'laptop.tail:55222']) {
      const { res, status } = fakeRes();
      expect(admitRequestSurface(req(host), res, consentPolicy, 'test')).toBe(true);
      expect(status()).toBeUndefined();
    }
  });

  test('refuses a foreign Host (rebinding shape) with a 403', () => {
    const { res, status } = fakeRes();
    expect(admitRequestSurface(req('evil.example'), res, consentPolicy, 'test')).toBe(false);
    expect(status()).toBe(403);
  });

  test('Gate 1: refuses forwarding headers the policy does not tolerate, before Gate 2 (403)', () => {
    // The tripwire runs ahead of the Host gate. A pure-local server that never
    // opted into exposure but receives X-Forwarded-* is fronted by an
    // unexpected proxy/tunnel — refuse rather than serve it with full local
    // trust. This pins the composed prelude to the predicate, not just Gate 2.
    const { res, status } = fakeRes();
    expect(
      admitRequestSurface(
        req('localhost', '127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }),
        res,
        buildIngressPolicy({}),
        'test',
      ),
    ).toBe(false);
    expect(status()).toBe(403);
  });

  test('Gate 1: a consented policy with a publicUrl tolerates forwarding headers', () => {
    // Under consent with a declared publicUrl the server sits behind a reverse
    // proxy / tunnel on purpose, so forwarded headers are expected and
    // tolerated; the Host still gates in Gate 2 (admitted here via publicUrl).
    const { res, status } = fakeRes();
    expect(
      admitRequestSurface(
        req('laptop.tail:55222', '100.64.0.7', { 'x-forwarded-for': '203.0.113.7' }),
        res,
        consentPolicy,
        'test',
      ),
    ).toBe(true);
    expect(status()).toBeUndefined();
  });

  test('a pure-local policy (no exposure) does NOT Host-gate the surface here', () => {
    // Gate 2 only runs under exposure; pure-local keeps its historical
    // origin-only read posture (the general read-posture flip is a separate PR).
    const local = buildIngressPolicy({});
    const { res, status } = fakeRes();
    expect(admitRequestSurface(req('evil.example'), res, local, 'test')).toBe(true);
    expect(status()).toBeUndefined();
  });
});
