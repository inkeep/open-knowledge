import { describe, expect, test } from 'bun:test';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback';

describe('isLoopbackAddress', () => {
  test('accepts classic IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
  });

  test('accepts anywhere in the 127.0.0.0/8 block', () => {
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
  });

  test('accepts IPv6 loopback', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  test('accepts IPv4-mapped IPv6 loopback', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('accepts anywhere in the IPv4-mapped 127.0.0.0/8 block', () => {
    // Parity with the pure-IPv4 branch: any 127.X.Y.Z mapped onto v6 is
    // still loopback. `startsWith('::ffff:127.')` with the trailing dot
    // mirrors the pure-IPv4 pattern.
    expect(isLoopbackAddress('::ffff:127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.255.255.254')).toBe(true);
  });

  test('rejects LAN IPv4 addresses', () => {
    expect(isLoopbackAddress('192.168.1.1')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('172.16.0.1')).toBe(false);
  });

  test('rejects public IPv4 addresses', () => {
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('1.2.3.4')).toBe(false);
  });

  test('rejects non-loopback IPv6 addresses', () => {
    expect(isLoopbackAddress('fe80::1')).toBe(false);
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
  });

  test('rejects non-loopback IPv4-mapped IPv6', () => {
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('rejects undefined (socket closed)', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isLoopbackAddress('')).toBe(false);
  });

  test('does not misclassify 127-prefixed hostnames outside 127.0.0.0/8', () => {
    // Confirms the startsWith('127.') guard isn't accidentally matching
    // something with a `127` substring that isn't a dotted IPv4 address.
    expect(isLoopbackAddress('127')).toBe(false);
    expect(isLoopbackAddress('1270.0.0.1')).toBe(false);
  });

  test('does not misclassify ::ffff:127-prefixed strings outside the mapped loopback block', () => {
    // Mirror of the pure-IPv4 edge-string test: the trailing `.` in
    // `startsWith('::ffff:127.')` means `::ffff:127` and `::ffff:1270.0.0.1`
    // do not match. Protects against a future refactor that drops the dot.
    expect(isLoopbackAddress('::ffff:127')).toBe(false);
    expect(isLoopbackAddress('::ffff:1270.0.0.1')).toBe(false);
  });
});

describe('isAllowedWorkspaceHostHeader', () => {
  test('accepts localhost with and without port', () => {
    expect(isAllowedWorkspaceHostHeader('localhost')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('localhost:5173')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('localhost:65535')).toBe(true);
  });

  test('accepts 127.0.0.0/8 block with and without port', () => {
    expect(isAllowedWorkspaceHostHeader('127.0.0.1')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('127.0.0.1:5173')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('127.1.2.3:8080')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('127.255.255.254')).toBe(true);
  });

  test('accepts bracketed IPv6 loopback with and without port', () => {
    expect(isAllowedWorkspaceHostHeader('[::1]')).toBe(true);
    expect(isAllowedWorkspaceHostHeader('[::1]:5173')).toBe(true);
  });

  test('rejects undefined or empty header', () => {
    expect(isAllowedWorkspaceHostHeader(undefined)).toBe(false);
    expect(isAllowedWorkspaceHostHeader('')).toBe(false);
  });

  test('rejects attacker-controlled rebound hostnames', () => {
    // DNS-rebinding scenario: page from attacker.com rebinds to 127.0.0.1.
    // The TCP peer is loopback, but the Host header names the attacker.
    expect(isAllowedWorkspaceHostHeader('attacker.com')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('attacker.com:5173')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('evil.localhost')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('localhost.attacker.com')).toBe(false);
  });

  test('rejects LAN / public IPv4 addresses in Host header', () => {
    expect(isAllowedWorkspaceHostHeader('192.168.1.1')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('10.0.0.1:5173')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('8.8.8.8')).toBe(false);
  });

  test('rejects non-loopback IPv6 and malformed brackets', () => {
    expect(isAllowedWorkspaceHostHeader('[fe80::1]')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('[2001:db8::1]:5173')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('::1')).toBe(false); // unbracketed
    expect(isAllowedWorkspaceHostHeader('[::1')).toBe(false); // missing close
    expect(isAllowedWorkspaceHostHeader('[::1]foo')).toBe(false); // trailing junk
  });

  test('rejects 127-substring hostnames that are not in 127.0.0.0/8', () => {
    expect(isAllowedWorkspaceHostHeader('127')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('1270.0.0.1')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('127.0.0')).toBe(false);
  });

  test('rejects non-numeric port segments', () => {
    expect(isAllowedWorkspaceHostHeader('localhost:abc')).toBe(false);
    expect(isAllowedWorkspaceHostHeader('127.0.0.1:')).toBe(false);
  });
});
