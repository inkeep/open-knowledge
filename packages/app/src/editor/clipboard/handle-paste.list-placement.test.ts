/**
 * List-aware paste placement (#609 cause 1).
 *
 * OK→OK paste of list content at a list-item boundary must splice the pasted
 * items as SIBLINGS at the caret's list level — above the item at item-start,
 * below at item-end, split around the caret mid-item — never nesting the
 * pasted list as a child of the target item or minting an empty-leading
 * -paragraph orphan shape.
 *
 * Each test mounts a real TipTap editor over the core schema (real list nodes,
 * real MarkdownManager) and drives the REAL createHandlePaste dispatcher, so
 * the whole path runs: markdown-first tiebreak → MarkdownManager.parse →
 * applyJsonSlice → buildListSiblingSpliceTr. Assertions cover the resulting PM
 * structure AND the serialized markdown (the sibling shapes serialize
 * correctly on today's engine — these pins do not depend on the engine
 * strip×glue fix that ships separately).
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import * as actualSonner from 'sonner';
import { installDomGlobals } from '../walk-currency-test-harness';
import { createClipboardTextSerializer } from './serialize';

// The dispatcher pulls the degrade-path toast (sonner) into its import graph;
// stub it so module load stays inert. The splice path never degrades.
mock.module('sonner', () => ({ ...actualSonner, toast: { error: mock(() => {}) } }));

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

// Bind the dispatcher after the sonner mock is registered so its transitive
// sonner import resolves to the stub (the mock facade only rewrites imports
// resolved after the doMock call).
let createHandlePaste: typeof import('./handle-paste').createHandlePaste;

let restoreDomGlobals: (() => void) | null = null;
const editors: Editor[] = [];

beforeAll(async () => {
  restoreDomGlobals = installDomGlobals();
  ({ createHandlePaste } = await import('./handle-paste'));
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

/** text/plain + a dummy text/html sibling — the shape an OK→OK copy carries,
 *  so the dispatcher's markdown-first tiebreak routes through the markdown
 *  parse (the branch applyJsonSlice's placement fix lives on). */
function pasteMarkdown(editor: Editor, payload: string): boolean {
  const dt = {
    clipboardData: {
      types: ['text/plain', 'text/html'],
      getData: (k: string) =>
        k === 'text/plain' ? payload : k === 'text/html' ? '<ul><li>x</li></ul>' : '',
    },
  } as unknown as ClipboardEvent;
  return createHandlePaste({ mdManager })(editor.view, dt);
}

/** Doc position of the first char / last char of the nth list item's first
 *  paragraph (0-based, doc order). */
function itemParaRange(doc: ProseMirrorNode, n: number): { start: number; end: number } {
  let i = 0;
  let found: { start: number; end: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'listItem') {
      if (i === n) {
        const para = node.firstChild;
        const start = pos + 2; // listItem open +1 → paragraph, +1 → text
        found = { start, end: start + (para ? para.content.size : 0) };
        return false;
      }
      i++;
    }
    return true;
  });
  if (!found) throw new Error(`listItem ${n} not found`);
  return found;
}

function setCaret(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

interface ItemShape {
  checked: boolean | null;
  text: string;
  nested: string[];
}

/** The first top-level list's items as {checked, text, nested-item-texts}. */
function firstListItems(doc: ProseMirrorNode): ItemShape[] {
  let list: ProseMirrorNode | null = null;
  doc.forEach((node) => {
    if (!list && node.type.name === 'list') list = node;
  });
  if (!list) throw new Error('no top-level list');
  const items: ItemShape[] = [];
  (list as ProseMirrorNode).forEach((item) => {
    if (item.type.name !== 'listItem') return;
    let text: string | null = null;
    const nested: string[] = [];
    item.forEach((child) => {
      if (child.type.name === 'paragraph' && text === null) text = child.textContent;
      if (child.type.name === 'list') {
        child.forEach((ni) => {
          if (ni.type.name === 'listItem') nested.push(ni.textContent);
        });
      }
    });
    items.push({ checked: item.attrs.checked, text: text ?? '', nested });
  });
  return items;
}

/** Top-level node type names — asserts nothing leaked outside the list. */
function topLevelTypes(doc: ProseMirrorNode): string[] {
  const names: string[] = [];
  doc.forEach((node) => {
    names.push(node.type.name);
  });
  return names;
}

function serialize(editor: Editor): string {
  return mdManager.serialize(editor.getJSON() as JSONContent);
}

/** The orphan byte shapes #609 produces when list content is mis-placed. */
function hasOrphanShapes(md: string): boolean {
  return /- \[ \] - \[ \]/.test(md) || /^\s*\\- /m.test(md) || /- - /.test(md);
}

const TASK_SEED = ['- [ ] alpha', '- [ ] bravo', '- [x] charlie', '- [ ] delta', '- [ ] echo'].join(
  '\n',
);

describe('list paste placement — tracer: full copy→paste round trip', () => {
  test('copying a real item and pasting it at another item start splices a sibling above', () => {
    // Copy item "bravo" through the REAL clipboard text serializer (the exact
    // text/plain an OK copy writes), then paste at the start of "delta".
    const source = mountEditor(TASK_SEED);
    const bravo = itemParaRange(source.state.doc, 1);
    source.view.dispatch(
      source.state.tr.setSelection(TextSelection.create(source.state.doc, bravo.start, bravo.end)),
    );
    const payload = createClipboardTextSerializer({ mdManager })(
      source.state.selection.content(),
      source.view,
    );
    expect(payload).toBe('- [ ] bravo\n');

    const target = mountEditor(TASK_SEED);
    setCaret(target, itemParaRange(target.state.doc, 3).start);
    expect(pasteMarkdown(target, payload)).toBe(true);

    expect(firstListItems(target.state.doc).map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'bravo',
      'delta',
      'echo',
    ]);
    expect(hasOrphanShapes(serialize(target))).toBe(false);
  });
});

describe('list paste placement — caret at item start (siblings above)', () => {
  test('single task item pastes as a sibling above the intact target, no orphan shape', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).start); // start of "delta"

    expect(pasteMarkdown(editor, '- [ ] bravo\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'bravo',
      'delta',
      'echo',
    ]);
    // The pasted item is a full sibling (its own item, not nested); the target
    // "delta" is intact and unchecked; no item carries an empty leading para.
    expect(items[3]).toEqual({ checked: false, text: 'bravo', nested: [] });
    expect(items[4]).toEqual({ checked: false, text: 'delta', nested: [] });
    expect(items.every((i) => i.text.length > 0)).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('- [ ] bravo\n- [ ] delta\n');
    expect(hasOrphanShapes(md)).toBe(false);
  });

  test('two copied items paste above the first item preserving order', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 0).start); // start of "alpha"

    expect(pasteMarkdown(editor, '- [ ] bravo\n- [x] charlie\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'bravo',
      'charlie',
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
    ]);
    // Pasted checked state rides along: charlie stays checked.
    expect(items[1]).toEqual({ checked: true, text: 'charlie', nested: [] });
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });
});

describe('list paste placement — caret at item end (siblings below, not children)', () => {
  test('single item pastes as a sibling below the target, never nested as a child', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).end); // end of "delta"

    expect(pasteMarkdown(editor, '- [ ] bravo\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'bravo',
      'echo',
    ]);
    // "delta" keeps no nested list — the pasted item is its sibling below.
    expect(items[3]).toEqual({ checked: false, text: 'delta', nested: [] });
    expect(items[4]).toEqual({ checked: false, text: 'bravo', nested: [] });

    const md = serialize(editor);
    expect(md).toContain('- [ ] delta\n- [ ] bravo\n');
    expect(hasOrphanShapes(md)).toBe(false);
  });

  test('two copied items paste below the target as siblings', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 4).end); // end of "echo"

    expect(pasteMarkdown(editor, '- [ ] bravo\n- [x] charlie\n')).toBe(true);

    expect(firstListItems(editor.state.doc).map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'bravo',
      'charlie',
    ]);
    expect(firstListItems(editor.state.doc).every((i) => i.nested.length === 0)).toBe(true);
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });
});

describe('list paste placement — caret mid-item (split at caret)', () => {
  test('mid-item paste splits the item: text-before stays, pasted follows, text-after trails', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).start + 2); // "de|lta"

    expect(pasteMarkdown(editor, '- [ ] bravo\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'de',
      'bravo',
      'lta',
      'echo',
    ]);
    // Both split halves are their own siblings; neither nests the pasted item.
    expect(items[3]).toEqual({ checked: false, text: 'de', nested: [] });
    expect(items[5]).toEqual({ checked: false, text: 'lta', nested: [] });
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });
});

describe('list paste placement — nested lists, ordered, plain-bullet uniformity', () => {
  test('a pasted item keeps its own nested list as a child (nested lists preserved)', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 4).end); // end of "echo"

    expect(pasteMarkdown(editor, '- [ ] parent\n  - [ ] child-a\n  - [ ] child-b\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'parent',
    ]);
    // The pasted "parent" item carries its own child list — opened at the
    // sibling boundary only, never into the item's interior.
    expect(items[5]).toEqual({ checked: false, text: 'parent', nested: ['child-a', 'child-b'] });
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });

  test('plain-bullet paste at item start splices siblings with no orphan (OP16 control)', () => {
    const editor = mountEditor('- alpha\n- bravo\n- charlie');
    setCaret(editor, itemParaRange(editor.state.doc, 2).start); // start of "charlie"

    expect(pasteMarkdown(editor, '- bravo\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual(['alpha', 'bravo', 'bravo', 'charlie']);
    // Plain bullets carry a null checked attr — no task-marker leaks in.
    expect(items.every((i) => i.checked === null)).toBe(true);

    const md = serialize(editor);
    expect(md).toContain('- bravo\n- charlie\n');
    expect(hasOrphanShapes(md)).toBe(false);
  });

  test('ordered-list items pasted into a bullet list adopt the target level', () => {
    const editor = mountEditor('- alpha\n- bravo\n- charlie');
    setCaret(editor, itemParaRange(editor.state.doc, 2).end); // end of "charlie"

    expect(pasteMarkdown(editor, '1. one\n2. two\n')).toBe(true);

    expect(firstListItems(editor.state.doc).map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'one',
      'two',
    ]);
    expect(topLevelTypes(editor.state.doc).filter((t) => t === 'list')).toHaveLength(1);
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });
});

describe('list paste placement — caret lands after pasted content', () => {
  test('the caret ends inside the last pasted item at its text end', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).start); // start of "delta"

    pasteMarkdown(editor, '- [ ] bravo\n- [x] charlie\n');

    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('charlie');
    expect($from.parentOffset).toBe($from.parent.content.size); // at the end
  });
});

describe('list paste placement — closed-slice path preserved for non-list / non-list-caret', () => {
  test('list content pasted outside any list keeps the closed-slice behavior', () => {
    const editor = mountEditor('<p>plain paragraph</p>');
    setCaret(editor, 1); // inside the paragraph, not in a list

    expect(pasteMarkdown(editor, '- [ ] one\n- [ ] two\n')).toBe(true);

    // A list still lands (closed slice), but there is no list-item context to
    // splice into — the fix must not touch this path.
    expect(firstListItems(editor.state.doc).map((i) => i.text)).toEqual(['one', 'two']);
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });
});

describe('list paste placement — containers never opened (FR5 / QA-006)', () => {
  test('a copied block component pasted at a paragraph caret preserves descriptor identity', () => {
    const editor = mountEditor('<p>before</p>');
    setCaret(editor, 3); // inside "before"

    expect(pasteMarkdown(editor, '<Callout>\n\nnote\n\n</Callout>\n')).toBe(true);

    let component: ProseMirrorNode | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent') component = node;
      return true;
    });
    expect(component).not.toBeNull();
    // Descriptor identity survives byte-exactly: the placement fix never opens
    // a non-list container, so the Callout round-trips whole.
    expect(serialize(editor)).toContain('<Callout>');
    expect((component as unknown as ProseMirrorNode).attrs.componentName).toBe('Callout');
  });

  test('a copied component with the caret in a list item does not trigger the list splice', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).start); // start of "delta"

    // Payload is a component (not all-lists) → the splice guard's payload
    // dimension must reject it; the closed-slice path handles it and the
    // descriptor is preserved whole (never opened).
    expect(pasteMarkdown(editor, '<Callout>\n\nnote\n\n</Callout>\n')).toBe(true);

    let component: ProseMirrorNode | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent') component = node;
      return true;
    });
    expect(component).not.toBeNull();
    expect((component as unknown as ProseMirrorNode).attrs.componentName).toBe('Callout');
  });
});

describe('list paste placement — payload and guard edges', () => {
  test('a payload of two separate lists splices every item as a sibling, in payload order', () => {
    const editor = mountEditor(TASK_SEED);
    setCaret(editor, itemParaRange(editor.state.doc, 3).start); // start of "delta"

    // A task list AND an ordered list in one payload: the splice collects the
    // items across both lists rather than nesting either list whole.
    expect(pasteMarkdown(editor, '- [ ] one\n\n1. two\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'one',
      'two',
      'delta',
      'echo',
    ]);
    expect(items[3]?.checked).toBe(false);
    expect(items[4]?.checked).toBeNull();
    expect(topLevelTypes(editor.state.doc).filter((t) => t === 'list')).toHaveLength(1);
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });

  test('paste at the start of a nested item splices siblings at the nested level', () => {
    const editor = mountEditor('- [ ] parent\n  - [ ] childA\n  - [ ] childB');
    // Doc-order listItems: 0=parent, 1=childA, 2=childB.
    setCaret(editor, itemParaRange(editor.state.doc, 2).start);

    expect(pasteMarkdown(editor, '- [ ] new\n')).toBe(true);

    const items = firstListItems(editor.state.doc);
    expect(items.map((i) => i.text.startsWith('parent'))).toEqual([true]);
    expect(items[0]?.nested).toEqual(['childA', 'new', 'childB']);
    expect(hasOrphanShapes(serialize(editor))).toBe(false);
  });

  test('a ranged selection inside a list item falls back to the closed-slice path', () => {
    const payload = '- [ ] pasted\n';
    const editor = mountEditor(TASK_SEED);
    const range = itemParaRange(editor.state.doc, 3); // "delta"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, range.start, range.end)),
    );

    // Control: the identical seed + selection, with the pre-existing
    // closed-slice insertion applied directly. The dispatcher outcome must
    // equal it — proving the splice declined the ranged selection rather than
    // producing its own placement.
    const control = mountEditor(TASK_SEED);
    const controlRange = itemParaRange(control.state.doc, 3);
    control.view.dispatch(
      control.state.tr.setSelection(
        TextSelection.create(control.state.doc, controlRange.start, controlRange.end),
      ),
    );
    const node = control.state.schema.nodeFromJSON(mdManager.parse(payload) as JSONContent);
    control.view.dispatch(control.state.tr.replaceSelection(node.slice(0, node.content.size)));

    expect(pasteMarkdown(editor, payload)).toBe(true);
    // Structural-JSON oracle rather than doc.eq: eq() trips over an
    // undefined-vs-absent attr artifact between independently parsed seeds;
    // the JSON form captures every attr the serializer consumes.
    expect(JSON.stringify(editor.state.doc.toJSON())).toBe(
      JSON.stringify(control.state.doc.toJSON()),
    );
  });
});
