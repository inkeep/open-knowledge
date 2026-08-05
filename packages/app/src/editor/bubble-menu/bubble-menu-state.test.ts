/**
 * resolveAddLinkShortcutAction — the ⌘K dual-role routing decision — against
 * real headless editors (StarterKit + the fidelity link mark, plus the real
 * mark-identity plugin where the caret branch needs it). The claim contract:
 * a non-null action is returned exactly when the matching link affordance is
 * reachable; everything else must return null so the keystroke falls through
 * to the command palette.
 */

import { LinkFidelity, MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, Extension } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { markIdentityKey, markIdentityPlugin } from '../extensions/mark-identity';
import { installDomGlobals } from '../walk-currency-test-harness';
import { resolveAddLinkShortcutAction, shouldShowBubbleMenu } from './bubble-menu-state';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

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

/**
 * Which selections the bar opens over.
 *
 * The distinction that matters is inline versus block. An inline atom carries
 * every mark this bar applies, so counting its text is what lets a wiki link or
 * a tag be selected and acted on. A block that keeps its content in attributes
 * — a mermaid diagram, a math block — carries none of them, and a bar offering
 * bold and superscript over a diagram is noise; those blocks have an Ask AI
 * button on their own chrome instead.
 */
describe('shouldShowBubbleMenu — text held in attributes', () => {
  function makeRichEditor(md: string): Editor {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = new Editor({
      element: host,
      content: mdManager.parse(md),
      extensions: sharedExtensions,
    });
    editors.push(editor);
    return editor;
  }

  /** Select the whole first node of `typeName`. */
  function selectNode(editor: Editor, typeName: string): void {
    let target: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (target === null && node.type.name === typeName) target = pos;
      return true;
    });
    if (target === null) throw new Error(`no ${typeName} in fixture`);
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target)),
    );
  }

  test('opens over an inline atom, which carries the marks the bar applies', () => {
    const editor = makeRichEditor('A [[page]] word.');
    selectNode(editor, 'wikiLink');
    expect(shouldShowBubbleMenu({ editor })).toBe(true);
  });

  test('does NOT open over a mermaid diagram', () => {
    const editor = makeRichEditor('```mermaid\ngraph TD;\n  A-->B;\n```');
    selectNode(editor, 'jsxComponent');
    expect(shouldShowBubbleMenu({ editor })).toBe(false);
  });

  test('does NOT open over a math block', () => {
    const editor = makeRichEditor('$$\nx = 1\n$$');
    selectNode(editor, 'jsxComponent');
    expect(shouldShowBubbleMenu({ editor })).toBe(false);
  });

  test('still opens over an ordinary text selection', () => {
    const editor = makeRichEditor('Just ordinary words.');
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5)),
    );
    expect(shouldShowBubbleMenu({ editor })).toBe(true);
  });
});
