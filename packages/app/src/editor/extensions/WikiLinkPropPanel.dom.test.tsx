import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { InternalDocPreview } from '../link-preview/internal-doc-preview.ts';

const RESOLVED_DOC = 'guides/install';

const previewHarness: { value: InternalDocPreview } = {
  value: {
    docName: RESOLVED_DOC,
    title: 'Install guide',
    folderPath: 'guides',
    lastEditedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    excerpt: 'Install the CLI and run ok start to boot the server.',
  },
};

vi.doMock('../link-preview/use-internal-doc-preview.ts', () => ({
  useInternalDocPreview: ({ docName }: { docName: string | null }) =>
    docName ? previewHarness.value : null,
}));

vi.doMock('../../components/InteractionPropPanel', () => ({
  InteractionPropPanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="prop-panel">{children}</div>
  ),
}));

let createdDocName = 'created/doc';
vi.doMock('../../lib/create-page', () => ({
  createPageFromSeedAndUpdate: async (
    _seed: unknown,
    options: { addPage: (d: string) => void; onCreated: (d: string) => void },
  ) => {
    options.addPage(createdDocName);
    options.onCreated(createdDocName);
    return { docName: createdDocName };
  },
}));

vi.doMock('../../components/PageListContext', () => ({
  usePageList: () => ({
    addPage: () => {},
    assetPaths: new Set<string>(),
    filePaths: new Set<string>(),
    folderPaths: new Set<string>(['guides']),
    pages: new Set<string>([RESOLVED_DOC]),
    pagesBySlug: new Map<string, string>(),
    pagesByBasename: new Map<string, string>(),
    pageTitles: new Map<string, string>([[RESOLVED_DOC, 'Install guide']]),
    pageMeta: new Map(),
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));

afterEach(cleanup);

function makeEditor(target: string): Editor {
  const node = { attrs: { target, alias: null, anchor: null }, nodeSize: 1 };
  return {
    state: { doc: { nodeAt: () => node } },
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
}

async function renderPanel(target: string) {
  const { WikiLinkPropPanel } = await import('./WikiLinkPropPanel');
  return render(
    <TooltipProvider>
      <WikiLinkPropPanel
        editor={makeEditor(target)}
        getPos={() => 1}
        onClose={() => {}}
        onNavigate={() => true}
      />
    </TooltipProvider>,
  );
}

const { docNameFromHash } = await import('@/lib/doc-hash');

function card(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="internal-doc-preview-card"]');
}

describe('WikiLinkPropPanel — resolved doc renders the doc card', () => {
  test('renders title, folder, and excerpt with an unavailable field omitted', async () => {
    const { container } = await renderPanel(RESOLVED_DOC);

    expect(card(container)).toBeTruthy();
    expect(screen.getByText('Install guide')).toBeTruthy();
    expect(
      container.querySelector('[data-slot="internal-doc-preview-folder"]')?.textContent,
    ).toContain('guides');
    expect(
      container.querySelector('[data-slot="internal-doc-preview-excerpt"]')?.textContent,
    ).toContain('Install the CLI');
    expect(container.querySelector('[data-slot="internal-doc-preview-tags"]')).toBeNull();
    const meta = container.querySelector('[data-slot="internal-doc-preview-meta"]');
    expect(meta?.textContent ?? '').not.toContain('backlink');
  });
});

describe('WikiLinkPropPanel — unresolved target keeps create-page, no card', () => {
  test('an unknown target shows the create-page action and renders no doc card', async () => {
    const { container } = await renderPanel('ghost/missing');

    expect(card(container)).toBeNull();
    expect(container.querySelector('[data-slot="wiki-link-prop-panel-create"]')).toBeTruthy();
    expect(screen.getByText('Create page')).toBeTruthy();
  });
});

describe('WikiLinkPropPanel — creating the missing page navigates to it', () => {
  test('a created name carrying a `#` opens that doc, not a truncation of it', async () => {
    createdDocName = 'ghost/# 2 - Tokens';
    window.location.hash = '#/somewhere-else';
    const { container } = await renderPanel('ghost/# 2 - Tokens');

    const create = container.querySelector('[data-slot="wiki-link-prop-panel-create"]');
    expect(create).toBeTruthy();
    fireEvent.click(create as Element);

    await waitFor(() => {
      expect(docNameFromHash(window.location.hash)).toBe('ghost/# 2 - Tokens');
    });
  });
});
