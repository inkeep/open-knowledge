import type { ForwardLinkLocalTarget, ForwardLinksSuccess } from '@inkeep/open-knowledge-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { LintNavDetail } from './ProblemsPanel';

const linguiMacroMock = {
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: renderLinguiTemplate }),
};
vi.doMock('@lingui/core/macro', () => linguiMacroMock);
vi.doMock('@lingui/react/macro', () => linguiMacroMock);

const LINT_NAV_EVENT = 'open-knowledge:lint-nav';
vi.doMock('@/components/ProblemsPanel', () => ({ LINT_NAV_EVENT }));

const rememberedIntents: { docName: string; detail: LintNavDetail }[] = [];
vi.doMock('@/editor/source-editor-navigation', () => ({
  rememberPendingSourceNavigation: (
    docName: string,
    intent: { kind: string; detail: LintNavDetail },
  ) => {
    rememberedIntents.push({ docName, detail: intent.detail });
  },
}));

vi.doMock('@/components/PageListContext', () => ({
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

const { LinksPanel } = await import('./LinksPanel');

type FetchResult = { ok: boolean; status: number; body: unknown };

let forwardLinksResult: FetchResult;
let backlinksResult: FetchResult;
const navEvents: LintNavDetail[] = [];

function onNav(e: Event) {
  navEvents.push((e as CustomEvent<LintNavDetail>).detail);
}

function fakeResponse({ ok, status, body }: FetchResult): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function localTarget(overrides: Partial<ForwardLinkLocalTarget> = {}): ForwardLinkLocalTarget {
  return {
    role: 'link',
    sourceForm: 'markdown-inline',
    targetKind: 'file',
    href: 'assets/data.csv',
    resolvedTarget: 'assets/data.csv',
    status: 'exact',
    reason: null,
    resolutionMethod: 'source-relative',
    fallbackTarget: null,
    range: { start: 10, end: 40 },
    line: 3,
    column: 5,
    definition: null,
    ...overrides,
  };
}

function forwardLinksBody(over: Partial<ForwardLinksSuccess> = {}): ForwardLinksSuccess {
  return { docName: 'notes', forwardLinks: [], localTargets: [], ...over };
}

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rememberedIntents.length = 0;
  navEvents.length = 0;
  window.addEventListener(LINT_NAV_EVENT, onNav);
  forwardLinksResult = { ok: true, status: 200, body: forwardLinksBody() };
  backlinksResult = { ok: true, status: 200, body: { docName: 'notes', backlinks: [] } };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/forward-links')) return fakeResponse(forwardLinksResult);
    if (url.startsWith('/api/backlinks')) return fakeResponse(backlinksResult);
    return fakeResponse({ ok: false, status: 404, body: null });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  window.removeEventListener(LINT_NAV_EVENT, onNav);
  cleanup();
  vi.restoreAllMocks();
});

describe('LinksPanel Local files section', () => {
  test('renders local files apart from Outgoing and Backlinks', async () => {
    forwardLinksResult.body = forwardLinksBody({
      forwardLinks: [
        {
          kind: 'external',
          url: 'https://example.com',
          title: 'https://example.com',
          snippet: null,
        },
      ],
      localTargets: [
        localTarget({ href: 'assets/data.csv', resolvedTarget: 'assets/data.csv' }),
        localTarget({ role: 'image', href: 'assets/logo.png', resolvedTarget: 'assets/logo.png' }),
      ],
    });
    render(<LinksPanel docName="notes" />);

    expect(await screen.findByText('Local files')).toBeTruthy();
    expect(screen.getByText('Outgoing')).toBeTruthy();
    expect(screen.getByText('Backlinks')).toBeTruthy();

    expect(
      await screen.findByRole('button', { name: 'File assets/data.csv. Go to reference.' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Image assets/logo.png. Go to reference.' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /example\.com/ })).toBeTruthy();
  });

  test('identifies file vs image and shows a non-color missing status as text', async () => {
    forwardLinksResult.body = forwardLinksBody({
      localTargets: [
        localTarget({
          role: 'image',
          href: 'assets/missing.png',
          resolvedTarget: 'assets/missing.png',
          status: 'missing',
          reason: 'no-such-file',
        }),
      ],
    });
    render(<LinksPanel docName="notes" />);

    expect(await screen.findByText('Missing')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Missing image assets/missing.png. Go to reference.',
      }),
    ).toBeTruthy();
  });

  test('a missing row navigates to its authored occurrence and offers no recovery action', async () => {
    forwardLinksResult.body = forwardLinksBody({
      localTargets: [
        localTarget({
          href: 'assets/missing.csv',
          resolvedTarget: 'assets/missing.csv',
          status: 'missing',
          reason: 'no-such-file',
          line: 7,
          column: 2,
        }),
      ],
    });
    render(<LinksPanel docName="notes" />);

    const row = await screen.findByRole('button', {
      name: 'Missing file assets/missing.csv. Go to reference.',
    });
    expect(row.tagName).toBe('BUTTON');
    fireEvent.click(row);

    expect(navEvents).toEqual([{ docName: 'notes', line: 8, column: 3, source: 'links' }]);
    expect(rememberedIntents).toEqual([
      { docName: 'notes', detail: { docName: 'notes', line: 8, column: 3, source: 'links' } },
    ]);

    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.queryByText(/create/i)).toBeNull();
  });

  test('repeated references to one file are separate, individually navigable rows', async () => {
    forwardLinksResult.body = forwardLinksBody({
      localTargets: [
        localTarget({
          href: 'assets/shared.csv',
          resolvedTarget: 'assets/shared.csv',
          status: 'missing',
          reason: 'no-such-file',
          range: { start: 10, end: 30 },
          line: 2,
          column: 1,
        }),
        localTarget({
          href: 'assets/shared.csv',
          resolvedTarget: 'assets/shared.csv',
          status: 'missing',
          reason: 'no-such-file',
          range: { start: 80, end: 100 },
          line: 9,
          column: 4,
        }),
      ],
    });
    render(<LinksPanel docName="notes" />);

    const rows = await screen.findAllByRole('button', {
      name: 'Missing file assets/shared.csv. Go to reference.',
    });
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(navEvents.map((e) => `${e.line}:${e.column}`)).toEqual(['3:2', '10:5']);
  });

  test('shows an empty state when the document references no local files', async () => {
    forwardLinksResult.body = forwardLinksBody({ localTargets: [] });
    render(<LinksPanel docName="notes" />);
    expect(await screen.findByText('This page references no local files or images.')).toBeTruthy();
  });

  test('surfaces a transport failure in the section', async () => {
    forwardLinksResult = {
      ok: false,
      status: 503,
      body: {
        type: 'urn:ok:error:derived-index-unavailable',
        title: 'Local file index is not ready',
        status: 503,
      },
    };
    render(<LinksPanel docName="notes" />);
    expect((await screen.findAllByText('Local file index is not ready')).length).toBeGreaterThan(0);
  });

  test('a failed section drops its count while a healthy sibling keeps one', async () => {
    backlinksResult = {
      ok: false,
      status: 503,
      body: {
        type: 'urn:ok:error:backlink-index-not-configured',
        title: 'Backlink index is not ready',
        status: 503,
      },
    };
    render(<LinksPanel docName="notes" />);
    await screen.findByText('Backlink index is not ready');

    const countFor = (title: string) =>
      screen.getByText(title).closest('button')?.querySelector('[data-slot="panel-count"]') ?? null;
    expect(countFor('Backlinks')).toBeNull();
    expect(countFor('Outgoing')?.textContent).toBe('0');
  });

  test('a section whose fetch failed shows no count beside its error', async () => {
    forwardLinksResult = {
      ok: false,
      status: 503,
      body: {
        type: 'urn:ok:error:derived-index-unavailable',
        title: 'Local file index is not ready',
        status: 503,
      },
    };
    render(<LinksPanel docName="notes" />);
    await screen.findAllByText('Local file index is not ready');
    await screen.findByText('No pages link here yet.');

    const countFor = (title: string) =>
      screen.getByText(title).closest('button')?.querySelector('[data-slot="panel-count"]') ?? null;
    expect(countFor('Backlinks')?.textContent).toBe('0');
    expect(countFor('Outgoing')).toBeNull();
    expect(countFor('Local files')).toBeNull();
  });

  test('a partial response (no localTargets) is called out without hiding document relationships', async () => {
    forwardLinksResult.body = {
      docName: 'notes',
      forwardLinks: [
        {
          kind: 'external',
          url: 'https://example.com',
          title: 'https://example.com',
          snippet: null,
        },
      ],
    };
    render(<LinksPanel docName="notes" />);

    expect(await screen.findByText("Local file details aren't available yet.")).toBeTruthy();
    expect(screen.getByRole('link', { name: /example\.com/ })).toBeTruthy();
  });

  test('a resolved row carries no status badge and stays keyboard-focusable', async () => {
    forwardLinksResult.body = forwardLinksBody({
      localTargets: [localTarget({ href: 'assets/ok.csv', resolvedTarget: 'assets/ok.csv' })],
    });
    render(<LinksPanel docName="notes" />);

    const row = await screen.findByRole('button', {
      name: 'File assets/ok.csv. Go to reference.',
    });
    expect(row.tagName).toBe('BUTTON');
    expect(row.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('Missing')).toBeNull();
    expect(screen.queryByText('Unresolvable')).toBeNull();
  });
});
