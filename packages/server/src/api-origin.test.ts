import { describe, expect, test } from 'vitest';
import { isAllowedApiOrigin, isOpaqueOrigin } from './api-origin.ts';

describe('API origin guards', () => {
  test('allows only local browser origins and refuses the null origin sandboxed frames send', () => {
    expect(isAllowedApiOrigin('null')).toBe(false);
    expect(isAllowedApiOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedApiOrigin('https://127.0.0.1:3000')).toBe(true);
    expect(isAllowedApiOrigin('http://[::1]:3000')).toBe(true);

    expect(isAllowedApiOrigin('https://example.com')).toBe(false);
    expect(isAllowedApiOrigin('not a url')).toBe(false);
  });

  test('allows the file: origin serialization Chromium WebSockets send from loadFile pages', () => {
    expect(isAllowedApiOrigin('file://')).toBe(true);
    expect(isAllowedApiOrigin('file://evil.example')).toBe(false);
  });
});

describe('isAllowedApiOrigin stays loopback-only', () => {
  test('refuses a tunnel origin — externalUrl admission lives in the ingress policy', () => {
    expect(isAllowedApiOrigin('https://myproject.ngrok.app')).toBe(false);
    expect(isAllowedApiOrigin('http://localhost:5173')).toBe(true);
  });
});

describe('isOpaqueOrigin', () => {
  test('names the origins that do not identify a site: null and any file: origin', () => {
    expect(isOpaqueOrigin('null')).toBe(true);
    expect(isOpaqueOrigin('file://')).toBe(true);
    expect(isOpaqueOrigin('file://127.0.0.1')).toBe(true);
    expect(isOpaqueOrigin('FILE://')).toBe(true);
  });

  test('leaves site origins, including loopback and the literal host "null", alone', () => {
    expect(isOpaqueOrigin('http://localhost:5173')).toBe(false);
    expect(isOpaqueOrigin('http://127.0.0.1:3000')).toBe(false);
    expect(isOpaqueOrigin('https://example.com')).toBe(false);
    expect(isOpaqueOrigin('http://null')).toBe(false);
    expect(isOpaqueOrigin('Null')).toBe(false);
  });
});
