import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { installDomGlobals } from './walk-currency-test-harness';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

let restoreDomGlobals: (() => void) | null = null;
const editors: Editor[] = [];

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function mountEditor(md: string, extraExtensions: Extension[] = []): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: mdManager.parse(md) as JSONContent,
    extensions: [...sharedExtensions, ...extraExtensions],
  });
  editors.push(editor);
  return editor;
}

function itemPos(editor: Editor, n: number, where: 'start' | 'end'): number {
  let i = 0;
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'listItem') {
      if (i === n) {
        const para = node.firstChild;
        found = where === 'start' ? pos + 2 : pos + 2 + (para ? para.content.size : 0);
        return false;
      }
      i++;
    }
    return true;
  });
  if (found === null) throw new Error(`listItem ${n} not found`);
  return found;
}

function setCaret(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

const IS_MAC = /Mac|iP(hone|[oa]d)/.test(navigator.platform ?? '');

function press(editor: Editor, key: string, mods: { mod?: boolean } = {}): unknown {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    metaKey: (mods.mod ?? false) && IS_MAC,
    ctrlKey: (mods.mod ?? false) && !IS_MAC,
    bubbles: true,
    cancelable: true,
  });
  return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}

function serialize(editor: Editor): string {
  return mdManager.serialize(editor.getJSON() as JSONContent);
}

function hasOrphanParagraph(md: string): boolean {
  return /\n\n[a-z]/i.test(md);
}

describe('nested-boundary Backspace (D1 — orphan mint)', () => {
  test('Backspace at start of an item whose previous sibling has a nested sublist merges into the list, no orphan paragraph', () => {
    const editor = mountEditor('- [ ] top\n  - [ ] child\n- [ ] next');
    setCaret(editor, itemPos(editor, 2, 'start'));
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toMatch(/^ {2}- \[ \] childnext$/m);
    expect(md).toContain('- [ ] top');
  });

  test('Mod-Backspace at the same boundary does not orphan either', () => {
    const editor = mountEditor('- [ ] top\n  - [ ] child\n- [ ] next');
    setCaret(editor, itemPos(editor, 2, 'start'));
    expect(press(editor, 'Backspace', { mod: true })).toBe(true);

    const md = serialize(editor);
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toMatch(/^ {2}- \[ \] childnext$/m);
  });

  test('ordered nested boundary: Backspace merges instead of orphaning', () => {
    const editor = mountEditor('1. top\n   1. child\n2. next');
    setCaret(editor, itemPos(editor, 2, 'start'));
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toMatch(/^ {3}1\. childnext$/m);
  });
});

describe('nested-boundary Delete (D2 — wrong depth + checked loss)', () => {
  test('Delete at end of a nested item merges the next shallower task item at the nested depth, checked attr intact', () => {
    const editor = mountEditor('- [ ] a\n  - [ ] b\n  - [ ] c\n- [ ] d');
    setCaret(editor, itemPos(editor, 2, 'end'));
    expect(press(editor, 'Delete')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('  - [ ] cd');
    expect(md).not.toMatch(/^ {2}- d$/m);
    expect(hasOrphanParagraph(md)).toBe(false);
  });

  test('Mod-Delete at the same boundary preserves depth and checkbox too', () => {
    const editor = mountEditor('- [ ] a\n  - [ ] b\n  - [ ] c\n- [ ] d');
    setCaret(editor, itemPos(editor, 2, 'end'));
    expect(press(editor, 'Delete', { mod: true })).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('  - [ ] cd');
    expect(md).not.toMatch(/^ {2}- d$/m);
  });

  test('plain bullet variant: Delete at end of nested item merges shallower item without re-nesting artifacts', () => {
    const editor = mountEditor('- a\n  - b\n- c');
    setCaret(editor, itemPos(editor, 1, 'end'));
    expect(press(editor, 'Delete')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('  - bc');
    expect(hasOrphanParagraph(md)).toBe(false);
  });
});

describe('preserved stock behaviors (controls — must hold before and after the fix)', () => {
  test('flat-list Backspace merge stays clean (ListKeymap joinItemBackward)', () => {
    const editor = mountEditor('- [ ] alpha\n- [ ] bravo\n- [x] charlie');
    setCaret(editor, itemPos(editor, 2, 'start'));
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('- [ ] bravocharlie');
    expect(hasOrphanParagraph(md)).toBe(false);
  });

  test('flat-list Delete merge stays clean (ListKeymap joinItemForward)', () => {
    const editor = mountEditor('- [ ] alpha\n- [ ] bravo\n- [x] charlie');
    setCaret(editor, itemPos(editor, 1, 'end'));
    expect(press(editor, 'Delete')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('- [ ] bravocharlie');
  });

  test('Backspace at the very start of the FIRST item lifts it out to a standalone paragraph (stock un-list)', () => {
    const editor = mountEditor('above\n\n- alpha\n- bravo');
    setCaret(editor, itemPos(editor, 0, 'start'));
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).toContain('above');
    expect(md).not.toContain('abovealpha');
    expect(md).toMatch(/^alpha$/m);
    expect(md).toContain('- bravo');
  });

  test('Backspace right after a "- " autoformat undoes the input rule (stock undoInputRule)', () => {
    const editor = mountEditor('seed paragraph');
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    const { view } = editor;
    editor.commands.insertContentAt(1, '-');
    const from = view.state.selection.from;
    const to = view.state.selection.to;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ' ', () => view.state.tr.insertText(' ', from, to)),
    );
    expect(handled).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('list');

    press(editor, 'Backspace');
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  });

  test('Backspace on the empty paragraph after a list rejoins the list (no stray bullet)', () => {
    const editor = mountEditor('- item one\n');
    setCaret(editor, editor.state.doc.content.size - 1);
    press(editor, 'Enter');
    press(editor, 'Enter');
    press(editor, 'Backspace');

    const md = serialize(editor).trim();
    expect(md).toBe('- item one');
    expect(md).not.toMatch(/^- *$/m);
  });

  test('Backspace on an empty nested item removes it', () => {
    const editor = mountEditor('- top\n  - sub\n');
    setCaret(editor, editor.state.doc.content.size - 1);
    press(editor, 'Enter');
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).toMatch(/^- top\n {2}- sub\n?$/m);
    expect(md.match(/- sub/g)).toHaveLength(1);
  });

  test('a ranged selection spanning the nested boundary deletes via the normal path', () => {
    const editor = mountEditor('- [ ] top\n  - [ ] child\n- [ ] next');
    const from = itemPos(editor, 1, 'start');
    const to = itemPos(editor, 2, 'start');
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    );
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).toContain('- [ ] top');
    expect(md).not.toContain('child');
    expect(md).toContain('next');
    expect(hasOrphanParagraph(md)).toBe(false);
  });
});

describe('keymap layering (precedent #48 control)', () => {
  function keyConsumerProbe(seen: string[]): Extension {
    return Extension.create({
      name: 'keyConsumerProbe',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            props: {
              handleKeyDown(_view, event) {
                if (event.key === 'Enter' || event.key === 'Tab') {
                  seen.push(event.key);
                  return true;
                }
                return false;
              },
            },
          }),
        ];
      },
    });
  }

  test('a later-registered priority-100 Enter/Tab consumer still receives Enter inside a list item', () => {
    const seen: string[] = [];
    const editor = mountEditor('- [ ] alpha\n- [ ] bravo', [keyConsumerProbe(seen)]);
    setCaret(editor, itemPos(editor, 0, 'end'));
    const before = editor.state.doc.toString();
    expect(press(editor, 'Enter')).toBe(true);

    expect(seen).toEqual(['Enter']);
    expect(editor.state.doc.toString()).toBe(before);
  });

  test('the same consumer still receives Tab inside a list item', () => {
    const seen: string[] = [];
    const editor = mountEditor('- [ ] alpha\n- [ ] bravo', [keyConsumerProbe(seen)]);
    setCaret(editor, itemPos(editor, 1, 'end'));
    const before = editor.state.doc.toString();
    expect(press(editor, 'Tab')).toBe(true);

    expect(seen).toEqual(['Tab']);
    expect(editor.state.doc.toString()).toBe(before);
  });
});

describe('three-level nesting', () => {
  test('Backspace at start of a top-level item after a 3-level nested chain merges into the deepest textblock', () => {
    const editor = mountEditor('- a\n  - b\n    - c\n- d');
    setCaret(editor, itemPos(editor, 3, 'start'));
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toMatch(/^ {4}- cd$/m);
    expect(md).toContain('- a');
  });

  test('Delete at end of a 3rd-level item merges the next shallower item at the deep depth', () => {
    const editor = mountEditor('- a\n  - b\n    - c\n  - d');
    setCaret(editor, itemPos(editor, 2, 'end'));
    expect(press(editor, 'Delete')).toBe(true);

    const md = serialize(editor);
    expect(md).toMatch(/^ {4}- cd$/m);
    expect(md).not.toMatch(/^ {2}- cd$/m);
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toContain('  - b');
  });
});

describe('unusual merge targets in the owned configuration', () => {
  test('Backspace merges into a code block when it is the deepest preceding textblock', () => {
    const editor = mountEditor('- top\n  - child\n\n    ```\n    fence\n    ```\n- next');
    setCaret(editor, itemPos(editor, 2, 'start'));
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('fencenext');
    expect(md).not.toMatch(/\n\nnext/);
  });

  test('Backspace on a fresh autoformatted empty item at the nested boundary dissolves it into the list', () => {
    const editor = mountEditor('- top\n  - child\n\nx');
    const { view } = editor;
    let paraPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'x') {
        paraPos = pos;
        return false;
      }
      return true;
    });
    editor.view.dispatch(editor.state.tr.insertText('-', paraPos + 1, paraPos + 2));
    const from = paraPos + 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from)),
    );
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, from, ' ', () => view.state.tr.insertText(' ', from, from)),
    );
    expect(handled).toBe(true);
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).not.toMatch(/^- *$/m);
    expect(md.trim()).toBe('- top\n  - child');
  });
});

describe('multi-paragraph and structure preservation', () => {
  test('D1 boundary where the merged item has a second paragraph loses no content', () => {
    const editor = mountEditor('- top\n  - child\n- next\n\n  second para');
    setCaret(editor, itemPos(editor, 2, 'start'));
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).toContain('childnext');
    expect(md).toContain('second para');
  });

  test('D2 boundary where the shallower next item has a second paragraph loses no content', () => {
    const editor = mountEditor('- a\n  - b\n- d\n\n  d two');
    setCaret(editor, itemPos(editor, 1, 'end'));
    press(editor, 'Delete');

    const md = serialize(editor);
    expect(md).toContain('bd');
    expect(md).toContain('d two');
  });
});
