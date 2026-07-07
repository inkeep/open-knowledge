/**
 * Client<->server boundary test for the HTTP auth-query transport's signout:
 * drives `httpAuthQueryTransport().signout()` against a live route handler so
 * the transport's RFC 9457 title extraction is verified against the real
 * `/api/local-op/auth/signout` error envelope rather than a hand-mocked body.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { httpAuthQueryTransport } from '@/lib/transports/auth-query-transport';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

type FetchFn = typeof globalThis.fetch;

let server: TestServer;
let originalFetch: FetchFn;

beforeAll(async () => {
  server = await createTestServer({
    // Spawn ENOENT triggers the catch in handleLocalOpAuthSignout -> 500 problem+json.
    localOpCliArgs: ['/nonexistent-test-binary-do-not-create-this-file'],
  });
  // The transport posts to an origin-relative path (it runs in the browser);
  // rewrite leading-slash URLs to the test server so the real handler runs.
  const origin = `http://127.0.0.1:${server.port}`;
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const target = typeof input === 'string' && input.startsWith('/') ? origin + input : input;
    return originalFetch(target, init);
  }) as FetchFn;
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await server.cleanup();
});

describe('httpAuthQueryTransport signout (client<->server boundary)', () => {
  test('returns a typed failure carrying the route problem+json title when the relay spawn fails', async () => {
    const transport = httpAuthQueryTransport();
    if (!transport.signout) throw new Error('http transport must implement signout');

    const result = await transport.signout({ host: 'github.com' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Auth signout failed.');
    }
  });
});
