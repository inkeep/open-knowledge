import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  buildIngressPolicy,
  getIngressContext,
  hasForwardingHeaders,
  hostHeaderMatchesExternalHost,
  isHostAdmitted,
  isOriginAdmitted,
  isPeerAdmitted,
  normalizeHostHeader,
  stampIngressContext,
  tripsForwardedHeaderTripwire,
} from './ingress-policy.ts';

function runtime(overrides: Partial<ServerRuntimeConfig> = {}): ServerRuntimeConfig {
  return {
    port: undefined,
    bind: ['127.0.0.1'],
    externalUrl: undefined,
    allowExternal: false,
    openBrowser: true,
    idleShutdown: '30m',
    loopbackOnly: true,
    ...overrides,
  };
}

const TUNNEL_EXPOSURE_RUNTIME: Partial<ServerRuntimeConfig> = {
  externalUrl: 'https://myproject.ngrok.app',
  allowExternal: true,
  idleShutdown: 'off',
  openBrowser: false,
};

describe('buildIngressPolicy', () => {
  test('empty input yields the loopback-only default policy', () => {
    const policy = buildIngressPolicy({});
    expect(policy.allowExternal).toBe(false);
    expect(policy.bindLiterals).toEqual([]);
    expect(policy.externalOrigin).toBeUndefined();
    expect(policy.tolerateForwardedHeaders).toBe(false);
  });

  test('non-loopback bind literals are collected; loopback and wildcards are not', () => {
    const policy = buildIngressPolicy({
      serverRuntime: runtime({
        bind: ['127.0.0.1', '100.64.0.7', '0.0.0.0', '::', 'localhost', '[::1]', '2001:DB8::1'],
        loopbackOnly: false,
      }),
    });
    expect(policy.bindLiterals).toEqual(['100.64.0.7', '2001:db8::1']);
  });

  test('externalOrigin comes from a server-sourced externalUrl', () => {
    const explicit = buildIngressPolicy({
      serverRuntime: runtime({
        externalUrl: 'http://laptop.tail:55222',
      }),
    });
    expect(explicit.externalOrigin).toEqual({ host: 'laptop.tail:55222', protocol: 'http:' });
    const none = buildIngressPolicy({ serverRuntime: runtime({}) });
    expect(none.externalOrigin).toBeUndefined();
  });

  test('forwarded headers are tolerated only under consent + declared externalUrl', () => {
    expect(
      buildIngressPolicy({ serverRuntime: runtime(TUNNEL_EXPOSURE_RUNTIME) })
        .tolerateForwardedHeaders,
    ).toBe(true);
    expect(
      buildIngressPolicy({
        serverRuntime: runtime({
          allowExternal: true,
          externalUrl: 'https://kb.example.com',
        }),
      }).tolerateForwardedHeaders,
    ).toBe(true);
    expect(
      buildIngressPolicy({
        serverRuntime: runtime({ allowExternal: true, loopbackOnly: false }),
      }).tolerateForwardedHeaders,
    ).toBe(false);
    expect(
      buildIngressPolicy({
        serverRuntime: runtime({
          externalUrl: 'https://kb.example.com',
        }),
      }).tolerateForwardedHeaders,
    ).toBe(false);
  });
});

describe('isPeerAdmitted — consent relaxes the peer gate ONLY', () => {
  test('loopback always passes; external requires allowExternal', () => {
    const local = buildIngressPolicy({});
    expect(isPeerAdmitted('127.0.0.1', local)).toBe(true);
    expect(isPeerAdmitted('::1', local)).toBe(true);
    expect(isPeerAdmitted('100.64.0.9', local)).toBe(false);
    const consented = buildIngressPolicy({
      serverRuntime: runtime({ allowExternal: true, loopbackOnly: false }),
    });
    expect(isPeerAdmitted('100.64.0.9', consented)).toBe(true);
    expect(isPeerAdmitted('203.0.113.7', consented)).toBe(true);
  });

  test('a vanished socket stays refused even with consent', () => {
    const consented = buildIngressPolicy({
      serverRuntime: runtime({ allowExternal: true, loopbackOnly: false }),
    });
    expect(isPeerAdmitted(undefined, consented)).toBe(false);
  });
});

describe('isHostAdmitted — names validate in every mode, never widened by consent', () => {
  const case2 = buildIngressPolicy({
    serverRuntime: runtime({
      bind: ['127.0.0.1', '100.64.0.7'],
      loopbackOnly: false,
      allowExternal: true,
      externalUrl: 'http://laptop.tail:55222',
    }),
  });

  test('loopback names and bind literals (any port) are admitted', () => {
    expect(isHostAdmitted('localhost:5173', case2)).toBe(true);
    expect(isHostAdmitted('100.64.0.7:55222', case2)).toBe(true);
    expect(isHostAdmitted('100.64.0.7', case2)).toBe(true);
  });

  test('the declared externalUrl host is admitted exactly (host:port)', () => {
    expect(isHostAdmitted('laptop.tail:55222', case2)).toBe(true);
    expect(isHostAdmitted('laptop.tail:9999', case2)).toBe(false);
  });

  test('unconfigured names stay refused even under consent (rebinding defense)', () => {
    expect(isHostAdmitted('evil.example', case2)).toBe(false);
    expect(isHostAdmitted('evil.example:55222', case2)).toBe(false);
    expect(isHostAdmitted(undefined, case2)).toBe(false);
  });

  test('an IPv6 bind literal matches its bracketed Host form', () => {
    const v6 = buildIngressPolicy({
      serverRuntime: runtime({ bind: ['2001:db8::1'], loopbackOnly: false, allowExternal: true }),
    });
    expect(isHostAdmitted('[2001:db8::1]:8080', v6)).toBe(true);
    expect(isHostAdmitted('[2001:db8::2]:8080', v6)).toBe(false);
  });

  test('a malformed bracketed-IPv6 Host is refused (fail-closed parse)', () => {
    const v6 = buildIngressPolicy({
      serverRuntime: runtime({ bind: ['2001:db8::1'], loopbackOnly: false, allowExternal: true }),
    });
    expect(isHostAdmitted('[2001:db8::1', v6)).toBe(false);
    expect(isHostAdmitted('[2001:db8::1:8080', v6)).toBe(false);
  });
});

describe('isOriginAdmitted — if present, must match; scheme-matched for externalUrl', () => {
  const case3 = buildIngressPolicy({
    serverRuntime: runtime({
      allowExternal: true,
      externalUrl: 'https://notes.example.com',
    }),
  });

  test('the declared public origin is admitted; wrong scheme refused', () => {
    expect(isOriginAdmitted('https://notes.example.com', case3)).toBe(true);
    expect(isOriginAdmitted('http://notes.example.com', case3)).toBe(false);
    expect(isOriginAdmitted('https://evil.example.com', case3)).toBe(false);
  });

  test('an http externalUrl admits its http origin (tailnet/LAN posture)', () => {
    const httpPublic = buildIngressPolicy({
      serverRuntime: runtime({
        allowExternal: true,
        externalUrl: 'http://laptop.tail:55222',
      }),
    });
    expect(isOriginAdmitted('http://laptop.tail:55222', httpPublic)).toBe(true);
    expect(isOriginAdmitted('https://laptop.tail:55222', httpPublic)).toBe(false);
  });

  test('bind-literal origins are admitted over http or https', () => {
    const bound = buildIngressPolicy({
      serverRuntime: runtime({
        bind: ['100.64.0.7'],
        loopbackOnly: false,
        allowExternal: true,
      }),
    });
    expect(isOriginAdmitted('http://100.64.0.7:55222', bound)).toBe(true);
    expect(isOriginAdmitted('https://100.64.0.7', bound)).toBe(true);
    expect(isOriginAdmitted('ftp://100.64.0.7', bound)).toBe(false);
  });

  test('loopback and the Electron null/file shapes always pass', () => {
    const local = buildIngressPolicy({});
    expect(isOriginAdmitted('http://localhost:5173', local)).toBe(true);
    expect(isOriginAdmitted('null', local)).toBe(true);
    expect(isOriginAdmitted('file://', local)).toBe(true);
    expect(isOriginAdmitted('https://evil.example.com', local)).toBe(false);
  });

  test('a malformed / unparseable Origin fails closed under consent', () => {
    expect(isOriginAdmitted('http://[not-closed', case3)).toBe(false);
    expect(isOriginAdmitted('://missing-scheme', case3)).toBe(false);
    expect(isOriginAdmitted('not a url', case3)).toBe(false);
    expect(isOriginAdmitted('https://', case3)).toBe(false);
  });
});

describe('tunnel admission via the ratified keys', () => {
  const tunnel = buildIngressPolicy({ serverRuntime: runtime(TUNNEL_EXPOSURE_RUNTIME) });

  test('the tunnel public Host is admitted, with or without default-port suffix', () => {
    expect(isHostAdmitted('myproject.ngrok.app', tunnel)).toBe(true);
    expect(isHostAdmitted('myproject.ngrok.app:443', tunnel)).toBe(true);
    expect(isHostAdmitted('127.0.0.1:24550', tunnel)).toBe(true);
    expect(isHostAdmitted('evil.example.com', tunnel)).toBe(false);
    expect(isHostAdmitted(undefined, tunnel)).toBe(false);
  });

  test('the https tunnel origin is admitted; http and foreign origins are not', () => {
    expect(isOriginAdmitted('https://myproject.ngrok.app', tunnel)).toBe(true);
    expect(isOriginAdmitted('http://myproject.ngrok.app', tunnel)).toBe(false);
    expect(isOriginAdmitted('https://evil.example.com', tunnel)).toBe(false);
  });

  test('forwarding headers (tunnels always inject them) do not trip the wire', () => {
    expect(
      tripsForwardedHeaderTripwire({ headers: { 'x-forwarded-for': '203.0.113.7' } }, tunnel),
    ).toBe(false);
  });
});

describe('normalizeHostHeader / hostHeaderMatchesExternalHost', () => {
  test('matches the public host, with or without default-port suffix, case-insensitively', () => {
    expect(normalizeHostHeader('MyProject.NGROK.app:443')).toBe('myproject.ngrok.app');
    expect(normalizeHostHeader('host.example:8080')).toBe('host.example:8080');
    expect(hostHeaderMatchesExternalHost('myproject.ngrok.app', 'myproject.ngrok.app')).toBe(true);
    expect(hostHeaderMatchesExternalHost('myproject.ngrok.app:443', 'myproject.ngrok.app')).toBe(
      true,
    );
    expect(hostHeaderMatchesExternalHost('MyProject.NGROK.app', 'myproject.ngrok.app')).toBe(true);
  });

  test('refuses other hosts and missing Host', () => {
    expect(hostHeaderMatchesExternalHost('evil.example.com', 'myproject.ngrok.app')).toBe(false);
    expect(hostHeaderMatchesExternalHost(undefined, 'myproject.ngrok.app')).toBe(false);
  });
});

describe('hasForwardingHeaders', () => {
  test('detects standard forwarding headers; plain local requests carry none', () => {
    expect(hasForwardingHeaders({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(true);
    expect(hasForwardingHeaders({ headers: { forwarded: 'for=203.0.113.7' } })).toBe(true);
    expect(hasForwardingHeaders({ headers: { host: 'localhost:24550' } })).toBe(false);
  });
});

describe('tripsForwardedHeaderTripwire', () => {
  test('fires on forwarding headers unless the policy tolerates them', () => {
    const local = buildIngressPolicy({});
    const req = { headers: { 'x-forwarded-for': '203.0.113.7' } };
    expect(tripsForwardedHeaderTripwire(req, local)).toBe(true);
    const consented = buildIngressPolicy({
      serverRuntime: runtime({
        allowExternal: true,
        externalUrl: 'https://notes.example.com',
      }),
    });
    expect(tripsForwardedHeaderTripwire(req, consented)).toBe(false);
    expect(tripsForwardedHeaderTripwire({ headers: {} }, local)).toBe(false);
  });

  test.each([
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'forwarded',
    'x-real-ip',
    'x-client-ip',
    'x-cluster-client-ip',
    'cf-connecting-ip',
    'fastly-client-ip',
    'true-client-ip',
  ])('fires on the %s forwarding header (non-consented)', (header) => {
    const local = buildIngressPolicy({});
    expect(tripsForwardedHeaderTripwire({ headers: { [header]: 'v' } }, local)).toBe(true);
  });
});

describe('ingress request context', () => {
  test('stamps peer class and the empty actor slot, retrievable by request', () => {
    const req = {
      socket: { remoteAddress: '100.64.0.9' },
      headers: {},
    } as unknown as import('node:http').IncomingMessage;
    const context = stampIngressContext(req, { requestId: 'r-1' });
    expect(context).toEqual({ requestId: 'r-1', peerClass: 'external', actor: undefined });
    expect(getIngressContext(req)).toBe(context);
  });
});
