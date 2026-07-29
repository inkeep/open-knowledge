import { describe, expect, test } from 'vitest';
import { ConfigSchema } from './config/schema.ts';
import {
  hasForwardingHeaders,
  hostHeaderMatchesPublicHost,
  isRemoteAdmitted,
  originMatchesPublicHost,
  RemoteConfigError,
  type ResolvedRemoteAccess,
  resolveRemoteAccess,
} from './remote-access.ts';

function resolved(url: string): ResolvedRemoteAccess {
  const remote = resolveRemoteAccess(ConfigSchema.parse({ remote: { url } }));
  if (remote === null) throw new Error('expected resolved remote access');
  return remote;
}

interface FakeReq {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

function req(host: string | undefined, remoteAddress = '127.0.0.1'): FakeReq {
  return { headers: host === undefined ? {} : { host }, socket: { remoteAddress } };
}

describe('resolveRemoteAccess', () => {
  test('no url resolves to null — the caller decides whether that is fatal', () => {
    expect(resolveRemoteAccess(ConfigSchema.parse({}))).toBeNull();
    expect(resolveRemoteAccess(undefined)).toBeNull();
  });

  test('a non-URL url throws RemoteConfigError', () => {
    expect(() => resolveRemoteAccess(ConfigSchema.parse({ remote: { url: 'not a url' } }))).toThrow(
      RemoteConfigError,
    );
  });

  test('https url resolves with the default port', () => {
    const remote = resolved('https://myproject.ngrok.app');
    expect(remote.url).toBe('https://myproject.ngrok.app');
    expect(remote.publicHost).toBe('myproject.ngrok.app');
    expect(remote.port).toBe(24550);
  });

  test('plain-http url throws — the public tunnel URL is always https', () => {
    expect(() =>
      resolveRemoteAccess(ConfigSchema.parse({ remote: { url: 'http://myproject.ngrok.app' } })),
    ).toThrow(RemoteConfigError);
  });

  test('normalizes trailing slash and default-port host', () => {
    const remote = resolved('https://myproject.ngrok.app:443/');
    expect(remote.url).toBe('https://myproject.ngrok.app:443');
    expect(remote.publicHost).toBe('myproject.ngrok.app');
  });
});

describe('isRemoteAdmitted', () => {
  const remote = resolved('https://myproject.ngrok.app');

  test('loopback socket + loopback Host → admitted (local clients unchanged)', () => {
    expect(isRemoteAdmitted(req('127.0.0.1:24550'), remote)).toBe(true);
    expect(isRemoteAdmitted(req('localhost:24550'), remote)).toBe(true);
  });

  test('loopback socket + the tunnel public Host → admitted', () => {
    expect(isRemoteAdmitted(req('myproject.ngrok.app'), remote)).toBe(true);
  });

  test('default-port suffix on the public Host still matches', () => {
    expect(isRemoteAdmitted(req('myproject.ngrok.app:443'), remote)).toBe(true);
  });

  test('wrong Host → refused (DNS-rebinding shape)', () => {
    expect(isRemoteAdmitted(req('evil.example.com'), remote)).toBe(false);
  });

  test('missing Host → refused', () => {
    expect(isRemoteAdmitted(req(undefined), remote)).toBe(false);
  });

  test('non-loopback socket → refused even with the right Host (LAN peer)', () => {
    expect(isRemoteAdmitted(req('myproject.ngrok.app', '192.168.1.50'), remote)).toBe(false);
    expect(isRemoteAdmitted(req('127.0.0.1:24550', '192.168.1.50'), remote)).toBe(false);
  });
});

describe('hasForwardingHeaders', () => {
  test('detects each standard forwarding header', () => {
    expect(hasForwardingHeaders({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(true);
    expect(hasForwardingHeaders({ headers: { 'x-forwarded-proto': 'https' } })).toBe(true);
    expect(hasForwardingHeaders({ headers: { forwarded: 'for=203.0.113.7' } })).toBe(true);
  });

  test('plain local requests carry none', () => {
    expect(hasForwardingHeaders({ headers: { host: 'localhost:24550' } })).toBe(false);
  });
});

describe('originMatchesPublicHost', () => {
  test('https origin on the public host matches, with or without :443', () => {
    expect(originMatchesPublicHost('https://myproject.ngrok.app', 'myproject.ngrok.app')).toBe(
      true,
    );
    expect(originMatchesPublicHost('https://myproject.ngrok.app:443', 'myproject.ngrok.app')).toBe(
      true,
    );
  });

  test('http scheme, other hosts, and garbage never match', () => {
    expect(originMatchesPublicHost('http://myproject.ngrok.app', 'myproject.ngrok.app')).toBe(
      false,
    );
    expect(originMatchesPublicHost('https://evil.example.com', 'myproject.ngrok.app')).toBe(false);
    expect(originMatchesPublicHost('not-an-origin', 'myproject.ngrok.app')).toBe(false);
  });
});

describe('hostHeaderMatchesPublicHost', () => {
  test('matches the public host, with or without default-port suffix', () => {
    expect(hostHeaderMatchesPublicHost('myproject.ngrok.app', 'myproject.ngrok.app')).toBe(true);
    expect(hostHeaderMatchesPublicHost('myproject.ngrok.app:443', 'myproject.ngrok.app')).toBe(
      true,
    );
    expect(hostHeaderMatchesPublicHost('MyProject.NGROK.app', 'myproject.ngrok.app')).toBe(true);
  });

  test('refuses other hosts and missing Host', () => {
    expect(hostHeaderMatchesPublicHost('evil.example.com', 'myproject.ngrok.app')).toBe(false);
    expect(hostHeaderMatchesPublicHost(undefined, 'myproject.ngrok.app')).toBe(false);
  });
});
