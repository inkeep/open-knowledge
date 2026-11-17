import { cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { InternalLinkPropPanel } from './InternalLinkPropPanel';

const MAIL_URL = 'mailto:team@example.com';

vi.mock('../../components/PageListContext', () => ({
  usePageList: () => ({
    addPage: () => {},
    assetPaths: new Set<string>(),
    filePaths: new Set<string>(),
    folderPaths: new Set<string>(),
    loading: false,
    pageMeta: new Map(),
    pageTitles: new Map(),
    pages: new Set<string>(),
    pagesBySlug: new Map<string, string>(),
    pagesByBasename: new Map<string, string>(),
  }),
}));

vi.mock('./mark-interaction-bridge', () => ({
  getCurrentMarkInfo: () => ({
    id: 'm1',
    markType: 'link',
    attrs: { href: 'mailto:team@example.com' },
    from: 0,
    to: 4,
  }),
}));

vi.mock('./use-headings', () => ({
  useHeadings: () => [],
}));

vi.mock('../../lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalConfig: { linkPreviews: { enabled: false } },
  }),
}));

vi.mock('../../components/InteractionPropPanel', () => ({
  InteractionPropPanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="prop-panel">{children}</div>
  ),
}));

function makeEditor(): Editor {
  const chain = {
    focus: () => chain,
    setTextSelection: () => chain,
    extendMarkRange: () => chain,
    deleteRange: () => chain,
    updateAttributes: () => chain,
    run: () => true,
  };
  return {
    state: { doc: { textBetween: () => 'link' } },
    chain: () => chain,
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
}

function renderPanel() {
  const onNavigate = vi.fn((_newTab: boolean) => true);
  const { container } = renderWithI18n(
    <TooltipProvider>
      <InternalLinkPropPanel
        editor={makeEditor()}
        nodeId="m1"
        sourceDocName="notes/source"
        onClose={() => {}}
        onNavigate={onNavigate}
      />
    </TooltipProvider>,
  );
  const anchor = container.querySelector<HTMLAnchorElement>(
    'a[data-slot="internal-link-prop-panel-text"]',
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

describe('InternalLinkPropPanel external link middle-click', () => {
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
