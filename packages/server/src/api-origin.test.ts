import { describe, expect, test } from 'vitest';
import { isAllowedApiOrigin } from './api-origin.ts';

describe('API origin guards', () => {
  test('allows only local browser origins and opaque Electron origins', () => {
    expect(isAllowedApiOrigin('null')).toBe(true);
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
