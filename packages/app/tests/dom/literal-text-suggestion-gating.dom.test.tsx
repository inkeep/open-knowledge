/**
 * Pin the invariant that the three `@tiptap/suggestion`-based extensions
 * (slash `/`, wiki-link `[[`, tag `#`) must NOT activate inside a
 * literal-text region — a `codeBlock` node, an inline `code` mark, or a
 * raw-MDX-source node — and therefore cannot destroy the characters that
 * ARE the document's source there.
 *
 * Literal-text regions are the universal "leave my text alone" surface.
 * `@tiptap/core`'s input-rule runner short-circuits on
 * `$from.parent.type.spec.code` or an adjacent code-marked node, so every
 * `addInputRules` surface inherits the code half for free, and
 * `gfm-autolink-plugin.ts` reads the same predicate out of
 * `literal-text-context.ts` for its bare-plugin path. The suggestion
 * plugins are bare ProseMirror plugins too, but their `allow` predicate
 * tested source mode only — so a menu could activate inside a fence, and
 * committing an item deleted the typed query out of the fence (wiki-link /
 * tag) or replaced the whole code block (slash).
 *
 * `jsxInline` is the sharpest case and needs no typing at all: the `/` in
 * `<Icon />` is already a valid slash trigger, so parking the caret before
 * the `>` arms a menu whose commit deletes that `/` out of the source and
 * leaves `<Icon >`.
 *
 * Byte destruction is the point of this suite: the activation assertions
 * are the gate, the post-commit assertions are the consequence. Positive
 * controls in a plain paragraph keep an over-broad predicate (e.g.
 * `allow: () => false`) failing loudly here instead of silently breaking
 * the pickers in normal prose.
 *
 * Commit is driven by a real `KeyboardEvent` through
 * `view.someProp('handleKeyDown')` rather than
 * `editor.commands.keyboardShortcut`, which double-dispatches a stale
 * transaction and is not a faithful key route. The editor also takes real
 * DOM focus, which several editor plugins gate on.
 *
 * Tier: `.dom.test.tsx` (jsdom preload) — TipTap's `new Editor({ ... })`
 * needs `document` and `window`.
 */

// `cleanup` is imported to satisfy the dom-test-filename-stop-rule contract
// (every `*.dom.test.tsx` file must value-import from
// `@testing-library/react`). The suite constructs the Editor directly.
import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';
import { RAW_SOURCE_NODE_TYPES } from '../../src/editor/literal-text-context';
import { getSuggestionState, suggestionPluginKeys } from './suggestion-plugin-state.test-helper';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;
type KeyDownHandler = (view: EditorView, event: KeyboardEvent) => boolean;

/** Literal-text region under test. `paragraph` is the positive control. */
type Context = 'codeBlock' | 'inlineCode' | 'jsxInline' | 'paragraph';

/** A paragraph holding inline JSX, which parses to a `jsxInline` node. */
const JSX_DOC = '<p>hello <span data-jsx-inline="">&lt;Icon /&gt;</span> world</p>';

/** Position `offset` characters into the first node of type `name`. */
function positionInside(editor: Editor, name: string, offset: number): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === name) found = pos + 1 + offset;
    return found === null;
  });
  return found;
}

interface Trigger {
  /** Plugin-key prefix, matched against the synthesized `<name>$<n>` key. */
  keyPrefix: string;
  /** Characters typed into the editor, including the leading boundary. */
  typed: string;
  /** Substring that must survive verbatim inside the literal-text region. */
  literal: string;
}

const TRIGGERS: Trigger[] = [
  { keyPrefix: 'wikiLinkSuggestion', typed: 'x [[note', literal: '[[note' },
  { keyPrefix: 'tagSuggestion', typed: 'x #roadmap', literal: '#roadmap' },
  { keyPrefix: 'slashCommand', typed: 'x /head', literal: '/head' },
];

const ENTER: KeyboardEventInit & { key: string } = { key: 'Enter', code: 'Enter', keyCode: 13 };

function mountEditor(context: Context): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content: context === 'jsxInline' ? JSX_DOC : '<p></p>',
    extensions: sharedExtensions,
    editable: true,
  });
  // Real DOM focus: `commands.focus()` defers `view.focus()` into a rAF that
  // never runs under jsdom, and plugins that gate on focus would stay inert.
  editor.view.dom.focus();
  if (context === 'jsxInline') {
    // Land inside `<Icon />` between the `n` and the space, so a typed
    // trigger sits in the middle of the raw source.
    const pos = positionInside(editor, 'jsxInline', 5);
    if (pos === null) throw new Error('jsxInline node not found in the seeded document');
    editor.commands.setTextSelection(pos);
    return { editor, container };
  }
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  if (context === 'codeBlock') editor.commands.setCodeBlock();
  if (context === 'inlineCode') editor.commands.toggleMark('code');
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
  // Suggestion popups mount into `document.body`, not the editor container.
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

/** Feed characters through the real `handleTextInput` walk, one at a time. */
function typeChars(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled =
      editor.view.someProp('handleTextInput', (h) =>
        (h as TextInputHandler)(editor.view, from, to, ch),
      ) ?? false;
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch));
  }
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...ENTER });
  return (
    editor.view.someProp('handleKeyDown', (h) => (h as KeyDownHandler)(editor.view, event)) ?? false
  );
}

/** React 19's concurrent render needs two microtask yields to commit. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function docJson(editor: Editor): string {
  return JSON.stringify(editor.state.doc.toJSON());
}

describe('Suggestion plugins refuse inside literal text (byte-preservation contract)', () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * Closure guard. The per-trigger cases below cover a hardcoded list; this
   * asserts that list is the whole population, so adding a fourth picker
   * fails here until it is added to `TRIGGERS` and proven to refuse.
   *
   */
  test('the three covered pickers are the only suggestion plugins in the editor', () => {
    const { editor, container } = mountEditor('paragraph');
    try {
      expect(suggestionPluginKeys(editor)).toEqual(TRIGGERS.map((t) => `${t.keyPrefix}$`).sort());
    } finally {
      teardown(editor, container);
    }
  });

  /**
   * Closure guard for the other half of the predicate. `RAW_SOURCE_NODE_TYPES`
   * is a name list, so it can silently fall behind the schema; the structural
   * shape it stands for is "declares `content: 'text*'` and is not `spec.code`".
   * A new node of that shape fails here until someone decides whether it holds
   * raw source (add it to the list) or merely plain text (widen this guard's
   * documented exceptions).
   *
   */
  test('the raw-source list covers every non-code `content: text*` node in the schema', () => {
    const { editor, container } = mountEditor('paragraph');
    try {
      const shaped = Object.entries(editor.state.schema.nodes)
        .filter(([, type]) => {
          const spec = type.spec as { content?: string; code?: boolean };
          return spec.content === 'text*' && spec.code !== true;
        })
        .map(([name]) => name)
        .sort();
      expect(shaped).toEqual([...RAW_SOURCE_NODE_TYPES].sort());
    } finally {
      teardown(editor, container);
    }
  });

  describe.each(TRIGGERS)('$keyPrefix', ({ keyPrefix, typed, literal }) => {
    test('stays inactive inside a code block and leaves the typed bytes intact', async () => {
      const { editor, container } = mountEditor('codeBlock');
      try {
        typeChars(editor, typed);
        await flush();

        expect(getSuggestionState(editor, keyPrefix)?.active).toBe(false);

        // The commit key must fall through to normal code-block behavior
        // rather than being consumed by a menu.
        pressEnter(editor);
        await flush();

        const json = docJson(editor);
        expect(json).toContain('codeBlock');
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toContain(
          literal,
        );
        // No chip / heading was minted out of the fence.
        expect(json).not.toContain('wikiLink');
        expect(json).not.toContain('"type":"tag"');
        expect(json).not.toContain('heading');
      } finally {
        teardown(editor, container);
      }
    });

    test('stays inactive inside an inline code mark and leaves the typed bytes intact', async () => {
      const { editor, container } = mountEditor('inlineCode');
      try {
        typeChars(editor, typed);
        await flush();

        expect(getSuggestionState(editor, keyPrefix)?.active).toBe(false);

        pressEnter(editor);
        await flush();

        const json = docJson(editor);
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toContain(
          literal,
        );
        expect(json).not.toContain('wikiLink');
        expect(json).not.toContain('"type":"tag"');
      } finally {
        teardown(editor, container);
      }
    });

    /**
     * The raw-source clause. `jsxInline` holds its own markdown source as
     * plain text, so a deleted trigger range is a direct edit to the
     * document's bytes.
     *
     */
    test('stays inactive inside inline JSX source and leaves the source intact', async () => {
      const { editor, container } = mountEditor('jsxInline');
      try {
        typeChars(editor, typed);
        await flush();

        expect(getSuggestionState(editor, keyPrefix)?.active).toBe(false);

        pressEnter(editor);
        await flush();

        const json = docJson(editor);
        const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
        expect(text).toContain(literal);
        // The JSX source itself survives, angle brackets and all.
        expect(text).toContain('<Icon');
        expect(text).toContain('/>');
        expect(json).toContain('jsxInline');
        expect(json).not.toContain('wikiLink');
        expect(json).not.toContain('"type":"tag"');
      } finally {
        teardown(editor, container);
      }
    });

    /**
     * Positive control: the same keystrokes in plain prose must still open
     * the menu. Without this, `allow: () => false` would pass the refusal
     * tests above while breaking every picker in the product.
     *
     */
    test('still activates in a plain paragraph', async () => {
      const { editor, container } = mountEditor('paragraph');
      try {
        typeChars(editor, typed);
        await flush();
        expect(getSuggestionState(editor, keyPrefix)?.active).toBe(true);
      } finally {
        teardown(editor, container);
      }
    });
  });

  /**
   * The sharpest form of the raw-source case: no typing at all. `<Icon />`
   * already contains a space-then-slash, so parking the caret between the
   * `/` and the `>` is enough for the default matcher to arm the slash menu
   * with an empty query — and `applySlashCommandItem` deletes the trigger
   * range unconditionally, taking that `/` out of the source and leaving
   * `<Icon >`.
   *
   */
  test('the slash menu does not arm on the `/` already inside `<Icon />`', async () => {
    const { editor, container } = mountEditor('paragraph');
    try {
      editor.commands.setContent(JSX_DOC);
      const pos = positionInside(editor, 'jsxInline', 7);
      expect(pos).not.toBeNull();
      editor.commands.setTextSelection(pos as number);
      await flush();

      expect(getSuggestionState(editor, 'slashCommand')?.active).toBe(false);

      pressEnter(editor);
      await flush();

      expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toContain(
        '<Icon />',
      );
      expect(docJson(editor)).not.toContain('heading');
    } finally {
      teardown(editor, container);
    }
  });
});
