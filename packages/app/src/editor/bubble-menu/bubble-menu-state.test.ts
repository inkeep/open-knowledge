/**
 * resolveAddLinkShortcutAction — the ⌘K dual-role routing decision — against
 * real headless editors (StarterKit + the fidelity link mark, plus the real
 * mark-identity plugin where the caret branch needs it). The claim contract:
 * a non-null action is returned exactly when the matching link affordance is
 * reachable; everything else must return null so the keystroke falls through
 * to the command palette.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { LinkFidelity } from '@inkeep/open-knowledge-core';
import { Editor, Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { markIdentityKey, markIdentityPlugin } from '../extensions/mark-identity';
import { installDomGlobals } from '../walk-currency-test-harness';
import { resolveAddLinkShortcutAction } from './bubble-menu-state';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

const MarkIdentityForTest = Extension.create({
  name: 'markIdentityForTest',
  addProseMirrorPlugins() {
    return [markIdentityPlugin({ markTypes: ['link'] })];
  },
});

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(content: string, opts: { withIdentity?: boolean } = {}): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content,
    extensions: [
      // StarterKit v3 bundles its own Link; drop it so the fidelity mark is
      // the only `link` in the schema (and keep its stock autolink off).
      StarterKit.configure({ link: false }),
      LinkFidelity.configure({ autolink: false }),
      ...(opts.withIdentity ? [MarkIdentityForTest] : []),
    ],
  });
  editors.push(editor);
  return editor;
}

function select(editor: Editor, from: number, to: number = from): void {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

describe('resolveAddLinkShortcutAction', () => {
  test('routes a non-empty text selection to the popover', () => {
    const editor = makeEditor('<p>hello world</p>');
    select(editor, 1, 6);
    expect(resolveAddLinkShortcutAction(editor)).toEqual({ kind: 'open-popover' });
  });

  test('routes a cross-block text selection to the popover', () => {
    const editor = makeEditor('<p>one</p><p>two</p>');
    select(editor, 2, 7);
    expect(resolveAddLinkShortcutAction(editor)).toEqual({ kind: 'open-popover' });
  });

  test('falls through on a collapsed caret outside any link', () => {
    const editor = makeEditor('<p>hello world</p>');
    select(editor, 3);
    expect(resolveAddLinkShortcutAction(editor)).toBeNull();
  });

  test("routes a caret inside a tracked link to that link's edit surface", () => {
    const editor = makeEditor('<p>see <a href="https://example.com">docs</a> now</p>', {
      withIdentity: true,
    });
    select(editor, 6);

    const identity = markIdentityKey.getState(editor.state);
    const tracked = [...(identity?.byId.values() ?? [])].find((info) => info.markType === 'link');
    if (!tracked) throw new Error('link mark was not tracked by mark-identity');

    expect(resolveAddLinkShortcutAction(editor)).toEqual({
      kind: 'edit-link',
      markId: tracked.id,
    });
  });

  test('falls through on a caret inside a link when mark identity is not installed', () => {
    const editor = makeEditor('<p>see <a href="https://example.com">docs</a> now</p>');
    select(editor, 6);
    expect(resolveAddLinkShortcutAction(editor)).toBeNull();
  });

  test('falls through inside a code block', () => {
    const editor = makeEditor('<pre><code>const x = 1</code></pre>');
    select(editor, 2, 6);
    expect(resolveAddLinkShortcutAction(editor)).toBeNull();
  });

  test('falls through on a whitespace-only selection', () => {
    const editor = makeEditor('<p></p>');
    editor.view.dispatch(editor.state.tr.insertText('a   b', 1, 1));
    select(editor, 2, 5);
    expect(resolveAddLinkShortcutAction(editor)).toBeNull();
  });
});
