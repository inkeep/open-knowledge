/**
 * What destination the wiki-link prop panel reports, and how it labels it.
 *
 * The panel and the chip must agree: whatever the chip navigates to on click is
 * what the panel's destination link points at. They resolve independently, so a
 * document whose filename carries a dot (`notes/acp.daemon`, written
 * `[[acp.daemon]]`) is the case where a syntactic doc-vs-asset split shows up as
 * the panel reading "Asset" and offering an asset href for a document sitting
 * one folder over.
 *
 * The Radix-Popover-based `InteractionPropPanel` is mocked to a passthrough so
 * the panel body renders inline. `usePageList` is mocked at the data boundary
 * with a real corpus — the panel's own resolution runs for real.
 */

import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildPagesByBasenameIndex, buildPagesBySlugIndex } from '../page-list-cache';
import { toWikiLinkSlug } from './wiki-link-helpers';

/** Dotted document, dot-free control in the same folder, and a real asset. */
const PAGES = new Set(['index', 'notes/acp.daemon', 'notes/roadmap']);
const ASSET_PATHS = new Set(['files/meeting.pdf']);

vi.doMock('../link-preview/use-internal-doc-preview.ts', () => ({
  useInternalDocPreview: () => null,
}));

vi.doMock('../../components/InteractionPropPanel', () => ({
  InteractionPropPanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="prop-panel">{children}</div>
  ),
}));

vi.doMock('../../components/PageListContext', () => ({
  usePageList: () => ({
    addPage: () => {},
    assetPaths: ASSET_PATHS,
    filePaths: new Set<string>(),
    folderPaths: new Set<string>(['notes', 'files']),
    pages: PAGES,
    pagesBySlug: buildPagesBySlugIndex(PAGES, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(PAGES, toWikiLinkSlug),
    pageTitles: new Map<string, string>(),
    pageMeta: new Map(),
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));

afterEach(cleanup);

/**
 * Minimal editor + getPos stub. The panel reads node attrs and `editor.view.dom`
 * at render; state mutations only run in callbacks this test never fires.
 */
function makeEditor(target: string): Editor {
  const node = { attrs: { target, alias: null, anchor: null }, nodeSize: 1 };
  return {
    state: { doc: { nodeAt: () => node } },
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
}

async function renderPanel(target: string) {
  const { WikiLinkPropPanel } = await import('./WikiLinkPropPanel');
  const { container } = render(
    <TooltipProvider>
      <WikiLinkPropPanel
        editor={makeEditor(target)}
        getPos={() => 1}
        onClose={() => {}}
        onNavigate={() => true}
      />
    </TooltipProvider>,
  );
  const destination = container.querySelector('[data-slot="wiki-link-prop-panel-text"]');
  return {
    container,
    href: destination?.getAttribute('href') ?? null,
    ariaLabel: container.querySelector('[data-testid="prop-panel"]')?.getAttribute('aria-label'),
  };
}

describe('WikiLinkPropPanel destination', () => {
  test('a target naming a dotted-filename document points at that document', async () => {
    const { href } = await renderPanel('acp.daemon');

    expect(href).toBe('#/notes/acp.daemon');
  });

  test('a dot-free bare name still points at its subfolder document', async () => {
    const { href } = await renderPanel('roadmap');

    expect(href).toBe('#/notes/roadmap');
  });

  test('a target naming a real asset still points at the asset viewer', async () => {
    const { href } = await renderPanel('meeting.pdf');

    expect(href).toBe('#/__asset__/files/meeting.pdf');
  });

  test('a target naming nothing at all still points at the asset viewer', async () => {
    const { href } = await renderPanel('absent.pdf');

    expect(href).toBe('#/__asset__/absent.pdf');
  });
});
