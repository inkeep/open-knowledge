import { DOCUMENT_REFRESH_MAX_DOCS } from '@inkeep/open-knowledge-core/schemas/api';
import { describe, expect, it, vi } from 'vitest';
import { refreshDocumentsFromDisk } from './refresh-documents-from-disk';

function requestedBatches(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): string[][] {
  return fetchImpl.mock.calls.map(([, init]) => {
    const body: { docNames?: unknown } = JSON.parse(String(init?.body));
    return Array.isArray(body.docNames) ? body.docNames.map(String) : [];
  });
}

describe('refreshDocumentsFromDisk', () => {
  it('asks the server to re-read every open document, in batches the route accepts', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"checked":0,"found":0}'));
    const docNames = Array.from({ length: DOCUMENT_REFRESH_MAX_DOCS + 6 }, (_, i) => `doc-${i}`);

    await refreshDocumentsFromDisk(docNames, fetchImpl);

    const batches = requestedBatches(fetchImpl);
    expect(batches.map((batch) => batch.length)).toEqual([DOCUMENT_REFRESH_MAX_DOCS, 6]);
    expect(batches.flat()).toEqual(docNames);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/documents/refresh');
  });

  it('sends nothing when no document is open', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    await refreshDocumentsFromDisk([], fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps going after a failed request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response('{}'));
    const docNames = Array.from({ length: DOCUMENT_REFRESH_MAX_DOCS + 1 }, (_, i) => `doc-${i}`);

    await refreshDocumentsFromDisk(docNames, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('logs a refused re-read with its status and still sends the next batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValue(new Response('{"checked":1,"found":0}'));
    const docNames = Array.from({ length: DOCUMENT_REFRESH_MAX_DOCS + 1 }, (_, i) => `doc-${i}`);

    await refreshDocumentsFromDisk(docNames, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        event: 'ok-document-refresh-request-failed',
        docCount: DOCUMENT_REFRESH_MAX_DOCS,
        status: 500,
      },
    ]);
    warn.mockRestore();
  });
});
