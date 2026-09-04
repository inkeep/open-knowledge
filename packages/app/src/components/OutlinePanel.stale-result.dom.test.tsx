// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const DOC_NAME = 'offsite/liveblocks/liveblocks';
const HEADINGS = [
  { level: 1, text: 'Liveblocks', slug: 'liveblocks' },
  { level: 2, text: 'What is it', slug: 'what-is-it' },
  { level: 2, text: 'Comments', slug: 'comments' },
];
const REPLACEMENT_HEADINGS = [{ level: 1, text: 'Restored', slug: 'restored' }];

let pageSet = new Set<string>([DOC_NAME]);
let headingsResponse = HEADINGS;
let respondNotFound = false;
let pageListError: string | null = null;

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
}));
vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));
vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ loading: false, pages: pageSet, error: pageListError }),
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: DOC_NAME }),
}));
vi.doMock('@/hooks/useActiveHeading', () => ({
  useActiveHeading: () => null,
}));

const { OutlinePanel } = await import('./OutlinePanel');

const HEADINGS_KEY = ['page-headings', DOC_NAME];

function countBadge(): HTMLElement | null {
  return document.querySelector('[data-slot="panel-count"]');
}

function errorText(): string | null {
  return document.querySelector('[data-slot="panel-error"]')?.textContent ?? null;
}

describe('OutlinePanel does not present a result it can no longer refresh', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    pageSet = new Set<string>([DOC_NAME]);
    headingsResponse = HEADINGS;
    respondNotFound = false;
    pageListError = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).startsWith('/api/page-headings')) {
        return Response.json({}, { status: 404 });
      }
      if (respondNotFound) {
        return Response.json(
          { type: 'urn:ok:error:doc-not-found', title: 'Page not found.', status: 404 },
          { status: 404 },
        );
      }
      return Response.json({ docName: DOC_NAME, headings: headingsResponse });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }

  async function renderPanel(client: QueryClient) {
    const view = render(
      <QueryClientProvider client={client}>
        <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Liveblocks' });
    return view;
  }

  test('a failed refetch clears the heading count instead of pairing it with the error', async () => {
    const client = makeClient();
    await renderPanel(client);
    expect(countBadge()?.textContent).toBe('3');

    respondNotFound = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: HEADINGS_KEY }).catch(() => {});
    });

    await screen.findByText('Page not found.');
    expect(errorText()).toBe('Page not found.');
    expect(countBadge()).toBeNull();
  });

  test('a page list that failed to load is not mistaken for a document that moved', async () => {
    const client = makeClient();
    await renderPanel(client);
    expect(countBadge()?.textContent).toBe('3');

    pageSet = new Set<string>();
    pageListError = 'Failed to load pages';
    const view = render(
      <QueryClientProvider client={client}>
        <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.queryAllByRole('status')).toHaveLength(0);
    });
    view.unmount();
  });

  test('a document that leaves the page list after a successful load stops serving its headings', async () => {
    const client = makeClient();
    const view = await renderPanel(client);
    expect(countBadge()?.textContent).toBe('3');

    pageSet = new Set<string>();
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Liveblocks' })).toBeNull();

    view.unmount();
    pageSet = new Set<string>([DOC_NAME]);
    headingsResponse = REPLACEMENT_HEADINGS;
    const reopened = render(
      <QueryClientProvider client={client}>
        <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Restored' });
    expect(screen.queryByRole('button', { name: 'Liveblocks' })).toBeNull();
    expect(countBadge()?.textContent).toBe('1');
    reopened.unmount();
  });

  test('a docName that leaves the page list drops both the error and the stale count without claiming the document is empty', async () => {
    const client = makeClient();
    const view = await renderPanel(client);

    respondNotFound = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: HEADINGS_KEY }).catch(() => {});
    });
    await screen.findByText('Page not found.');
    expect(errorText()).toBe('Page not found.');

    pageSet = new Set<string>();
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(errorText()).toBeNull();
    });
    expect(countBadge()).toBeNull();
    expect(screen.queryByText('No headings yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liveblocks' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('This page is no longer at this path.');

    view.unmount();
    pageSet = new Set<string>([DOC_NAME]);
    respondNotFound = false;
    headingsResponse = REPLACEMENT_HEADINGS;

    const reopened = render(
      <QueryClientProvider client={client}>
        <OutlinePanel docName={DOC_NAME} isSourceMode={false} />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Restored' });
    expect(errorText()).toBeNull();
    expect(countBadge()?.textContent).toBe('1');
    reopened.unmount();
  });
});
