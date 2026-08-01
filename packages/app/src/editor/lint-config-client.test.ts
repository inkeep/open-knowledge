import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixLintDoc, LINT_FIX_TIMEOUT_MS } from './lint-config-client.ts';

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

describe('fixLintDoc', () => {
  it('surfaces the 503 status and capacity URN so the sweep can retry backpressure', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:too-many-agent-sessions',
            title: 'Too many agent sessions.',
            status: 503,
          }),
          { status: 503, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: 'Too many agent sessions.',
      status: 503,
      problemType: 'urn:ok:error:too-many-agent-sessions',
    });
  });

  it('preserves the server error title and surfaces status and URN for a non-capacity failure', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:disk-divergence',
            title: 'Document changed on disk.',
            status: 409,
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: 'Document changed on disk.',
      status: 409,
      problemType: 'urn:ok:error:disk-divergence',
    });
  });

  it('surfaces the HTTP status even when the error body is unparseable', async () => {
    stubFetch(async () => new Response('<html>oops', { status: 500 }));
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: 500,
      problemType: null,
    });
  });

  it('reports a failure with no URN when a 2xx body fails schema validation', async () => {
    stubFetch(async () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }));
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: 200,
      problemType: null,
    });
  });

  it('reports a failure with no status when the request never reaches the server', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: null,
      problemType: null,
    });
  });

  it('resolves a stalled request to a terminal failure after the fix timeout', async () => {
    vi.useFakeTimers();
    try {
      // A request that never responds on its own — it settles only when the fix
      // timeout aborts it. Without the timeout the project-scope sweep, which can
      // only cancel between files, would hang on this one file indefinitely.
      stubFetch(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );
      const outcome = fixLintDoc('doc-a');
      await vi.advanceTimersByTimeAsync(LINT_FIX_TIMEOUT_MS);
      // Network-throw-shaped: a null status means the sweep will not mistake the
      // aborted request for a retryable capacity refusal.
      await expect(outcome).resolves.toEqual({
        ok: false,
        errorDetail: null,
        status: null,
        problemType: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the parsed result on success', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            file: 'doc-a',
            fixedCount: 2,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: true,
      result: { file: 'doc-a', fixedCount: 2, diagnostics: [], errorCount: 0, warningCount: 0 },
    });
  });
});
