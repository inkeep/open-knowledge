import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computeLinkResolutionState } from '@/editor/extensions/link-resolution';
import { __resetPageListCacheForTests, getPageListCache } from '@/editor/page-list-cache';
import { __resetDocumentListInflightForTests } from '@/lib/documents-fetch';
import { resolveNavigationTarget } from './navigation-targets';

vi.doMock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

const NFD_DOC = 'People/René';
const NFC_DOC = 'People/René';
const NFD_FOLDER = 'Archivé';
const NFC_FOLDER = 'Archivé';

let originalFetch: typeof globalThis.fetch;

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  __resetPageListCacheForTests();
  __resetDocumentListInflightForTests();
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pages')) {
      return Promise.resolve(
        jsonRes({
          pages: [NFD_DOC, 'README'].map((docName) => ({
            docName,
            title: docName,
            size: 1,
            modified: '2026-01-01T00:00:00.000Z',
          })),
        }),
      );
    }
    if (url.includes('/api/documents')) {
      return Promise.resolve(jsonRes({ documents: [{ kind: 'folder', path: NFD_FOLDER }] }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  __resetPageListCacheForTests();
});

function NavigationProbe() {
  const { loading, pages, folderPaths } = usePageList();
  if (loading) return null;
  return (
    <div>
      <output data-testid="doc-target">
        {JSON.stringify(resolveNavigationTarget(NFC_DOC, { pages, folderPaths }))}
      </output>
      <output data-testid="folder-target">
        {JSON.stringify(resolveNavigationTarget(NFC_FOLDER, { pages, folderPaths }))}
      </output>
    </div>
  );
}

const { PageListProvider, usePageList } = await import('./PageListContext');

describe('PageListContext resolves canonically equivalent link targets (PRD-8896)', () => {
  test('an NFC link to an NFD-named document or folder resolves and navigates to the stored name', async () => {
    render(
      <PageListProvider>
        <NavigationProbe />
      </PageListProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('doc-target').textContent).not.toBe('');
      expect(getPageListCache()?.pages.has(NFD_DOC)).toBe(true);
    });

    const cache = getPageListCache();
    expect(computeLinkResolutionState(`./${NFC_DOC}.md`, 'README', cache)).toBe('resolved');
    expect(computeLinkResolutionState(`./${NFC_DOC}`, 'README', cache)).toBe('resolved');
    expect(computeLinkResolutionState(`./${NFC_FOLDER}`, 'README', cache)).toBe('folder');

    expect(JSON.parse(screen.getByTestId('doc-target').textContent ?? '')).toEqual({
      kind: 'doc',
      target: NFD_DOC,
      docName: NFD_DOC,
    });
    expect(JSON.parse(screen.getByTestId('folder-target').textContent ?? '')).toEqual({
      kind: 'folder',
      target: NFC_FOLDER,
      folderPath: NFD_FOLDER,
    });
  });
});
