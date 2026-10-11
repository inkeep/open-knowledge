import type { HeadingEntry } from '@inkeep/open-knowledge-core/utils/slug';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, type RenderResult, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { OutlinePanel } from '@/components/OutlinePanel';
import { PageListProvider } from '@/components/PageListContext';
import { __resetPageListCacheForTests } from '@/editor/page-list-cache';
import { stubApiRoutes } from './api-routes.test-helper';
import { renderWithI18n } from './render-with-i18n.test-helper';

type DocName = 'alpha' | 'beta';

const INITIAL_HEADINGS: HeadingEntry[] = [
  { level: 1, text: 'Alpha launch', slug: 'alpha-launch' },
  { level: 2, text: 'Beta section', slug: 'beta-section' },
  { level: 3, text: 'Gamma detail', slug: 'gamma-detail' },
];
const FRESH_HEADINGS: HeadingEntry[] = [
  { level: 1, text: 'Fresh destination', slug: 'fresh-destination' },
  { level: 2, text: 'New section', slug: 'new-section' },
];
const OTHER_HEADINGS: HeadingEntry[] = [
  { level: 1, text: 'Other document', slug: 'other-document' },
];

let client: QueryClient;
let providers: Record<DocName, { document: Y.Doc }>;
let headingResponses: Record<DocName, HeadingEntry[]>;
let selection: { activeDocName: DocName; activeProvider: { document: Y.Doc } };

vi.mock('@/editor/DocumentContext', () => ({ useDocumentContext: () => selection }));

function outlineTree(docName: DocName) {
  return (
    <QueryClientProvider client={client}>
      <PageListProvider>
        <OutlinePanel docName={docName} isSourceMode={false} />
      </PageListProvider>
    </QueryClientProvider>
  );
}

function outlineResult(view: RenderResult) {
  const outline = view.queryByRole('navigation', { name: 'Document outline' });
  return {
    headings:
      outline === null
        ? []
        : within(outline)
            .queryAllByRole('button')
            .map((button) => button.textContent),
    count: view.container.querySelector('[data-slot="panel-count"]')?.textContent,
    empty: view.queryByText('No headings yet.') !== null,
  };
}

function selectDocument(view: RenderResult, docName: DocName): void {
  selection = { activeDocName: docName, activeProvider: providers[docName] };
  view.rerender(outlineTree(docName));
}

async function replaceHeadings(headings: HeadingEntry[]): Promise<void> {
  headingResponses.alpha = headings;
  const doc = providers.alpha.document;
  const source = doc.getText('source');
  await act(async () => {
    doc.transact(() => {
      source.delete(0, source.length);
      source.insert(
        0,
        headings.map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`).join('\n\n') ||
          'A document without headings.',
      );
    });
  });
}

async function renderThenSelectOtherDocument(): Promise<RenderResult> {
  const view = renderWithI18n(outlineTree('alpha'));
  await expect
    .poll(() => outlineResult(view))
    .toEqual({
      headings: ['Alpha launch', 'Beta section', 'Gamma detail'],
      count: '3',
      empty: false,
    });
  selectDocument(view, 'beta');
  await expect
    .poll(() => outlineResult(view))
    .toEqual({
      headings: ['Other document'],
      count: '1',
      empty: false,
    });
  return view;
}

describe('OutlinePanel document freshness', () => {
  beforeEach(() => {
    __resetPageListCacheForTests();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    providers = { alpha: { document: new Y.Doc() }, beta: { document: new Y.Doc() } };
    providers.alpha.document
      .getText('source')
      .insert(0, '# Alpha launch\n\n## Beta section\n\n### Gamma detail');
    providers.beta.document.getText('source').insert(0, '# Other document');
    selection = { activeDocName: 'alpha', activeProvider: providers.alpha };
    headingResponses = { alpha: INITIAL_HEADINGS, beta: OTHER_HEADINGS };
    stubApiRoutes({
      '/api/pages': () =>
        Response.json({
          pages: ['alpha', 'beta'].map((docName) => ({
            docName,
            title: docName,
            size: 1,
            modified: '2026-10-11T00:00:00Z',
          })),
        }),
      '/api/documents': () => Response.json({ documents: [] }),
      '/api/page-headings': (url) => {
        const docName = url.searchParams.get('docName');
        if (docName !== 'alpha' && docName !== 'beta') {
          throw new Error(`Unexpected headings document: ${docName}`);
        }
        return Response.json({ docName, headings: headingResponses[docName] });
      },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
    providers.alpha.document.destroy();
    providers.beta.document.destroy();
    vi.unstubAllGlobals();
  });

  test('refreshes headings and count after an inactive document is selected again', async () => {
    const view = await renderThenSelectOtherDocument();
    await replaceHeadings(FRESH_HEADINGS);
    selectDocument(view, 'alpha');

    await expect
      .poll(() => outlineResult(view))
      .toEqual({
        headings: ['Fresh destination', 'New section'],
        count: '2',
        empty: false,
      });
  });

  test('shows the empty state after all headings are removed from an inactive document', async () => {
    const view = await renderThenSelectOtherDocument();
    await replaceHeadings([]);
    selectDocument(view, 'alpha');

    await expect
      .poll(() => outlineResult(view))
      .toEqual({
        headings: [],
        count: '0',
        empty: true,
      });
  });

  test('refreshes headings and count when the active document is edited', async () => {
    const view = renderWithI18n(outlineTree('alpha'));
    await expect
      .poll(() => outlineResult(view))
      .toEqual({
        headings: ['Alpha launch', 'Beta section', 'Gamma detail'],
        count: '3',
        empty: false,
      });
    await replaceHeadings(FRESH_HEADINGS);

    await expect
      .poll(() => outlineResult(view))
      .toEqual({
        headings: ['Fresh destination', 'New section'],
        count: '2',
        empty: false,
      });
  });

  test('refreshes headings when the outline is reopened for the same document', async () => {
    const view = renderWithI18n(outlineTree('alpha'));
    await expect
      .poll(() => outlineResult(view))
      .toEqual({
        headings: ['Alpha launch', 'Beta section', 'Gamma detail'],
        count: '3',
        empty: false,
      });
    view.unmount();
    await replaceHeadings(FRESH_HEADINGS);
    const reopenedView = renderWithI18n(outlineTree('alpha'));

    await expect
      .poll(() => outlineResult(reopenedView))
      .toEqual({
        headings: ['Fresh destination', 'New section'],
        count: '2',
        empty: false,
      });
  });
});
