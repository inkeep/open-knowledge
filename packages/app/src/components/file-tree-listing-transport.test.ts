import { afterEach, describe, expect, test, vi } from 'vitest';
import { ShowAllStreamError } from '@/lib/show-all-stream';
import { fetchShowAllDepth1Listing, showAllDepth1Url } from './file-tree-listing-transport';

const messages = {
  fallbackErrorTitle: 'Failed to load documents',
  schemaMismatchTitle: 'Documents response did not match expected shape.',
};

function documentEntry(docName: string) {
  return {
    kind: 'document',
    docName,
    docExt: '.md',
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    isSymlink: false,
    canonicalDocName: null,
    targetPath: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('file-tree-listing transport', () => {
  test('builds one encoded depth-one URL and includes showOk only when requested', () => {
    expect(showAllDepth1Url('', false)).toBe('/api/documents?showAll=true&dir=&depth=1');
    expect(showAllDepth1Url('team notes/a', true)).toBe(
      '/api/documents?showAll=true&showOk=true&dir=team%20notes%2Fa&depth=1',
    );
  });

  test('returns buffered entries', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ documents: [documentEntry('notes/a')], truncated: false }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchShowAllDepth1Listing({
      dir: '',
      showOk: false,
      signal: controller.signal,
      messages,
    });

    expect(result).toEqual({
      kind: 'entries',
      entries: [documentEntry('notes/a')],
      truncated: false,
    });
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.signal).toBe(controller.signal);
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({ Accept: expect.stringContaining('application/x-ndjson') }),
    );
  });

  test('publishes NDJSON batches before returning the authoritative entries', async () => {
    const entry = documentEntry('notes/a');
    const releaseCompletion = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(entry)}\n`));
          void releaseCompletion.promise.then(() => {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: 'complete', truncated: true, count: 1 })}\n`,
              ),
            );
            controller.close();
          });
        },
      }),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const batches: string[][] = [];
    let completed = false;

    const resultPromise = fetchShowAllDepth1Listing({
      dir: '',
      showOk: true,
      signal: new AbortController().signal,
      messages,
      onBatch: (batch) =>
        batches.push(batch.map((item) => (item.kind === 'document' ? item.docName : item.path))),
    }).finally(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(batches).toEqual([['notes/a']]));
    expect(completed).toBe(false);
    releaseCompletion.resolve();
    const result = await resultPromise;
    expect(result).toEqual({ kind: 'entries', entries: [entry], truncated: true });
  });

  test('preserves HTTP and schema classifications without attaching causes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(
      fetchShowAllDepth1Listing({
        dir: '',
        showOk: false,
        signal: new AbortController().signal,
        messages,
      }),
    ).resolves.toEqual({
      kind: 'http-error',
      title: expect.stringContaining('HTTP 500'),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nope: true }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(
      fetchShowAllDepth1Listing({
        dir: '',
        showOk: false,
        signal: new AbortController().signal,
        messages,
      }),
    ).resolves.toEqual({ kind: 'http-error', title: messages.schemaMismatchTitle });
  });

  test('preserves a stream error cause for root diagnostics', async () => {
    const body = `${JSON.stringify({ type: 'error', problem: { title: 'walk failed' } })}\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
      ),
    );

    const result = await fetchShowAllDepth1Listing({
      dir: '',
      showOk: false,
      signal: new AbortController().signal,
      messages,
    });

    expect(result).toMatchObject({
      kind: 'http-error',
      title: 'walk failed',
      cause: expect.any(ShowAllStreamError),
    });
  });

  test('returns an ordinary network failure with its cause', async () => {
    const networkFailure = new TypeError('connection reset');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(networkFailure)),
    );
    await expect(
      fetchShowAllDepth1Listing({
        dir: '',
        showOk: false,
        signal: new AbortController().signal,
        messages,
      }),
    ).resolves.toEqual({ kind: 'network-error', cause: networkFailure });
  });

  test('classifies an abort as a network failure carrying the abort as its cause', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(abort)),
    );
    await expect(
      fetchShowAllDepth1Listing({
        dir: '',
        showOk: false,
        signal: new AbortController().signal,
        messages,
      }),
    ).resolves.toEqual({ kind: 'network-error', cause: abort });
  });
});
