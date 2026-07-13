/**
 * Backspace/Delete merge at a listItem boundary (#609 cause 2 — "orphan"
 * rows from deleting, as distinct from cause 1's paste mis-placement fixed
 * in handle-paste.list-placement.test.ts).
 *
 * StarterKit's ListKeymap sub-extension (@tiptap/extension-list, wired via
 * shared.ts's `listKeymap` option) targets the fragmented BulletList/
 * OrderedList/TaskList/TaskItem schema. Against this repo's unified single
 * `listItem` schema, two of its branches misbehave:
 *
 *   - Backspace at the start of an item whose PRECEDING sibling has a nested
 *     sublist takes `liftListItem` instead of merging text, which lifts the
 *     merged item clean out of the list into a bare paragraph with no
 *     bullet/checkbox — the orphan row users see.
 *   - Delete at the end of the last item in a nested sublist, merging a
 *     shallower next top-level item, re-nests that item at the wrong depth
 *     and drops its `checked` attr, silently rewriting document structure.
 *
 * list.ts's ListItemNode now binds Backspace/Delete itself (priority 101,
 * ahead of ListKeymap's default 100) using prosemirror-commands'
 * `joinTextblockBackward`/`joinTextblockForward` — these descend through
 * container nodes to the actual textblocks and merge only those, never
 * re-parenting or dropping the surviving item's attrs, falling back to
 * `joinBackward`/`joinForward` only when there's no adjacent list item to
 * join into (first/last item in the list).
 *
 * Each test mounts a real TipTap editor over the core schema and dispatches
 * a real `keydown` through `view.someProp('handleKeyDown', ...)` — the same
 * path a live keypress takes — rather than calling a PM command directly,
 * so the assertions cover the actual registered keymap-plugin race.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
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

function mountEditor(md: string): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: mdManager.parse(md) as JSONContent,
    extensions: [...sharedExtensions],
  });
  editors.push(editor);
  return editor;
}

/** Doc position at the start or end of the nth listItem's first paragraph. */
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

function press(editor: Editor, key: string): unknown {
  const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
  return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}

function serialize(editor: Editor): string {
  return mdManager.serialize(editor.getJSON() as JSONContent);
}

/** No bare/unmarked line sitting where a list item used to be. */
function hasOrphanParagraph(md: string): boolean {
  return /\n\n[a-z]/i.test(md);
}

const TASK_SEED = ['- [ ] alpha', '- [ ] bravo', '- [x] charlie', '- [ ] delta', '- [ ] echo'].join(
  '\n',
);

describe('list keymap — Backspace/Delete merge at an item boundary', () => {
  test('Backspace at item start merges text into the previous flat item, no orphan', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemPos(editor, 2, 'start')); // start of "charlie"
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('- [ ] bravocharlie');
    expect(hasOrphanParagraph(md)).toBe(false);
  });

  test('Backspace merging into a previous item that has a nested sublist keeps the merged text inside the list (no bare orphan paragraph)', () => {
    const editor = mountEditor('- [ ] top\n  - [ ] child\n- [ ] next');
    setCaret(editor, itemPos(editor, 2, 'start')); // start of "next" (top-level, after "top"+"child")
    expect(press(editor, 'Backspace')).toBe(true);

    const md = serialize(editor);
    // "next" must land inside the list (merged onto the deepest preceding
    // textblock), never as a bare paragraph outside any list item.
    expect(hasOrphanParagraph(md)).toBe(false);
    expect(md).toContain('childnext');
  });

  test('Delete at the end of a nested item merges the next shallower item at the correct depth, checked attr intact', () => {
    const editor = mountEditor('- [ ] a\n  - [ ] b\n  - [ ] c\n- [ ] d');
    setCaret(editor, itemPos(editor, 2, 'end')); // end of "c" (nested, sibling of b)
    expect(press(editor, 'Delete')).toBe(true);

    const md = serialize(editor);
    // "d" merges onto "c" at the nested depth — no bare re-nested plain
    // bullet, no orphan line at the wrong indent.
    expect(md).toContain('  - [ ] cd');
    expect(hasOrphanParagraph(md)).toBe(false);
  });

  test('a ranged selection spanning two items still deletes via the normal path (unaffected)', () => {
    const editor = mountEditor(TASK_SEED);
    const from = itemPos(editor, 1, 'start'); // start of "bravo"
    const to = itemPos(editor, 2, 'start'); // start of "charlie"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    );
    editor.view.dispatch(editor.state.tr.deleteSelection());

    const md = serialize(editor);
    expect(md).toContain('- [x] charlie');
    expect(md).not.toContain('bravo');
    expect(hasOrphanParagraph(md)).toBe(false);
  });
});

describe('list keymap — pre-existing behavior preserved', () => {
  test('Backspace on the empty line after a list merges back in (no stray bullet)', () => {
    const editor = mountEditor('- item one\n');
    setCaret(editor, editor.state.doc.content.size - 1);
    press(editor, 'Enter'); // empty second item
    press(editor, 'Enter'); // lifts out to a plain paragraph below the list
    press(editor, 'Backspace'); // must rejoin the list, not spawn a bullet

    const md = serialize(editor).trim();
    expect(md).toBe('- item one');
    expect(md).not.toMatch(/^- *$/m);
  });

  test('Backspace on an empty nested item removes it (does not toggle the bullet)', () => {
    const editor = mountEditor('- top\n  - sub\n');
    setCaret(editor, editor.state.doc.content.size - 1);
    press(editor, 'Enter'); // empty nested item after "sub"
    press(editor, 'Backspace'); // removes the empty item, back to "sub"

    const md = serialize(editor);
    expect(md).toMatch(/^- top\n {2}- sub\n?$/m);
    expect(md.match(/- sub/g)).toHaveLength(1);
  });

  test('Backspace at the very start of the first item in a list lifts it out to a plain paragraph', () => {
    const editor = mountEditor('- alpha\n- bravo\n');
    setCaret(editor, itemPos(editor, 0, 'start'));
    press(editor, 'Backspace');

    const md = serialize(editor);
    expect(md).toContain('alpha');
    expect(md).toContain('- bravo');
  });

  test('Enter at end of a task item still creates a new task item', () => {
    const editor = mountEditor('- [ ] sf\n');
    setCaret(editor, itemPos(editor, 0, 'end'));
    press(editor, 'Enter');

    const md = serialize(editor);
    expect(md).toMatch(/^- \[ \] sf\n- \[ \] ?$/m);
  });
});
