import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OutlinePanel } from '@/components/OutlinePanel';
import { PageListProvider } from '@/components/PageListContext';
import { __resetPageListCacheForTests, getPageListCache } from '@/editor/page-list-cache';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { expectKnownBug } from '../../../../test-support/known-bug.vitest.test-helper';
import { stubApiRoutes } from './api-routes.test-helper';
import { renderWithI18n } from './render-with-i18n.test-helper';

const DOC_NAME = 'offsite/liveblocks/liveblocks';
const HEADINGS = [
  { level: 1, text: 'Liveblocks', slug: 'liveblocks' },
  { level: 2, text: 'What is it', slug: 'what-is-it' },
  { level: 2, text: 'Comments', slug: 'comments' },
];

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: DOC_NAME }),
}));

let listedPages: string[] = [];

function renderOutline(): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <PageListProvider>
        <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
      </PageListProvider>
    </QueryClientProvider>,
  );
}

function outlineHeadings(view: RenderResult): (string | null)[] {
  const outline = view.queryByRole('navigation', { name: 'Document outline' });
  if (outline === null) return [];
  return within(outline)
    .queryAllByRole('button')
    .map((button) => button.textContent);
}

function headingCount(view: RenderResult): string | null | undefined {
  return view.container.querySelector('[data-slot="panel-count"]')?.textContent;
}

describe('OutlinePanel under the production compiler', () => {
  beforeEach(() => {
    listedPages = [DOC_NAME];
    __resetPageListCacheForTests();
    stubApiRoutes({
      '/api/pages': () =>
        Response.json({
          pages: listedPages.map((docName) => ({
            docName,
            title: 'Liveblocks',
            size: 1,
            modified: '2026-10-05T00:00:00.000Z',
          })),
        }),
      '/api/documents': () => Response.json({ documents: [] }),
      '/api/page-headings': () => Response.json({ docName: DOC_NAME, headings: HEADINGS }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('after a successful load the outline lists the three returned headings and counts them', async () => {
    const view = renderOutline();
    await view.findByRole('button', { name: 'Liveblocks' });

    expect(outlineHeadings(view)).toEqual(['Liveblocks', 'What is it', 'Comments']);
    expect(headingCount(view)).toBe('3');
  });

  test('a document that leaves the page list after a successful load stops serving its headings and says it moved', {
    tags: ['known-bug'],
    meta: {
      issue: 'https://github.com/inkeep/agents-private/issues/5611',
      owner: 'get-main-green',
      until: '2026-12-31',
    },
  }, async () => {
    const view = renderOutline();
    await view.findByRole('button', { name: 'Liveblocks' });

    listedPages = [];
    emitDocumentsChanged(['files']);
    await vi.waitFor(
      () => {
        expect(getPageListCache()?.pages.has(DOC_NAME)).toBe(false);
      },
      { timeout: 5_000 },
    );

    await expectKnownBug(/expected undefined to be 'This page is no longer at this path\.'/, () => {
      expect(view.queryByRole('status')?.textContent).toBe('This page is no longer at this path.');
    });
    await expectKnownBug(
      /expected \[ 'Liveblocks', 'What is it', …\(1\) \] to deeply equal \[\]/,
      () => {
        expect(outlineHeadings(view)).toEqual([]);
      },
    );
  });
});
