/**
 * Behavioral tests for the unified-audit client: `runValidationAudit` hits
 * `GET /api/audit` with the right scoping query, and `useDocLinkFindings`
 * serves the doc's links-plane findings via the SAME endpoint (canonical
 * predicate — no divergent doc-scope determination), refreshing on the CC1
 * `backlinks`, `local-targets`, and file-inventory push relays.
 */

import type { ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { runValidationAudit, useDocLinkFindings } from './validation-audit-client';

const origFetch = globalThis.fetch;
let fetchUrls: string[] = [];
let fetchBody: ValidationAuditResponse = {
  files: [],
  fileCount: 0,
  errorCount: 0,
  warningCount: 0,
  warnings: [],
};

beforeEach(() => {
  fetchUrls = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    fetchUrls.push(String(url));
    return new Response(JSON.stringify(fetchBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  cleanup();
});

const deadLink = {
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } },
  severity: 'error' as const,
  source: 'links',
  code: 'dead-link',
  message: 'Link target "ghost" does not resolve to an existing document.',
};

const lintFinding = {
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
  severity: 'warning' as const,
  source: 'markdownlint',
  code: 'MD010',
  message: 'Hard tabs',
};

describe('runValidationAudit', () => {
  test('project scope hits the bare endpoint; doc scope uses the doc param', async () => {
    await runValidationAudit();
    await runValidationAudit({ kind: 'doc', docName: 'guides/intro' });
    await runValidationAudit({ kind: 'path', path: 'guides/' });
    expect(fetchUrls).toEqual([
      '/api/audit',
      '/api/audit?doc=guides%2Fintro',
      '/api/audit?path=guides%2F',
    ]);
  });

  test('returns null on a malformed response body', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ nonsense: true }), { status: 200 })) as typeof fetch;
    expect(await runValidationAudit()).toBeNull();
  });
});

describe('useDocLinkFindings', () => {
  test('serves only links-source findings for the doc, keyed off the scoped audit', async () => {
    fetchBody = {
      files: [{ file: 'notes.md', diagnostics: [lintFinding, deadLink] }],
      fileCount: 1,
      errorCount: 1,
      warningCount: 1,
      warnings: [],
    };
    const { result } = renderHook(() => useDocLinkFindings('notes'));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.findings).toHaveLength(1);
    expect(result.current.findings[0]?.code).toBe('dead-link');
    expect(fetchUrls).toEqual(['/api/audit?doc=notes']);
  });

  test('refreshes on the CC1 backlinks relay and clears healed findings', async () => {
    fetchBody = {
      files: [{ file: 'notes.md', diagnostics: [deadLink] }],
      fileCount: 1,
      errorCount: 1,
      warningCount: 0,
      warnings: [],
    };
    const { result } = renderHook(() => useDocLinkFindings('notes'));
    await waitFor(() => expect(result.current.findings).toHaveLength(1));

    // The link target gets created elsewhere — the index push heals this doc.
    fetchBody = { files: [], fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] };
    act(() => emitDocumentsChanged(['backlinks']));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.findings).toHaveLength(0);
    expect(fetchUrls).toEqual(['/api/audit?doc=notes', '/api/audit?doc=notes']);

    act(() => emitDocumentsChanged(['local-targets']));
    await waitFor(() => expect(fetchUrls).toHaveLength(3));

    // The broad inventory signal is a correctness backstop for existence
    // changes whose narrower local-target generation signal is missed.
    act(() => emitDocumentsChanged(['files']));
    await waitFor(() => expect(fetchUrls).toHaveLength(4));

    // Unrelated channels do not refetch.
    act(() => emitDocumentsChanged(['tags']));
    expect(fetchUrls).toHaveLength(4);
  });

  test('null docName serves no findings and never fetches', () => {
    const { result } = renderHook(() => useDocLinkFindings(null));
    expect(result.current).toEqual({ status: 'idle', findings: [] });
    expect(fetchUrls).toEqual([]);
  });

  test('switching docs resets findings before the new fetch resolves (no stale carryover)', async () => {
    fetchBody = {
      files: [{ file: 'a.md', diagnostics: [deadLink] }],
      fileCount: 1,
      errorCount: 1,
      warningCount: 0,
      warnings: [],
    };
    const renders: Array<{ doc: string; state: ReturnType<typeof useDocLinkFindings> }> = [];
    const { result, rerender } = renderHook(
      ({ doc }: { doc: string }) => {
        const state = useDocLinkFindings(doc);
        renders.push({ doc, state });
        return state;
      },
      { initialProps: { doc: 'a' } },
    );
    await waitFor(() => expect(result.current.findings).toHaveLength(1));

    // Park the next fetch unresolved: doc B's findings must read EMPTY during
    // the in-flight window, never doc A's stale list (which would render A's
    // dead links — and store counts — under B's name).
    let resolveNext: (r: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((r) => (resolveNext = r))) as typeof fetch;
    rerender({ doc: 'b' });
    expect(renders.find((render) => render.doc === 'b')?.state).toEqual({
      status: 'loading',
      findings: [],
    });
    expect(result.current).toEqual({ status: 'loading', findings: [] });

    resolveNext(
      new Response(
        JSON.stringify({ files: [], fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await waitFor(() => expect(result.current).toEqual({ status: 'loaded', findings: [] }));
  });

  test('an invalidation during a walk queues one post-settle refresh', async () => {
    let resolveFirst: (response: Response) => void = () => {};
    let resolveSecond: (response: Response) => void = () => {};
    let call = 0;
    globalThis.fetch = ((url: RequestInfo | URL) => {
      fetchUrls.push(String(url));
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => (resolveFirst = resolve));
      return new Promise<Response>((resolve) => (resolveSecond = resolve));
    }) as typeof fetch;

    const { result } = renderHook(() => useDocLinkFindings('notes'));
    act(() => {
      emitDocumentsChanged(['local-targets']);
      emitDocumentsChanged(['backlinks']);
    });
    expect(fetchUrls).toHaveLength(1);

    resolveFirst(
      new Response(
        JSON.stringify({
          files: [{ file: 'notes.md', diagnostics: [deadLink] }],
          fileCount: 1,
          errorCount: 1,
          warningCount: 0,
          warnings: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await waitFor(() => expect(fetchUrls).toHaveLength(2));
    expect(result.current).toEqual({ status: 'loading', findings: [] });

    resolveSecond(
      new Response(
        JSON.stringify({ files: [], fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.findings).toEqual([]);
  });

  test('a failed refresh preserves findings and reports failure', async () => {
    fetchBody = {
      files: [{ file: 'notes.md', diagnostics: [deadLink] }],
      fileCount: 1,
      errorCount: 1,
      warningCount: 0,
      warnings: [],
    };
    const { result } = renderHook(() => useDocLinkFindings('notes'));
    await waitFor(() => expect(result.current.findings).toHaveLength(1));

    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    act(() => emitDocumentsChanged(['local-targets']));
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.findings).toHaveLength(1);
  });
});
