/**
 * Unit tests for the external link-preview data layer. Only the network boundary
 * (`globalThis.fetch`) is stubbed; the caching, single-flight, and
 * response-mapping logic runs for real and is asserted through the public
 * `loadLinkPreview` — so "negative results are not cached" and "concurrent
 * hovers coalesce" are behavioral pins, not stubbed internals.
 *
 * Each test uses a fresh URL so the module-level success cache never bleeds
 * across cases.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import { loadLinkPreview, SUCCESS_CACHE_MAX_ENTRIES } from './external-link-preview.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const META: LinkPreviewMetadata = {
  domain: 'example.com',
  title: 'Example Domain',
  description: 'An illustrative example page.',
  faviconDataUri: 'data:image/png;base64,iVBORw0KGgo=',
};

function okResponse(metadata: LinkPreviewMetadata): Response {
  return new Response(JSON.stringify({ ok: true, metadata }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function failResponse(reason: string): Response {
  return new Response(JSON.stringify({ ok: false, reason }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let urlSeq = 0;
function uniqueUrl(): string {
  urlSeq += 1;
  return `https://example-${urlSeq}.test/page`;
}

describe('loadLinkPreview — success + cache', () => {
  test('POSTs the URL as JSON and returns the parsed metadata', async () => {
    const url = uniqueUrl();
    const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(okResponse(META)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadLinkPreview(url);
    expect(result).toEqual(META);

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe('/api/link-preview');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ url });
  });

  test('a re-hover of a previewed URL is served from cache without re-fetching', async () => {
    const url = uniqueUrl();
    const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(okResponse(META)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadLinkPreview(url)).toEqual(META);
    expect(await loadLinkPreview(url)).toEqual(META);
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe('loadLinkPreview — failures fall back to null and are not cached', () => {
  test('a guard-rejection envelope returns null and a later hover retries', async () => {
    const url = uniqueUrl();
    let call = 0;
    const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) => {
      call += 1;
      return Promise.resolve(call === 1 ? failResponse('blocked') : okResponse(META));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadLinkPreview(url)).toBeNull();
    // Not cached: the second hover re-requests and now succeeds.
    expect(await loadLinkPreview(url)).toEqual(META);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test('a non-2xx response (gate/body rejection) returns null', async () => {
    const url = uniqueUrl();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{}', { status: 403 })),
    ) as unknown as typeof fetch;
    expect(await loadLinkPreview(url)).toBeNull();
  });

  test('a thrown request (network/offline) returns null', async () => {
    const url = uniqueUrl();
    globalThis.fetch = mock(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await loadLinkPreview(url)).toBeNull();
  });
});

describe('loadLinkPreview — bounded LRU success cache', () => {
  /** Fetch stub that succeeds for every URL and records which URL each call was for. */
  function countingFetch(): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { url: string }).url);
      return Promise.resolve(okResponse(META));
    }) as unknown as typeof fetch;
    return { calls };
  }

  test('an entry older than the cap is evicted and re-fetched', async () => {
    const { calls } = countingFetch();
    const victim = uniqueUrl();
    await loadLinkPreview(victim);
    // A full cap of newer entries lands after the victim, so it must be gone
    // regardless of what earlier tests left in the module-level cache.
    for (let i = 0; i < SUCCESS_CACHE_MAX_ENTRIES; i += 1) {
      await loadLinkPreview(uniqueUrl());
    }
    await loadLinkPreview(victim);
    expect(calls.filter((u) => u === victim)).toHaveLength(2);
  });

  test('a cache hit bumps recency, so a re-hovered URL survives later inserts', async () => {
    const { calls } = countingFetch();
    const survivor = uniqueUrl();
    await loadLinkPreview(survivor);
    for (let i = 0; i < SUCCESS_CACHE_MAX_ENTRIES - 1; i += 1) {
      await loadLinkPreview(uniqueUrl());
    }
    // The survivor is now the oldest entry; this hit must move it to the back.
    await loadLinkPreview(survivor);
    for (let i = 0; i < SUCCESS_CACHE_MAX_ENTRIES - 1; i += 1) {
      await loadLinkPreview(uniqueUrl());
    }
    // Without the recency bump the fillers above would have evicted it.
    await loadLinkPreview(survivor);
    expect(calls.filter((u) => u === survivor)).toHaveLength(1);
  });
});

describe('loadLinkPreview — single-flight + abort', () => {
  test('concurrent identical hovers coalesce to a single request', async () => {
    const url = uniqueUrl();
    let resolveFetch!: (r: Response) => void;
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = loadLinkPreview(url);
    const second = loadLinkPreview(url);
    expect(fetchMock.mock.calls.length).toBe(1);

    resolveFetch(okResponse(META));
    expect(await first).toEqual(META);
    expect(await second).toEqual(META);
  });

  test('aborting the caller signal resolves to null and caches nothing', async () => {
    const url = uniqueUrl();
    const controller = new AbortController();
    const abortingFetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    globalThis.fetch = abortingFetch as unknown as typeof fetch;

    const pending = loadLinkPreview(url, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();

    // Nothing cached from the aborted attempt: a fresh hover re-requests.
    globalThis.fetch = mock(() => Promise.resolve(okResponse(META))) as unknown as typeof fetch;
    expect(await loadLinkPreview(url)).toEqual(META);
  });
});
