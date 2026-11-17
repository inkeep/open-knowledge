import { cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { WikiLinkPropPanel } from './WikiLinkPropPanel';

const MAIL_URL = 'mailto:team@example.com';

vi.mock('../link-preview/use-internal-doc-preview.ts', () => ({
  useInternalDocPreview: () => null,
}));

vi.mock('../../components/InteractionPropPanel', () => ({
  InteractionPropPanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="prop-panel">{children}</div>
  ),
}));

vi.mock('../../components/PageListContext', () => ({
  usePageList: () => ({
    addPage: () => {},
    assetPaths: new Set<string>(),
    filePaths: new Set<string>(),
    folderPaths: new Set<string>(),
    pages: new Set<string>(),
    pagesBySlug: new Map<string, string>(),
    pagesByBasename: new Map<string, string>(),
    pageTitles: new Map<string, string>(),
    pageMeta: new Map(),
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));

function makeEditor(target: string): Editor {
  const node = { attrs: { target, alias: null, anchor: null }, nodeSize: 1 };
  return {
    state: { doc: { nodeAt: () => node } },
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
}

function renderPanel() {
  const onNavigate = vi.fn((_newTab: boolean) => true);
  const { container } = renderWithI18n(
    <TooltipProvider>
      <WikiLinkPropPanel
        editor={makeEditor(MAIL_URL)}
        getPos={() => 1}
        onClose={() => {}}
        onNavigate={onNavigate}
      />
    </TooltipProvider>,
  );
  const anchor = container.querySelector<HTMLAnchorElement>(
    'a[data-slot="wiki-link-prop-panel-text"]',
  );
  if (!anchor) throw new Error('external link anchor not rendered');
  return { anchor, onNavigate };
}

function middleClick(anchor: HTMLAnchorElement): boolean {
  return anchor.dispatchEvent(
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
  );
}

afterEach(() => {
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  cleanup();
});

describe('WikiLinkPropPanel external link middle-click', () => {
  test('in the desktop app a middle-click hands the address to okDesktop.shell.openExternal', () => {
    const openExternal = vi.fn(async (_url: string) => {});
    (window as unknown as { okDesktop?: unknown }).okDesktop = { shell: { openExternal } };
    const { anchor } = renderPanel();

    const proceeded = middleClick(anchor);

    expect(anchor.getAttribute('href')).toBe(MAIL_URL);
    expect(openExternal.mock.calls).toEqual([[MAIL_URL]]);
    expect(proceeded).toBe(false);
  });

  test('in a browser a middle-click keeps the browser default', () => {
    const { anchor, onNavigate } = renderPanel();

    const proceeded = middleClick(anchor);

    expect(anchor.getAttribute('href')).toBe(MAIL_URL);
    expect(proceeded).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
