import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { getInteractionLayer } from '../interaction-layer-host';
import { installDomGlobals } from '../walk-currency-test-harness';
import { InternalLink } from './internal-link';
import { markIdentityKey } from './mark-identity';

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
  const w = testWindow();
  delete w.okDesktop;
});

function mountWithExternalLink(url: string): {
  editor: Editor;
  activate: (newTab: boolean) => boolean | undefined;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: `<p><a href="${url}">go</a></p>`,
    extensions: [
      StarterKit.configure({ link: false }),
      InternalLink.configure({ docName: 'notes/test' }),
    ],
  });
  liveEditors.add(editor);

  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

  const idState = markIdentityKey.getState(editor.state);
  const nodeId = [...(idState?.byId.keys() ?? [])][0];
  if (nodeId === undefined) {
    throw new Error('setup: no link mark id — external link was not parsed into a link mark');
  }
  const layer = getInteractionLayer(editor);
  const registration = layer.getRegistration(nodeId);
  if (!registration?.handlePrimary) {
    throw new Error('setup: chip did not register a handlePrimary hook with the InteractionLayer');
  }
  return {
    editor,
    activate: (newTab) => registration.handlePrimary?.({ nodeId, type: 'link', newTab }),
  };
}

describe('WYSIWYG external-link activation — desktop (bridge present)', () => {
  test('bare click routes to the OS browser via okDesktop.shell.openExternal, NOT window.open', () => {
    const url = 'https://youtube.com/watch?v=abc';
    const openExternal = vi.fn(async (_url: string) => {});
    const openWindow = vi.fn(() => null);
    const w = testWindow();
    w.okDesktop = { shell: { openExternal } };
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalLink(url);
    const handled = activate(false);

    expect(handled).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(openWindow).not.toHaveBeenCalled();
  });

  test('Cmd/Ctrl+click (new-tab gesture) also reaches the OS browser, NOT a child window', () => {
    const url = 'https://example.com/path';
    const openExternal = vi.fn(async (_url: string) => {});
    const openWindow = vi.fn(() => null);
    const w = testWindow();
    w.okDesktop = { shell: { openExternal } };
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalLink(url);
    activate(true);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('WYSIWYG external-link activation — web (no bridge)', () => {
  test('bare click falls back to window.open with the new-tab + noopener features', () => {
    const url = 'https://example.com/web';
    const openWindow = vi.fn(() => null);
    const w = testWindow();
    delete w.okDesktop;
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalLink(url);
    const handled = activate(false);

    expect(handled).toBe(true);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });
});
