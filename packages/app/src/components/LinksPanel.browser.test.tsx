import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithI18n } from '../../tests/foundation/render-with-i18n.test-helper';
import { LinksPanel } from './LinksPanel';

vi.mock('@/components/PageListContext', () => ({
  usePageList: () => ({
    error: null,
    pages: new Set(['notes']),
    folderPaths: new Set<string>(),
    pagesBySlug: new Map<string, string>(),
    pagesByBasename: new Map<string, string>(),
    loading: false,
    addPage: () => {},
  }),
}));

const EXTERNAL_URL = 'https://example.com/docs';
const NON_WEB_URL = 'example-app://open?doc=notes';
let forwardUrl = EXTERNAL_URL;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const settled: { type: string; defaultPrevented: boolean }[] = [];

function recordAndSettle(event: Event): void {
  settled.push({ type: event.type, defaultPrevented: event.defaultPrevented });
  event.preventDefault();
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/forward-links')) {
        return jsonResponse({
          docName: 'notes',
          forwardLinks: [{ kind: 'external', url: forwardUrl, title: forwardUrl, snippet: null }],
          localTargets: [],
        });
      }
      if (url.startsWith('/api/backlinks')) {
        return jsonResponse({ docName: 'notes', backlinks: [] });
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  window.removeEventListener('click', recordAndSettle);
  window.removeEventListener('auxclick', recordAndSettle);
  settled.length = 0;
  forwardUrl = EXTERNAL_URL;
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  cleanup();
  vi.unstubAllGlobals();
});

describe('LinksPanel external rows in the desktop app', () => {
  test('a click or middle-click on an outgoing web link opens it through okDesktop.shell.openExternal', async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    (window as unknown as { okDesktop?: unknown }).okDesktop = { shell: { openExternal } };
    window.addEventListener('click', recordAndSettle);
    window.addEventListener('auxclick', recordAndSettle);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <LinksPanel docName="notes" />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const link = await screen.findByRole('link', { name: /example\.com\/docs/ });

    link.click();
    link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

    expect(openExternal.mock.calls).toEqual([[EXTERNAL_URL], [EXTERNAL_URL]]);
    expect(settled).toEqual([
      { type: 'click', defaultPrevented: true },
      { type: 'auxclick', defaultPrevented: true },
    ]);
  });

  test('a click or middle-click on an outgoing non-web link opens nothing and cancels the anchor', async () => {
    forwardUrl = NON_WEB_URL;
    const openExternal = vi.fn(async (_url: string) => {});
    (window as unknown as { okDesktop?: unknown }).okDesktop = { shell: { openExternal } };
    window.addEventListener('click', recordAndSettle);
    window.addEventListener('auxclick', recordAndSettle);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <LinksPanel docName="notes" />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const link = await screen.findByRole('link', { name: /example-app:\/\/open/ });

    link.click();
    link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

    expect(openExternal).not.toHaveBeenCalled();
    expect(settled).toEqual([
      { type: 'click', defaultPrevented: true },
      { type: 'auxclick', defaultPrevented: true },
    ]);
  });
});
