/**
 * Regression pins for inkeep/open-knowledge#617 — the WYSIWYG `[[wikilink]]`
 * external branch must reach the OS default browser, symmetric with the
 * markdown-link chip (`internal-link.external-open.test.ts`).
 *
 * Contract: activating a `[[https://…]]` chip routes through the desktop bridge
 * (`window.okDesktop.shell.openExternal`) when present, and falls back to
 * `window.open` on web (no bridge). The routing code is real — a mounted Editor
 * with the production `WikiLink` NodeView classifies a real external wiki-link
 * target and runs the real `handlePrimary` external branch, reached the way the
 * InteractionLayer reaches it in production
 * (`getRegistration(nodeId).handlePrimary(...)`). The only doubles are the two
 * external boundaries the decision targets (`okDesktop.shell.openExternal`,
 * `window.open`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { getInteractionLayer } from '../interaction-layer-host';
import { installDomGlobals } from '../walk-currency-test-harness';
import { WikiLink } from './wiki-link';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

type OpenExternalBridge = { shell?: { openExternal?: (url: string) => Promise<void> } };

interface OpenExternalWindow {
  okDesktop?: OpenExternalBridge;
  open: (url?: string, target?: string, features?: string) => unknown;
}

function testWindow(): OpenExternalWindow {
  return globalThis.window as unknown as OpenExternalWindow;
}

const liveEditors = new Set<Editor>();

afterEach(() => {
  for (const editor of liveEditors) editor.destroy();
  liveEditors.clear();
  delete testWindow().okDesktop;
});

/**
 * Mount a real editor with the production `WikiLink` NodeView holding a single
 * external `[[url]]` chip, and return an `activate` that invokes the real chip
 * primary-action closure through the InteractionLayer registration.
 */
function mountWithExternalWikiLink(url: string): {
  editor: Editor;
  activate: (newTab: boolean) => boolean | undefined;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: `<p><span data-wiki-link data-target="${url}"></span></p>`,
    extensions: [StarterKit, WikiLink.configure({ docName: 'notes/test' })],
  });
  liveEditors.add(editor);

  // Force a view update so the NodeView's InteractionLayer registration settles.
  // Position 1 is inside the paragraph's inline content (before the atom chip).
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

  const chip = host.querySelector('[data-node-id]');
  const nodeId = chip?.getAttribute('data-node-id') ?? undefined;
  if (nodeId === undefined) {
    throw new Error(
      'setup: no wiki-link chip — external target was not parsed into a wikiLink node',
    );
  }
  const registration = getInteractionLayer(editor).getRegistration(nodeId);
  if (!registration?.handlePrimary) {
    throw new Error('setup: wiki-link chip did not register a handlePrimary hook');
  }
  return {
    editor,
    activate: (newTab) => registration.handlePrimary?.({ nodeId, type: 'wikiLink', newTab }),
  };
}

describe('WYSIWYG wiki-link external activation — desktop (bridge present)', () => {
  test('bare click routes to the OS browser via okDesktop.shell.openExternal, NOT window.open', () => {
    const url = 'https://youtube.com/watch?v=abc';
    const openExternal = mock(async (_url: string) => {});
    const openWindow = mock(() => null);
    const w = testWindow();
    w.okDesktop = { shell: { openExternal } };
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalWikiLink(url);
    const handled = activate(false);

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('WYSIWYG wiki-link external activation — web (no bridge)', () => {
  test('bare click falls back to window.open with the new-tab + noopener features', () => {
    const url = 'https://example.com/web';
    const openWindow = mock(() => null);
    const w = testWindow();
    delete w.okDesktop;
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalWikiLink(url);
    const handled = activate(false);

    expect(handled).toBe(true);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });
});
