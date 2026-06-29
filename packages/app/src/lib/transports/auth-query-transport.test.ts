import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { httpAuthQueryTransport } from './auth-query-transport';

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;
let lastCall: { url: string; init: Parameters<FetchFn>[1] } | null;

function stubFetch(make: () => Response): void {
  globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    lastCall = { url: typeof input === 'string' ? input : String(input), init };
    return make();
  }) as FetchFn;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastCall = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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
