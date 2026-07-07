import { describe, expect, test } from 'bun:test';
import {
  decodeShareUrl,
  encodeShareUrl,
  InvalidShareUrlError,
  UnsupportedShareVersionError,
} from './share-url.ts';

describe('encodeShareUrl', () => {
  test('returns a base64url string with no padding for a simple blob URL', () => {
    const encoded = encodeShareUrl('https://github.com/a/b/blob/main/c.md');
    // Base64url uses [-A-Za-z0-9_]; padding `=` must be stripped.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.includes('=')).toBe(false);
  });

  test('produces a payload whose first decoded byte is 0x01 (version v1)', () => {
    const encoded = encodeShareUrl('https://github.com/a/b/blob/main/c.md');
    // Manually base64url-decode the prefix to inspect the version byte.
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    expect(binary.charCodeAt(0)).toBe(0x01);
  });
});

describe('decodeShareUrl', () => {
  test('round-trips a simple blob URL through encode/decode', () => {
    const sharedUrl = 'https://github.com/a/b/blob/main/c.md';
    const result = decodeShareUrl(encodeShareUrl(sharedUrl));
    expect(result).toEqual({ version: 1, sharedUrl });
  });

  test('round-trips a long real-world GitHub blob URL with deep path', () => {
    const sharedUrl =
      'https://github.com/inkeep/open-knowledge/blob/feat%2Fsharing-virality-flow/packages/core/src/sharing/share-url.ts';
    expect(decodeShareUrl(encodeShareUrl(sharedUrl))).toEqual({ version: 1, sharedUrl });
  });

  test('round-trips a URL with unicode and spaces in the path', () => {
    const sharedUrl =
      'https://github.com/inkeep/playbooks/blob/main/docs/Q4%20OKRs%20%E2%80%94%20Marketing.md';
    expect(decodeShareUrl(encodeShareUrl(sharedUrl))).toEqual({ version: 1, sharedUrl });
  });

  test('throws UnsupportedShareVersionError when the version byte is not 0x01', () => {
    // Build a v2-shaped payload directly: [0x02] + utf-8 bytes of a URL.
    const blobBytes = new TextEncoder().encode('https://example.com/foo');
    const bytes = new Uint8Array(1 + blobBytes.length);
    bytes[0] = 0x02;
    bytes.set(blobBytes, 1);
    const encoded = uint8ArrayToBase64UrlForTest(bytes);

    let caught: unknown;
    try {
      decodeShareUrl(encoded);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedShareVersionError);
    expect((caught as UnsupportedShareVersionError).version).toBe(2);
  });

  test('throws InvalidShareUrlError on undecodable base64url input', () => {
    let caught: unknown;
    try {
      // `!` is not a valid base64url character; the body should fail to decode.
      decodeShareUrl('not!valid!base64!!!');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidShareUrlError);
  });

  test('throws InvalidShareUrlError on empty input', () => {
    expect(() => decodeShareUrl('')).toThrow(InvalidShareUrlError);
  });

  test('throws InvalidShareUrlError when the payload after the version byte is not valid UTF-8', () => {
    // Build a v1 payload whose body is an invalid lone surrogate-equivalent byte
    // sequence (e.g. 0xC3 alone — a UTF-8 lead byte with no continuation).
    const bytes = new Uint8Array([0x01, 0xc3, 0x28]);
    const encoded = uint8ArrayToBase64UrlForTest(bytes);
    expect(() => decodeShareUrl(encoded)).toThrow(InvalidShareUrlError);
  });

  test('ignores arbitrary query parameters appended to the encoded payload (Axis 1)', () => {
    const sharedUrl = 'https://github.com/a/b/blob/main/c.md';
    const encoded = encodeShareUrl(sharedUrl);
    expect(decodeShareUrl(`${encoded}?utm_source=slack&ref=campaign`)).toEqual({
      version: 1,
      sharedUrl,
    });
  });

  test('ignores an arbitrary fragment appended to the encoded payload (Axis 2)', () => {
    const sharedUrl = 'https://github.com/a/b/blob/main/c.md';
    const encoded = encodeShareUrl(sharedUrl);
    expect(decodeShareUrl(`${encoded}#section-2`)).toEqual({ version: 1, sharedUrl });
  });

  test('ignores both query parameters and a fragment appended together', () => {
    const sharedUrl = 'https://github.com/a/b/blob/main/c.md';
    const encoded = encodeShareUrl(sharedUrl);
    expect(decodeShareUrl(`${encoded}?utm=x#frag`)).toEqual({ version: 1, sharedUrl });
  });
});

/**
 * Test-only helper that mirrors the production base64url encoder so tests can
 * forge non-v1 payloads without importing the private encoder. Kept inline so
 * the production module exports stay minimal (encodeShareUrl + decodeShareUrl
 * plus error classes).
 */
function uint8ArrayToBase64UrlForTest(bytes: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binaryString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
