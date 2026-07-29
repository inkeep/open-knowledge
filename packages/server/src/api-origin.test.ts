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
    // fetch/XHR from a file: page send `Origin: null`; the WS handshake from
    // the same page sends `Origin: file://`. Both must pass or the packaged
    // desktop renderer's `/collab/thread` upgrade is destroyed while all its
    // HTTP calls succeed.
    expect(isAllowedApiOrigin('file://')).toBe(true);
    // Only the bare serialization — a file URL with a host is not a page origin.
    expect(isAllowedApiOrigin('file://evil.example')).toBe(false);
  });
});

describe('isAllowedApiOrigin with a remote public host', () => {
  test('admits the https tunnel origin only when the host is supplied', () => {
    expect(isAllowedApiOrigin('https://myproject.ngrok.app', 'myproject.ngrok.app')).toBe(true);
    expect(isAllowedApiOrigin('https://myproject.ngrok.app')).toBe(false);
  });

  test('still refuses foreign and http origins with the host supplied', () => {
    expect(isAllowedApiOrigin('https://evil.example.com', 'myproject.ngrok.app')).toBe(false);
    expect(isAllowedApiOrigin('http://myproject.ngrok.app', 'myproject.ngrok.app')).toBe(false);
  });

  test('loopback origins keep working alongside the remote host', () => {
    expect(isAllowedApiOrigin('http://localhost:5173', 'myproject.ngrok.app')).toBe(true);
  });
});
