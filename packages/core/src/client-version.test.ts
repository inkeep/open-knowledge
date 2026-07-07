import { describe, expect, test } from 'bun:test';
import {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  CLIENT_VERSION_HEADER,
  clientVersionHeaders,
  clientVersionTokenFields,
} from './client-version.ts';
import { PROTOCOL_VERSION } from './protocol-version.ts';

// These assertions pin the v1 wire contract. It is a one-way door: once a
// released client emits this shape, the future server-read logic must accept
// it from every released client forever. A failure here means a wire-breaking
// change — intentional changes are append-only.
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
    // Headers must be plain strings — `Number` would not survive a HeadersInit.
    expect(typeof headers['x-ok-client-protocol']).toBe('string');
  });

  test('clientVersionTokenFields keeps protocol as a JSON number', () => {
    const fields = clientVersionTokenFields({ kind: 'web', runtimeVersion: '0.8.1' });
    expect(fields).toEqual({
      clientProtocolVersion: PROTOCOL_VERSION,
      clientRuntimeVersion: '0.8.1',
      clientKind: 'web',
    });
    expect(typeof fields.clientProtocolVersion).toBe('number');
  });

  test('runtime sentinel matches the server readRuntimeVersion fallback', () => {
    expect(CLIENT_RUNTIME_VERSION_FALLBACK).toBe('0.0.0-unknown');
  });
});
