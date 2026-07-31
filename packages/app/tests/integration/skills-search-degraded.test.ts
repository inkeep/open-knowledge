/**
 * `GET /api/skills/search` when the upstreams refuse to answer.
 *
 * The distinction under test is "we could not answer" vs "there is no such
 * skill". skills.sh failing is recoverable — GitHub topic search takes over and
 * the client shows a degraded banner. GitHub failing too is NOT: it used to
 * report an empty 200, which the UI renders as "No skills found", telling the
 * user the skill does not exist when both backends were merely rate-limited.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;
const realFetch = globalThis.fetch;

/** Route upstream calls to `handler`; everything else hits the real server. */
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
