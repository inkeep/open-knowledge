/**
 * RED regression tests for inkeep/open-knowledge#617 — WYSIWYG external-link
 * chips must reach the OS default browser, not a child OpenKnowledge window.
 *
 * Contract under test: activating an external (`http(s)://`) link chip routes
 * through the desktop bridge (`window.okDesktop.shell.openExternal`) when it is
 * present, exactly as the graph view does (`openExternalUrl` in
 * `lib/external-link.ts`), and falls back to `window.open` only on web (no
 * bridge). Today `internal-link.ts`'s `handlePrimary` `case 'external'` calls
 * `openHashHrefInNewTab` → `window.open(url, '_blank', …)` UNCONDITIONALLY: on
 * the Electron desktop that `window.open` becomes a new in-app BrowserWindow
 * that renders the page (the bug), because it relies on a main-process
 * `setWindowOpenHandler` net that isn't attached on every window.
 *
 * Seam: the REAL `handlePrimary` closure is reached the way the InteractionLayer
 * reaches it in production — via the layer registration the chip installs
 * (`getInteractionLayer(editor).getRegistration(id).handlePrimary(...)`). No
 * mock of the routing decision: a real Editor with the real `InternalLink`
 * extension classifies a real external link mark and runs the real branch. The
 * only doubles are the two external boundaries the decision targets —
 * `window.okDesktop.shell.openExternal` (Electron preload bridge) and
 * `window.open` (browser new-window API).
 *
 * Substrate: jsdom via the shared walk-currency harness (`installDomGlobals`),
 * the same per-file DOM install the other headless editor-plugin suites use.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
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
  // Drop the injected bridge; restore the jsdom stub `window.open` so a leaked
  // reference from one case can't satisfy another's assertion.
  const w = testWindow();
  delete w.okDesktop;
});

/**
 * Mount a real editor whose sole `link` mark is the production `InternalLink`
 * extension (we do NOT use the `mountLightEditor` rig here: it bundles
 * `LinkFidelity`, and `InternalLink` extends `LinkFidelity`, so both would
 * define a `link` mark and collide). Returns an `activate` that invokes the
 * real chip primary-action closure through the InteractionLayer registration —
 * the same entry point the layer's click / Enter handler calls.
 */
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

  // Force one view update so `markIdentityPlugin`'s view lifecycle fires
  // `onRegister` → `layer.register(...)`. `state.init` already populated `byId`,
  // but the registration (which carries `handlePrimary`) lands on the first
  // `update`. A selection-only transaction (`docChanged === false`) triggers it
  // without mutating the doc.
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
    const openExternal = mock(async (_url: string) => {});
    const openWindow = mock(() => null);
    const w = testWindow();
    w.okDesktop = { shell: { openExternal } };
    w.open = openWindow as unknown as OpenExternalWindow['open'];

    const { activate } = mountWithExternalLink(url);
    const handled = activate(false);

    expect(handled).toBe(true);
    // RED today: `case 'external'` calls `window.open` unconditionally, so the
    // desktop bridge is never reached.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
    // RED today: the bug IS that a new in-app window opens.
    expect(openWindow).not.toHaveBeenCalled();
  });

  test('Cmd/Ctrl+click (new-tab gesture) also reaches the OS browser, NOT a child window', () => {
    // External URLs must land in the OS browser on EVERY activation — bare or
    // modifier-click. The modifier path must not fall back to window.open.
    const url = 'https://example.com/path';
    const openExternal = mock(async (_url: string) => {});
    const openWindow = mock(() => null);
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
  // Regression pin (green today AND after the fix): on web there is no desktop
  // bridge, so external links keep the `window.open` new-tab behavior. Guards
  // the fix from regressing the web path to a no-op.
  test('bare click falls back to window.open with the new-tab + noopener features', () => {
    const url = 'https://example.com/web';
    const openWindow = mock(() => null);
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
