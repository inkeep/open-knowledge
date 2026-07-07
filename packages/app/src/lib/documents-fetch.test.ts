/**
 * Unit coverage for the `/api/documents` single-flight coordinator. Proves
 * concurrent callers coalesce onto one request, that it is single-flight (not a
 * result cache — sequential calls refetch), that a rejection releases the slot,
 * and the `{ ok, status, body }` shaping (including the not-JSON → null path).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __resetDocumentListInflightForTests, fetchDocumentListShared } from './documents-fetch';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetDocumentListInflightForTests();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchDocumentListShared', () => {
  test('coalesces concurrent callers onto a single in-flight request', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      calls += 1;
      await gate;
      return jsonResponse({ documents: [{ kind: 'document' }] });
    }) as unknown as typeof fetch;

    const a = fetchDocumentListShared();
    const b = fetchDocumentListShared();
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(calls).toBe(1);
    expect(ra.ok).toBe(true);
    expect(ra).toEqual(rb);
    expect((ra.body as { documents: unknown[] }).documents).toHaveLength(1);
  });

  test('refetches after the prior request settles (single-flight, not a cache)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ documents: [] });
    }) as unknown as typeof fetch;

    await fetchDocumentListShared();
    await fetchDocumentListShared();
    expect(calls).toBe(2);
  });

  test('a rejected request clears the slot so the next call retries', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return jsonResponse({ documents: [] });
    }) as unknown as typeof fetch;

    await expect(fetchDocumentListShared()).rejects.toThrow('network down');
    const result = await fetchDocumentListShared();
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  test('surfaces ok=false and the status for an error response', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'nope' }, 503)) as unknown as typeof fetch;
    const { ok, status, body } = await fetchDocumentListShared();
    expect(ok).toBe(false);
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'nope' });
  });

  test('body is null when the response is not valid JSON', async () => {
    globalThis.fetch = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof fetch;
    const { ok, body } = await fetchDocumentListShared();
    expect(ok).toBe(true);
    expect(body).toBeNull();
  });
});
