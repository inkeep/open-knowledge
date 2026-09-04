import { describe, expect, test } from 'vitest';
import { classifyHost, isPublicUnicastIp } from './ip-classifier.ts';

describe('isPublicUnicastIp', () => {
  const PUBLIC_UNICAST = [
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '2001:4860:4860::8888',
  ];
  test.each(PUBLIC_UNICAST)('allows public unicast %s', (ip) => {
    expect(isPublicUnicastIp(ip)).toBe(true);
  });

  const BLOCKED = [
    '127.0.0.1',
    '::1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '224.0.0.1',
    'ff02::1',
    '0.0.0.0',
    '::',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '2002::1',
    '::ffff:127.0.0.1',
    '::ffff:93.184.216.34',
  ];
  test.each(BLOCKED)('rejects non-unicast %s', (ip) => {
    expect(isPublicUnicastIp(ip)).toBe(false);
  });

  const NOT_AN_IP = ['example.com', 'not-an-ip', '', ' ', '256.256.256.256', 'localhost'];
  test.each(NOT_AN_IP)('rejects non-IP input %p without throwing', (value) => {
    expect(isPublicUnicastIp(value)).toBe(false);
  });
});

describe('classifyHost', () => {
  const LOOPBACK_SPELLINGS = [
    '127.0.0.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f000001',
    '017700000001',
    '127.1',
    '0x7f.1',
  ];
  test.each(LOOPBACK_SPELLINGS)('canonicalizes %s to blocked 127.0.0.1', (host) => {
    expect(classifyHost(host)).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '127.0.0.1',
      family: 4,
    });
  });

  test('classifies other blocked IPv4 literals with their canonical form', () => {
    expect(classifyHost('10.0.0.1')).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '10.0.0.1',
      family: 4,
    });
    expect(classifyHost('169.254.169.254')).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '169.254.169.254',
      family: 4,
    });
    expect(classifyHost('0.0.0.0')).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '0.0.0.0',
      family: 4,
    });
  });

  test('classifies blocked IPv6 literals, stripping brackets', () => {
    expect(classifyHost('::1')).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '::1',
      family: 6,
    });
    expect(classifyHost('[::1]')).toEqual({
      kind: 'ip-literal',
      allowed: false,
      canonical: '::1',
      family: 6,
    });
    expect(classifyHost('fc00::1')).toMatchObject({
      kind: 'ip-literal',
      allowed: false,
      family: 6,
    });
    expect(classifyHost('::ffff:127.0.0.1')).toMatchObject({
      kind: 'ip-literal',
      allowed: false,
      family: 6,
    });
  });

  test('allows public unicast literals and reports family for pinning', () => {
    expect(classifyHost('93.184.216.34')).toEqual({
      kind: 'ip-literal',
      allowed: true,
      canonical: '93.184.216.34',
      family: 4,
    });
    expect(classifyHost('8.8.8.8')).toEqual({
      kind: 'ip-literal',
      allowed: true,
      canonical: '8.8.8.8',
      family: 4,
    });
    expect(classifyHost('2001:4860:4860::8888')).toEqual({
      kind: 'ip-literal',
      allowed: true,
      canonical: '2001:4860:4860::8888',
      family: 6,
    });
    expect(classifyHost('[2001:4860:4860::8888]')).toEqual({
      kind: 'ip-literal',
      allowed: true,
      canonical: '2001:4860:4860::8888',
      family: 6,
    });
  });

  const HOSTNAMES = ['example.com', 'sub.example.com', 'localhost', '127.0.0.1.', 'not-an-ip'];
  test.each(HOSTNAMES)('defers DNS name %p to resolution', (host) => {
    expect(classifyHost(host)).toEqual({ kind: 'hostname' });
  });

  const GARBAGE = ['', ' ', '[', '[]', '::ffff:', 'http://x', '999.999'];
  test.each(GARBAGE)('never throws on malformed host %p', (host) => {
    const result = classifyHost(host);
    expect(['hostname', 'ip-literal']).toContain(result.kind);
  });
});
