import { describe, expect, test } from 'vitest';
import {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  CLIENT_SURFACE_ATTRIBUTE,
  CLIENT_VERSION_HEADER,
  type ClientSurface,
  clientVersionHeaders,
  clientVersionTokenFields,
  deriveClientSurface,
  readClientSurface,
} from './client-version.ts';
import { type EmbeddedHost, UA_PATTERNS } from './constants/embedded-host.ts';
import { PROTOCOL_VERSION } from './protocol-version.ts';

const EMBEDDED_HOSTS = [
  'cursor',
  'codex',
  'claude-desktop',
] as const satisfies readonly NonNullable<EmbeddedHost>[];

const EVERY_SURFACE: readonly ClientSurface[] = [
  deriveClientSurface({ hasDesktopBridge: true, embeddedHost: null }),
  deriveClientSurface({ hasDesktopBridge: false, embeddedHost: null }),
  ...EMBEDDED_HOSTS.map((embeddedHost) =>
    deriveClientSurface({ hasDesktopBridge: false, embeddedHost }),
  ),
];

describe('client surface derivation', () => {
  test('covers every embedded host the user-agent detector knows', () => {
    expect([...EMBEDDED_HOSTS].sort()).toEqual(Object.keys(UA_PATTERNS).sort());
  });

  test('the desktop bridge marks the OK Desktop window, whatever the user agent says', () => {
    expect(deriveClientSurface({ hasDesktopBridge: true, embeddedHost: null })).toBe('desktop');
    for (const host of EMBEDDED_HOSTS) {
      expect(deriveClientSurface({ hasDesktopBridge: true, embeddedHost: host })).toBe('desktop');
    }
  });

  test('an embedded agent pane is labelled with its host', () => {
    expect(deriveClientSurface({ hasDesktopBridge: false, embeddedHost: 'cursor' })).toBe(
      'embedded:cursor',
    );
    expect(deriveClientSurface({ hasDesktopBridge: false, embeddedHost: 'codex' })).toBe(
      'embedded:codex',
    );
    expect(deriveClientSurface({ hasDesktopBridge: false, embeddedHost: 'claude-desktop' })).toBe(
      'embedded:claude-desktop',
    );
  });

  test('a plain browser tab is the browser surface', () => {
    expect(deriveClientSurface({ hasDesktopBridge: false, embeddedHost: null })).toBe('browser');
  });

  test('the shared attribute key is ok.client.surface', () => {
    expect(CLIENT_SURFACE_ATTRIBUTE).toBe('ok.client.surface');
  });
});

describe('server-side client surface reader', () => {
  test('every surface a current client sends on the kind header reads back unchanged', () => {
    for (const surface of EVERY_SURFACE) {
      const headers = clientVersionHeaders({ kind: surface, runtimeVersion: '0.85.0' });
      expect(readClientSurface(headers[CLIENT_VERSION_HEADER.kind])).toBe(surface);
    }
  });

  test("an older client's kind=web still parses, as an unknown surface", () => {
    expect(readClientSurface('web')).toBe('unknown');
  });

  test('a client that sends no kind has no surface', () => {
    expect(readClientSurface(undefined)).toBeUndefined();
    expect(readClientSurface('')).toBeUndefined();
  });

  test('non-app clients have no surface', () => {
    expect(readClientSurface('mcp')).toBeUndefined();
    expect(readClientSurface('cli')).toBeUndefined();
    expect(readClientSurface('desktop-main')).toBeUndefined();
  });

  test('an unrecognized value collapses to unknown instead of passing through', () => {
    expect(readClientSurface('embedded:windsurf')).toBe('unknown');
    expect(readClientSurface('browser, desktop')).toBe('unknown');
    expect(readClientSurface('x'.repeat(4096))).toBe('unknown');
  });
});

describe('client-version v1 wire contract', () => {
  test('PROTOCOL_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test('header names are the locked lowercase x-ok-client-* set', () => {
    expect(CLIENT_VERSION_HEADER).toEqual({
      protocol: 'x-ok-client-protocol',
      runtime: 'x-ok-client-runtime',
      kind: 'x-ok-client-kind',
    });
  });

  test('clientVersionHeaders stringifies protocol and carries runtime + kind', () => {
    const headers = clientVersionHeaders({ kind: 'cli', runtimeVersion: '0.8.1' });
    expect(headers).toEqual({
      'x-ok-client-protocol': String(PROTOCOL_VERSION),
      'x-ok-client-runtime': '0.8.1',
      'x-ok-client-kind': 'cli',
    });
    expect(typeof headers['x-ok-client-protocol']).toBe('string');
  });

  test('clientVersionTokenFields keeps protocol as a JSON number', () => {
    const fields = clientVersionTokenFields({ kind: 'browser', runtimeVersion: '0.8.1' });
    expect(fields).toEqual({
      clientProtocolVersion: PROTOCOL_VERSION,
      clientRuntimeVersion: '0.8.1',
      clientKind: 'browser',
    });
    expect(typeof fields.clientProtocolVersion).toBe('number');
  });

  test('runtime sentinel matches the server readRuntimeVersion fallback', () => {
    expect(CLIENT_RUNTIME_VERSION_FALLBACK).toBe('0.0.0-unknown');
  });
});
