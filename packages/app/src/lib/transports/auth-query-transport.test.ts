/**
 * Unit coverage for the HTTP auth-query transport's `signout` parse logic: the
 * empty-body 200 success path and the RFC 9457 problem+json failure path. The
 * real client<->server boundary is exercised separately against a live route
 * handler in tests/integration/api-error-envelope.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { httpAuthQueryTransport } from './auth-query-transport';

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;
let lastCall: { url: string; init: Parameters<FetchFn>[1] } | null;
let fetchCalls: Array<{ url: string; init: Parameters<FetchFn>[1] }>;

function stubFetch(make: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    lastCall = { url: typeof input === 'string' ? input : String(input), init };
    fetchCalls.push(lastCall);
    return await make();
  }) as FetchFn;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastCall = null;
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('httpAuthQueryTransport().status', () => {
  it('coalesces concurrent same-host checks across transport instances', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    stubFetch(() => pendingResponse);

    const a = httpAuthQueryTransport().status();
    const b = httpAuthQueryTransport().status({ host: 'github.com' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('/api/local-op/auth/status');

    resolveFetch?.(
      new Response(JSON.stringify({ authenticated: true, host: 'github.com', login: 'octocat' }), {
        status: 200,
      }),
    );

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual({ authenticated: true, host: 'github.com', login: 'octocat' });
    expect(resB).toEqual(resA);
  });

  it('keeps concurrent different-host checks isolated', async () => {
    let resolveGithub: ((response: Response) => void) | undefined;
    let resolveGitlab: ((response: Response) => void) | undefined;
    const pendingResponses = [
      new Promise<Response>((resolve) => {
        resolveGithub = resolve;
      }),
      new Promise<Response>((resolve) => {
        resolveGitlab = resolve;
      }),
    ];
    stubFetch(() => {
      const response = pendingResponses.shift();
      if (!response) throw new Error('unexpected extra fetch');
      return response;
    });

    const githubStatus = httpAuthQueryTransport().status({ host: 'github.com' });
    const gitlabStatus = httpAuthQueryTransport().status({ host: 'gitlab.com' });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.map((call) => JSON.parse(String(call.init?.body)).host)).toEqual([
      'github.com',
      'gitlab.com',
    ]);

    resolveGithub?.(
      new Response(JSON.stringify({ authenticated: true, host: 'github.com', login: 'octocat' })),
    );
    resolveGitlab?.(new Response(JSON.stringify({ authenticated: false, host: 'gitlab.com' })));

    await expect(githubStatus).resolves.toEqual({
      authenticated: true,
      host: 'github.com',
      login: 'octocat',
    });
    await expect(gitlabStatus).resolves.toEqual({
      authenticated: false,
      host: 'gitlab.com',
    });
  });

  it('clears the coalescing slot after the status check settles', async () => {
    stubFetch(() => new Response(JSON.stringify({ authenticated: false, host: 'github.com' })));
    const transport = httpAuthQueryTransport();

    await transport.status();
    await transport.status();

    expect(fetchCalls).toHaveLength(2);
  });

  it('clears the coalescing slot after the status check rejects', async () => {
    let callCount = 0;
    stubFetch(() => {
      callCount += 1;
      if (callCount === 1) throw new Error('network down');
      return new Response(JSON.stringify({ authenticated: false, host: 'github.com' }));
    });
    const transport = httpAuthQueryTransport();

    await expect(transport.status()).rejects.toThrow('network down');
    await expect(transport.status()).resolves.toEqual({
      authenticated: false,
      host: 'github.com',
    });

    expect(fetchCalls).toHaveLength(2);
  });
});

describe('httpAuthQueryTransport().signout', () => {
  it('POSTs to the signout endpoint and resolves ok on a 200 empty body', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const transport = httpAuthQueryTransport();
    if (!transport.signout) throw new Error('http transport must implement signout');

    const result = await transport.signout({ host: 'github.com' });

    expect(result).toEqual({ ok: true });
    expect(lastCall?.url).toBe('/api/local-op/auth/signout');
    expect(lastCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(lastCall?.init?.body))).toEqual({ host: 'github.com' });
  });

  it('surfaces the RFC 9457 problem title when the endpoint returns problem+json', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:auth-failed',
            title: 'Auth signout failed.',
            status: 500,
          }),
          { status: 500, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const transport = httpAuthQueryTransport();
    if (!transport.signout) throw new Error('http transport must implement signout');

    const result = await transport.signout();

    expect(result).toEqual({ ok: false, error: 'Auth signout failed.' });
  });

  it('returns failure with no error title when the body is not problem+json', async () => {
    stubFetch(() => new Response('upstream boom', { status: 502 }));
    const transport = httpAuthQueryTransport();
    if (!transport.signout) throw new Error('http transport must implement signout');

    const result = await transport.signout();

    // No server title → no error field; the UI supplies a localized fallback
    // rather than the transport emitting an English literal.
    expect(result).toEqual({ ok: false });
  });

  it('omits host from the body when none is supplied (server applies its default)', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const transport = httpAuthQueryTransport();
    if (!transport.signout) throw new Error('http transport must implement signout');

    await transport.signout();

    expect(JSON.parse(String(lastCall?.init?.body))).toEqual({});
  });
});
