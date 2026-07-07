import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { installClientFetchWrapper } from './client-fetch';

/**
 * Unit tests for the always-installed renderer fetch wrapper. These exercise
 * the pure wrapper logic — no DOM or Electron runtime needed. The real
 * window.fetch is replaced by a stub so we can assert on the URL + headers
 * passed through.
 *
 * Isolation contract: Bun's test runner shares a single process across test
 * files, so we preserve + restore `globalThis.window` and `globalThis.fetch`
 * around this suite. Other suites (e.g. `handle-paste.test.ts`) depend on the
 * ambient `window` object being untouched — without this restoration they'd see
 * our stub and fail with "window.getSelection is not a function" or similar.
 *
 * Coverage:
 *  - version headers injected on every /api/* request (web mode, no apiOrigin)
 *  - desktop mode: relative /api/* rewritten to apiOrigin AND headers injected
 *  - absolute apiOrigin /api/* (skill installer shape) → headers, no double-rewrite
 *  - non-/api requests + absolute externals → untouched, no headers
 *  - Request objects → rewritten, method/body preserved, headers injected
 *  - double-install is idempotent
 */

type GlobalLike = {
  window?: Window;
  fetch?: typeof fetch;
};
const g = globalThis as unknown as GlobalLike;
const originalWindow = g.window;
const originalFetch = g.fetch;

const PROTOCOL = 'x-ok-client-protocol';
const RUNTIME = 'x-ok-client-runtime';
const KIND = 'x-ok-client-kind';

type Recorded = { input: RequestInfo | URL; init?: RequestInit };

function stubWindowFetch() {
  const calls: Array<Recorded> = [];
  const fetchStub = mock((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  });
  g.window = {
    fetch: fetchStub,
    location: { origin: 'http://localhost:5173' },
  } as unknown as Window;
  // Replace globalThis.fetch too since `window.fetch.bind(window)` reads the
  // identity from the `window` binding we just installed.
  g.fetch = fetchStub as unknown as typeof fetch;
  return { calls, fetchStub };
}

/** Read a header off a recorded call's init (the wrapper always passes Headers). */
function header(call: Recorded | undefined, name: string): string | null | undefined {
  const h = call?.init?.headers;
  return h instanceof Headers ? h.get(name) : undefined;
}

describe('installClientFetchWrapper', () => {
  beforeAll(() => {
    // Capture whatever ambient globals exist at suite entry.
  });

  afterAll(() => {
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
    if (originalFetch === undefined) delete g.fetch;
    else g.fetch = originalFetch;
  });

  afterEach(() => {
    // Fresh window per test so the Symbol.for marker doesn't leak across.
    delete g.window;
    delete g.fetch;
  });

  // web mode (no apiOrigin) — headers on every /api/* call, URL unchanged.
  test('web mode injects version headers on relative /api/* without rewriting', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper();
    await window.fetch('/api/documents');
    expect(calls[0]?.input).toBe('/api/documents');
    expect(header(calls[0], PROTOCOL)).toBe('1');
    expect(header(calls[0], KIND)).toBe('web');
    expect(typeof header(calls[0], RUNTIME)).toBe('string');
  });

  test('desktop mode rewrites relative /api/* to apiOrigin AND injects headers', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    await window.fetch('/api/document?docName=foo&cache=bust');
    expect(calls[0]?.input).toBe('http://localhost:59534/api/document?docName=foo&cache=bust');
    expect(header(calls[0], PROTOCOL)).toBe('1');
    expect(header(calls[0], KIND)).toBe('web');
  });

  // A caller that pre-prepends apiOrigin (skill installer)
  // must still be instrumented even though it bypasses the relative-path rewrite.
  test('absolute apiOrigin /api/* gets headers without double-rewrite', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    await window.fetch('http://localhost:59534/api/install-skill', { method: 'POST' });
    expect(calls[0]?.input).toBe('http://localhost:59534/api/install-skill');
    expect(header(calls[0], PROTOCOL)).toBe('1');
    expect(header(calls[0], KIND)).toBe('web');
  });

  test('rewrites URL object with same-origin /api/* path + injects headers', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    await window.fetch(new URL('/api/backlinks?docName=foo', 'http://localhost:5173'));
    expect(calls[0]?.input).toBe('http://localhost:59534/api/backlinks?docName=foo');
    expect(header(calls[0], KIND)).toBe('web');
  });

  test('passes absolute external http:// URLs through unchanged, no headers', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    await window.fetch('https://example.com/image.png');
    expect(calls[0]?.input).toBe('https://example.com/image.png');
    expect(header(calls[0], PROTOCOL)).toBeUndefined();
  });

  test('passes absolute ws:// URLs through unchanged', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    await window.fetch('ws://localhost:59534/collab');
    expect(calls[0]?.input).toBe('ws://localhost:59534/collab');
    expect(header(calls[0], PROTOCOL)).toBeUndefined();
  });

  test('passes non-/api relative URLs through unchanged, no headers', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper();
    await window.fetch('/assets/favicon.svg');
    expect(calls[0]?.input).toBe('/assets/favicon.svg');
    expect(header(calls[0], PROTOCOL)).toBeUndefined();
  });

  test('leaves URL object for absolute external unchanged', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    const extUrl = new URL('https://api.example.com/v1/thing');
    await window.fetch(extUrl);
    expect(calls[0]?.input).toBe(extUrl);
    expect(header(calls[0], PROTOCOL)).toBeUndefined();
  });

  test('rewrites Request object wrapping /api/*, preserving method + injecting headers', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    const req = new Request('http://localhost:5173/api/agent-write-md', {
      method: 'POST',
      body: JSON.stringify({ docName: 'foo', position: 'replace', content: 'x' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await window.fetch(req);
    const rewritten = calls[0]?.input;
    expect(rewritten).toBeInstanceOf(Request);
    expect((rewritten as Request).url).toBe('http://localhost:59534/api/agent-write-md');
    expect((rewritten as Request).method).toBe('POST');
    // Version headers ride in the override init; original Content-Type preserved.
    expect(header(calls[0], KIND)).toBe('web');
    expect(header(calls[0], 'content-type')).toBe('application/json');
  });

  test('web mode still installs (always-on) and instruments — not a no-op', async () => {
    const { fetchStub } = stubWindowFetch();
    const before = window.fetch;
    installClientFetchWrapper({ apiOrigin: '' });
    // Wrapper installed even with empty apiOrigin (headers must reach web mode).
    expect(window.fetch).not.toBe(before);
    expect(window.fetch).not.toBe(fetchStub as unknown as typeof fetch);
  });

  test('double-install is idempotent (second call does not double-wrap)', async () => {
    const { calls } = stubWindowFetch();
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    const firstWrapper = window.fetch;
    installClientFetchWrapper({ apiOrigin: 'http://localhost:59534' });
    expect(window.fetch).toBe(firstWrapper);
    await window.fetch('/api/documents');
    expect(calls[0]?.input).toBe('http://localhost:59534/api/documents');
    expect(header(calls[0], PROTOCOL)).toBe('1');
  });
});
