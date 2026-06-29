
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { httpAuthQueryTransport } from '@/lib/transports/auth-query-transport';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

type FetchFn = typeof globalThis.fetch;

let server: TestServer;
let originalFetch: FetchFn;

beforeAll(async () => {
  server = await createTestServer({
    localOpCliArgs: ['/nonexistent-test-binary-do-not-create-this-file'],
  });
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
