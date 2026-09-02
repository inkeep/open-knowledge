// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const DOC_NAME = 'notes/outline-dispatch';
const HEADINGS = [
  { level: 1, text: 'Alpha', slug: 'alpha' },
  { level: 3, text: 'Beta', slug: 'beta' },
  { level: 2, text: 'Gamma', slug: 'gamma' },
];

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
  usePageList: () => ({ loading: false, pages: new Set<string>([DOC_NAME]) }),
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: DOC_NAME }),
}));
vi.doMock('@/hooks/useActiveHeading', () => ({
  useActiveHeading: () => activeSlug,
}));

const { OUTLINE_NAV_BREADCRUMB, OUTLINE_NAV_DISPATCH_BREADCRUMB, OUTLINE_NAV_EVENT, OutlinePanel } =
  await import('./OutlinePanel');

let activeSlug: string | null = null;
let originalFetch: typeof fetch;

describe('outline dispatch breadcrumb', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    activeSlug = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/page-headings')) {
        return Response.json({ docName: DOC_NAME, headings: HEADINGS });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function breadcrumbs(event: string): Array<Record<string, unknown>> {
    return infoSpy.mock.calls.flatMap(([first]) => {
      if (typeof first !== 'string') return [];
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(first) as Record<string, unknown>;
      } catch {
        return [];
      }
      return parsed.event === event ? [parsed] : [];
    });
  }

  async function renderPanel(isSourceMode = false): Promise<void> {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <OutlinePanel docName={DOC_NAME} isSourceMode={isSourceMode} />
        </QueryClientProvider>,
      );
    });
    await screen.findByRole('button', { name: 'Gamma' });
  }

  test('a click records the ordinal, the list it indexed, and the mode', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    expect(breadcrumbs(OUTLINE_NAV_DISPATCH_BREADCRUMB)).toEqual([
      expect.objectContaining({
        docName: DOC_NAME,
        index: 2,
        mode: 'wysiwyg',
        outlineCount: 3,
        headingLevel: 2,
        activeIndex: -1,
      }),
    ]);
  });

  test('the dispatch is recorded even when no consumer answers it', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(breadcrumbs(OUTLINE_NAV_DISPATCH_BREADCRUMB)).toHaveLength(1);
    expect(breadcrumbs(OUTLINE_NAV_BREADCRUMB)).toEqual([]);
  });

  test('source mode is recorded as such, so a silent consumer is attributable', async () => {
    await renderPanel(true);
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(breadcrumbs(OUTLINE_NAV_DISPATCH_BREADCRUMB)).toEqual([
      expect.objectContaining({ index: 1, mode: 'source', headingLevel: 3 }),
    ]);
  });

  test('the heading depth reaches the line rather than being eaten as a reserved key', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    const [line] = breadcrumbs(OUTLINE_NAV_DISPATCH_BREADCRUMB);
    expect(line.headingLevel).toBe(2);
    expect('droppedReservedFields' in line).toBe(false);
  });

  test('the marker position rides along, so the panel disagreeing with itself is visible', async () => {
    activeSlug = 'gamma';
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(breadcrumbs(OUTLINE_NAV_DISPATCH_BREADCRUMB)).toEqual([
      expect.objectContaining({ index: 0, activeIndex: 2 }),
    ]);
  });

  test('the dispatched event still carries the detail the consumers read', async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OUTLINE_NAV_EVENT, listener);
    try {
      await renderPanel();
      await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    } finally {
      window.removeEventListener(OUTLINE_NAV_EVENT, listener);
    }
    expect(seen).toEqual([{ docName: DOC_NAME, index: 1, slug: 'beta', mode: 'wysiwyg' }]);
  });
});
