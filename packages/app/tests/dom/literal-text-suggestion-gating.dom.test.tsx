import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';
import { RAW_SOURCE_NODE_TYPES } from '../../src/editor/literal-text-context';
import { getSuggestionState, suggestionPluginKeys } from './suggestion-plugin-state.test-helper';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;
type KeyDownHandler = (view: EditorView, event: KeyboardEvent) => boolean;

type Context = 'codeBlock' | 'inlineCode' | 'jsxInline' | 'paragraph';

const JSX_DOC = '<p>hello <span data-jsx-inline="">&lt;Icon /&gt;</span> world</p>';

function positionInside(editor: Editor, name: string, offset: number): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === name) found = pos + 1 + offset;
    return found === null;
  });
  return found;
}

interface Trigger {
  keyPrefix: string;
  typed: string;
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
  editor.view.dom.focus();
  if (context === 'jsxInline') {
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
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

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

  test('the three covered pickers are the only suggestion plugins in the editor', () => {
    const { editor, container } = mountEditor('paragraph');
    try {
      expect(suggestionPluginKeys(editor)).toEqual(TRIGGERS.map((t) => `${t.keyPrefix}$`).sort());
    } finally {
      teardown(editor, container);
    }
  });

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

        pressEnter(editor);
        await flush();

        const json = docJson(editor);
        expect(json).toContain('codeBlock');
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toContain(
          literal,
        );
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
        expect(text).toContain('<Icon');
        expect(text).toContain('/>');
        expect(json).toContain('jsxInline');
        expect(json).not.toContain('wikiLink');
        expect(json).not.toContain('"type":"tag"');
      } finally {
        teardown(editor, container);
      }
    });

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
