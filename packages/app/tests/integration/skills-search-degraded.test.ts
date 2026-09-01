import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;
const realFetch = globalThis.fetch;

function stubUpstreams(handler: (url: string) => Response | null): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('skills.sh') || url.includes('api.github.com')) {
      const stubbed = handler(url);
      if (stubbed) return stubbed;
    }
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;
}

beforeEach(async () => {
  server = await createTestServer();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await server.cleanup();
});

const search = (q: string) =>
  realFetch(`http://127.0.0.1:${server.port}/api/skills/search?q=${encodeURIComponent(q)}`);

describe('GET /api/skills/search — both upstreams unavailable', () => {
  test('a rate-limited GitHub fallback is a 502, not an empty result set', async () => {
    stubUpstreams((url) =>
      url.includes('api.github.com')
        ? new Response('{"message":"API rate limit exceeded"}', { status: 403 })
        : new Response('upstream down', { status: 503 }),
    );

    const res = await search('grill');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:internal-server-error');
  });

  test('skills.sh alone failing still degrades to GitHub rather than erroring', async () => {
    stubUpstreams((url) =>
      url.includes('api.github.com')
        ? new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('upstream down', { status: 503 }),
    );

    const res = await search('grill');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend?: string; degraded?: boolean };
    expect(body.backend).toBe('github-fallback');
    expect(body.degraded).toBe(true);
  });
});
