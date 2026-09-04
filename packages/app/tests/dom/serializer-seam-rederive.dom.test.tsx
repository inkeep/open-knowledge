
import { MarkdownManager, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { pressEditorKey } from '../../src/editor/editor-rig.test-helper';
import { sharedExtensions } from '../../src/editor/extensions/shared';

const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy();
  cleanup();
});

function mountEditor(): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({ element: container, extensions: sharedExtensions, editable: true });
  mounted.push(editor);
  return editor;
}

function type(editor: Editor, characters: string): void {
  for (const character of characters) {
    const { from, to } = editor.state.selection;
    const handled =
      editor.view.someProp('handleTextInput', (handler) =>
        (handler as (v: typeof editor.view, f: number, t: number, s: string) => boolean)(
          editor.view,
          from,
          to,
          character,
        ),
      ) ?? false;
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character));
  }
}

function rederive(typed: JSONContent): JSONContent {
  return mdManager.parseWithFallback(stripFrontmatter(mdManager.serialize(typed)).body);
}

function bytes(typed: JSONContent): string {
  return mdManager.serialize(typed);
}

function countNodes(node: JSONContent, type: string): number {
  const self = node.type === type ? 1 : 0;
  return (node.content ?? []).reduce((sum, child) => sum + countNodes(child, type), self);
}

function checkedAttrs(d: JSONContent): Array<boolean | null> {
  const items = (d.content ?? []).find((n) => n.type === 'list')?.content ?? [];
  return items.map((i) => (i.attrs?.checked ?? null) as boolean | null);
}

describe('Shift+Enter at the end of a block', () => {
  test('the break the user typed is still there after re-derivation', () => {
    const editor = mountEditor();
    type(editor, 'foo');
    expect(pressEditorKey(editor, 'Shift-Enter').docMoved).toBe(true);

    const typed = editor.getJSON();
    expect(countNodes(typed, 'hardBreak')).toBe(1);
    expect(bytes(typed)).toBe('foo<br />\n');
    expect(countNodes(rederive(typed), 'hardBreak')).toBe(1);
  });

  test('a break typed before an existing paragraph survives too', () => {
    const editor = mountEditor();
    type(editor, 'foo');
    expect(pressEditorKey(editor, 'Enter').docMoved).toBe(true);
    type(editor, 'bar');
    editor.commands.setTextSelection(4);
    expect(pressEditorKey(editor, 'Shift-Enter').docMoved).toBe(true);

    const typed = editor.getJSON();
    expect(countNodes(rederive(typed), 'hardBreak')).toBe(countNodes(typed, 'hardBreak'));
  });

  test('CONTROL: a mid-paragraph break keeps the backslash spelling', () => {
    const editor = mountEditor();
    type(editor, 'foo');
    expect(pressEditorKey(editor, 'Shift-Enter').docMoved).toBe(true);
    type(editor, 'bar');

    const typed = editor.getJSON();
    expect(bytes(typed)).toBe('foo\\\nbar\n');
    expect(countNodes(rederive(typed), 'hardBreak')).toBe(1);
  });
});

describe('an empty task item', () => {
  test('keeps its checkbox after re-derivation, at the end of a list', () => {
    const editor = mountEditor();
    expect(editor.commands.toggleTaskList()).toBe(true);

    const typed = editor.getJSON();
    expect(bytes(typed)).toContain('- [ ] &#x20;');
    const back = rederive(typed);
    const items = back.content?.[0]?.content ?? [];
    expect(items.map((i) => i.attrs?.checked)).toEqual([false]);
  });

  test('keeps its checkbox in the MIDDLE of a list', () => {
    const editor = mountEditor();
    expect(editor.commands.toggleTaskList()).toBe(true);
    type(editor, 'a');
    expect(pressEditorKey(editor, 'Enter').docMoved).toBe(true);
    type(editor, 'c');
    editor.commands.setTextSelection(3);
    expect(pressEditorKey(editor, 'Enter').docMoved).toBe(true);

    const typed = editor.getJSON();
    const typedChecked = checkedAttrs(typed);
    expect(typedChecked).toEqual([false, false, false]);
    expect(bytes(typed)).toContain('- [ ] &#x20;');
    expect(checkedAttrs(rederive(typed))).toEqual(typedChecked);
  });

  test('CONTROL: a task item with content is unchanged', () => {
    const editor = mountEditor();
    expect(editor.commands.toggleTaskList()).toBe(true);
    type(editor, 'buy milk');

    const typed = editor.getJSON();
    expect(bytes(typed)).toContain('- [ ] buy milk\n');
    expect(bytes(typed)).not.toContain('&#x20;');
    expect(checkedAttrs(rederive(typed))).toEqual([false]);
  });
});
