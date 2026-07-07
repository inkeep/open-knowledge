import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchApiConfig } from './api-config';

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;

function stubFetch(fn: FetchFn): void {
  globalThis.fetch = fn;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchApiConfig', () => {
  it('returns parsed payload when /api/config returns 200 with full shape', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            collabUrl: 'ws://localhost:52000/collab',
            previewUrl: 'http://localhost:3000/',
            port: 3000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = await fetchApiConfig();
    expect(result).toEqual({
      status: 'ok',
      config: {
        collabUrl: 'ws://localhost:52000/collab',
        previewUrl: 'http://localhost:3000/',
        port: 3000,
        paneTarget: null,
        singleFile: false,
      },
    });
  });

  it('normalizes missing fields to null / 0 / false', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ collabUrl: null, previewUrl: null, port: 0 }), {
          status: 200,
        }),
    );
    const result = await fetchApiConfig();
    expect(result).toEqual({
      status: 'ok',
      config: { collabUrl: null, previewUrl: null, port: 0, paneTarget: null, singleFile: false },
    });
  });

  it('parses the single-file flag from an ephemeral server', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ collabUrl: null, previewUrl: null, port: 0, singleFile: true }),
          { status: 200 },
        ),
    );
    const result = await fetchApiConfig();
    expect(result).toEqual({
      status: 'ok',
      config: { collabUrl: null, previewUrl: null, port: 0, paneTarget: null, singleFile: true },
    });
  });

  it('parses an armed paneTarget route fragment', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            collabUrl: null,
            previewUrl: null,
            port: 0,
            paneTarget: '#/specs/foo/',
          }),
          { status: 200 },
        ),
    );
    const result = await fetchApiConfig();
    expect(result).toEqual({
      status: 'ok',
      config: {
        collabUrl: null,
        previewUrl: null,
        port: 0,
        paneTarget: '#/specs/foo/',
        singleFile: false,
      },
    });
  });

  it('returns absent when the response is 404 (bun run dev fallback)', async () => {
    stubFetch(async () => new Response('', { status: 404 }));
    const result = await fetchApiConfig();
    expect(result).toEqual({ status: 'absent' });
  });

  it('returns error with status code on 5xx (distinct from 404)', async () => {
    stubFetch(async () => new Response('oops', { status: 500 }));
    const result = await fetchApiConfig();
    expect(result).toEqual({ status: 'error', code: 500 });
  });

  it('returns error when the response body is not an object', async () => {
    stubFetch(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }));
    const result = await fetchApiConfig();
    expect(result).toEqual({ status: 'error', code: 'invalid-body' });
  });

  it('returns error when the response body is unparseable JSON', async () => {
    stubFetch(async () => new Response('<html>nope', { status: 200 }));
    const result = await fetchApiConfig();
    expect(result).toEqual({ status: 'error', code: 'invalid-body' });
  });

  it('returns error on network failure', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await fetchApiConfig();
    expect(result).toEqual({ status: 'error', code: 'network' });
  });

  it('coerces non-string collabUrl to null', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ collabUrl: 42, previewUrl: true, port: 'abc' }), {
          status: 200,
        }),
    );
    const result = await fetchApiConfig();
    expect(result).toEqual({
      status: 'ok',
      config: { collabUrl: null, previewUrl: null, port: 0, paneTarget: null, singleFile: false },
    });
  });

  it('propagates AbortError when the signal is aborted before fetch resolves', async () => {
    const ac = new AbortController();
    stubFetch(async (_url, init) => {
      // Simulate a slow fetch that observes the abort signal.
      return await new Promise<Response>((_resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const promise = fetchApiConfig(ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
