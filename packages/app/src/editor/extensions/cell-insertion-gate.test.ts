/**
 * Cell-insertion gate — refuses a block jsxComponent inside a GFM table cell at
 * the owned insertion routes (command tier, real paste dispatcher, PM-native
 * drop, and the nested table-wrapping-a-component shape), exempts CRDT-origin
 * transactions, and leaves edits inside an existing (un-owned-surface)
 * component-in-cell untouched.
 *
 * Real ProseMirror EditorViews over jsdom globals (installDomGlobals from the
 * shared walk-currency harness) with the real core schema (jsxComponent +
 * table), the real MarkdownManager, and the real createHandlePaste dispatcher,
 * so every route runs its production code path into the gate's
 * filterTransaction. A filtered transaction is a silent no-op: the paste
 * dispatcher still claims the event (returns true) rather than falling through
 * to a branch that would re-insert the refused content elsewhere.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { dropPoint, ReplaceAroundStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as actualSonner from 'sonner';
import { installDomGlobals } from '../walk-currency-test-harness';
import { CellInsertionGate } from './cell-insertion-gate';

// The paste dispatcher pulls the degrade-path toast (sonner) into its import
// graph; stub it so module load stays inert in the jsdom env. The gate's no-op
// path never degrades, so the stub is never invoked.
mock.module('sonner', () => ({ ...actualSonner, toast: { error: mock(() => {}) } }));

const mdManager = new MarkdownManager({ extensions: coreExtensions });

// Bind the dispatcher after the sonner mock is registered so its transitive
// sonner import resolves to the stub (the mock facade only rewrites imports
// resolved after the doMock call).
let createHandlePaste: typeof import('../clipboard/handle-paste').createHandlePaste;

/** A ClipboardEvent whose clipboardData serves the given MIME map. */
function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

/** Run the real WYSIWYG paste dispatcher against a mounted editor's view. */
function pasteInto(editor: Editor, data: Record<string, string>): boolean {
  return createHandlePaste({ mdManager })(editor.view, fakeDT(data));
}

/** A 2x2 GFM table: header row (a,b), one data row (c,d). */
const TABLE_MD = '| a | b |\n| - | - |\n| c | d |\n';

const CELL_NODES = new Set(['tableCell', 'tableHeader']);

let restoreDomGlobals: (() => void) | null = null;
const editors: Editor[] = [];

beforeAll(async () => {
  restoreDomGlobals = installDomGlobals();
  ({ createHandlePaste } = await import('../clipboard/handle-paste'));
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function mountGateEditor(content?: string | JSONContent): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content,
    extensions: [...coreExtensions, CellInsertionGate],
  });
  editors.push(editor);
  return editor;
}

/** Gate-less mount — fixture control proving a refused step is otherwise valid. */
function mountEditor(content?: string | JSONContent): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({ element: host, content, extensions: [...coreExtensions] });
  editors.push(editor);
  return editor;
}

/** A fresh block-component JSON (Callout wrapping one paragraph). */
function componentJSON(): JSONContent {
  return {
    type: 'jsxComponent',
    attrs: { componentName: 'Callout', sourceRaw: '<Callout>note</Callout>' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }],
  };
}

/** Caret position inside the first data cell's paragraph text. */
function firstDataCellCaret(editor: Editor): number {
  let cellPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cellPos === -1 && node.type.name === 'tableCell') {
      cellPos = pos;
      return false;
    }
    return true;
  });
  if (cellPos < 0) throw new Error('seed table has no tableCell');
  const caret = cellPos + 2; // cell open +1 → paragraph, +2 → paragraph text
  expect(editor.state.doc.resolve(caret).parent.type.name).toBe('paragraph');
  return caret;
}

/** Whether any jsxComponent in `doc` has a table-cell ancestor. */
function hasComponentInCell(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'jsxComponent') {
      const $pos = doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth--) {
        if (CELL_NODES.has($pos.node(depth).type.name)) {
          found = true;
          break;
        }
      }
    }
    return !found;
  });
  return found;
}

function countJsxComponents(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') count += 1;
    return true;
  });
  return count;
}

/** Table JSON whose first data cell already holds a component (un-owned state). */
function tableJsonWithComponentInCell(): JSONContent {
  const json = mdManager.parse(TABLE_MD) as JSONContent;
  const inject = (node: JSONContent): boolean => {
    if (node.type === 'tableCell') {
      node.content = [componentJSON()];
      return true;
    }
    if (node.content) {
      for (const child of node.content) if (inject(child)) return true;
    }
    return false;
  };
  if (!inject(json)) throw new Error('failed to inject component into a cell');
  return json;
}

describe('cell-insertion gate — command routes refuse component-into-cell', () => {
  test('insertContent of a component with the caret in a cell leaves the doc unchanged', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    const before = editor.state.doc;

    editor
      .chain()
      .setTextSelection(firstDataCellCaret(editor))
      .insertContent(componentJSON())
      .run();

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });

  test('insertContentAt targeting a cell position leaves the doc unchanged', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    const before = editor.state.doc;

    editor.commands.insertContentAt(firstDataCellCaret(editor), componentJSON());

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });

  test('insertJsxComponent with the caret in a cell leaves the doc unchanged', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    const before = editor.state.doc;

    editor
      .chain()
      .setTextSelection(firstDataCellCaret(editor))
      .insertJsxComponent('<Callout>note</Callout>')
      .run();

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });
});

describe('cell-insertion gate — permitted transactions', () => {
  test('the same component inserts normally at a top-level caret (control)', () => {
    const editor = mountGateEditor('<p>hello</p>');

    editor.chain().setTextSelection(1).insertContent(componentJSON()).run();

    expect(countJsxComponents(editor.state.doc)).toBe(1);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });

  test('ordinary text typing at a top-level caret is never filtered', () => {
    const editor = mountGateEditor('<p>hello</p>');
    const before = editor.state.doc;

    editor.chain().setTextSelection(3).insertContent('X').run();

    expect(editor.state.doc.eq(before)).toBe(false);
    expect(editor.state.doc.textContent).toContain('X');
  });

  test('a component-into-cell transaction carrying ySync meta is applied, not filtered', () => {
    // The exact insertContent transaction route 1 blocks, tagged as if it
    // arrived from the y-sync plugin (remote peer / y-undo replay). The gate
    // must let it through or this client's PM view desyncs from the Y.Doc.
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);

    editor
      .chain()
      .setTextSelection(firstDataCellCaret(editor))
      .insertContent(componentJSON())
      .command(({ tr }) => {
        tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
        return true;
      })
      .run();

    expect(hasComponentInCell(editor.state.doc)).toBe(true);
  });

  test('typing inside an existing component-in-cell (legacy state) is not filtered', () => {
    const editor = mountGateEditor(tableJsonWithComponentInCell());
    expect(hasComponentInCell(editor.state.doc)).toBe(true);
    const before = editor.state.doc;

    let componentPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (componentPos === -1 && node.type.name === 'jsxComponent') {
        componentPos = pos;
        return false;
      }
      return true;
    });
    const interiorCaret = componentPos + 2; // component open +1 → paragraph, +2 → text

    editor.chain().setTextSelection(interiorCaret).insertContent('Z').run();

    expect(editor.state.doc.eq(before)).toBe(false);
    expect(editor.state.doc.textContent).toContain('Z');
    expect(hasComponentInCell(editor.state.doc)).toBe(true);
  });
});

describe('cell-insertion gate — paste route refuses component-into-cell', () => {
  // An OK→OK copy of one block component carries both text/plain (canonical
  // markdown) and text/html (PM slice), so the dispatcher's markdown-first
  // tiebreak parses it through MarkdownManager into a jsxComponent. The
  // blank-line-wrapped form is what parses to a block (flow) element; the
  // inline `<Callout>note</Callout>` form parses to a paragraph instead.
  const COMPONENT_CLIPBOARD = {
    'text/plain': '<Callout>\n\nnote\n\n</Callout>\n',
    'text/html':
      '<div data-pm-slice="0 0 paragraph"><p>&lt;Callout&gt;note&lt;/Callout&gt;</p></div>',
  };

  test('pasting a block component with the caret in a cell claims the event and leaves the doc unchanged', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstDataCellCaret(editor));
    // Baseline captured after the caret lands: placing a selection after a
    // trailing table appends the schema's required trailing paragraph in its
    // own transaction, and that normalization is not what this test measures.
    const before = editor.state.doc;

    const handled = pasteInto(editor, COMPONENT_CLIPBOARD);

    // The dispatcher claims the paste (true) so no later branch re-inserts the
    // content; the gate filtered the applyJsonSlice dispatch, so the doc — and
    // the component count anywhere in it — is untouched.
    expect(handled).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(countJsxComponents(editor.state.doc)).toBe(0);
  });

  test('a mixed paste (component plus surrounding markdown) at a cell caret is refused whole', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstDataCellCaret(editor));
    const before = editor.state.doc;

    // Markdown-shaped payload (heading + list around the component) so the
    // markdown-first tiebreak parses it into blocks rather than falling to
    // the verbatim plain-text branch.
    const handled = pasteInto(editor, {
      'text/plain': '# heading before\n\n<Callout>\n\nnote\n\n</Callout>\n\n- item after\n',
      'text/html': '<div data-pm-slice="0 0 paragraph"><p>mixed</p></div>',
    });

    // Refusal is whole-transaction: no partial delivery of the blocks around
    // the component — silently delivering a subset would fabricate a state
    // the user never authored.
    expect(handled).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.doc.textContent).not.toContain('heading before');
    expect(editor.state.doc.textContent).not.toContain('item after');
  });

  test('the same component paste at a top-level caret inserts normally (control)', () => {
    const editor = mountGateEditor('<p></p>');
    editor.commands.setTextSelection(1);

    const handled = pasteInto(editor, COMPONENT_CLIPBOARD);

    expect(handled).toBe(true);
    expect(countJsxComponents(editor.state.doc)).toBe(1);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });

  test('pasting plain multi-block markdown without a component into a cell is not blocked', () => {
    const editor = mountGateEditor(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstDataCellCaret(editor));
    const before = editor.state.doc;

    const handled = pasteInto(editor, { 'text/plain': '**bold**\n\nsecond paragraph' });

    // No component in the payload → the gate does not fire; content inserts as
    // before (the shipped in-cell flatten happens later, on serialize).
    expect(handled).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(false);
    expect(editor.state.doc.textContent).toContain('bold');
    expect(editor.state.doc.textContent).toContain('second paragraph');
    expect(countJsxComponents(editor.state.doc)).toBe(0);
  });
});

describe('cell-insertion gate — drop and nested-table routes', () => {
  test('an internal drag-move of a top-level component onto a cell is refused; the component stays at origin', () => {
    const tableDoc = mdManager.parse(TABLE_MD) as JSONContent;
    const seed: JSONContent = {
      type: 'doc',
      content: [...(tableDoc.content ?? []), componentJSON()],
    };
    const editor = mountGateEditor(seed);
    const before = editor.state.doc;
    expect(countJsxComponents(before)).toBe(1);
    expect(hasComponentInCell(before)).toBe(false);

    // Locate the trailing top-level component (doc children are siblings).
    const comps: Array<{ node: ProseMirrorNode; from: number }> = [];
    before.forEach((node, offset) => {
      if (node.type.name === 'jsxComponent') comps.push({ node, from: offset });
    });
    const moved = comps[0];
    if (!moved) throw new Error('seed lost its top-level component');
    const cellCaret = firstDataCellCaret(editor);

    // Model PM's internal move as one transaction: delete the source, then
    // dropPoint + replaceRange the component into the cell — the primitive the
    // drop dispatcher's Branch-C `return false` hands off to PM.
    const slice = new Slice(Fragment.from(moved.node), 0, 0);
    const tr = editor.state.tr.delete(moved.from, moved.from + moved.node.nodeSize);
    const dropPos = dropPoint(tr.doc, tr.mapping.map(cellCaret), slice);
    if (dropPos == null) throw new Error('dropPoint found no position for the component');
    // Guard the fixture: the resolved drop must sit inside a cell, else a
    // non-cell landing would make the "refused" assertion vacuous.
    const $drop = tr.doc.resolve(dropPos);
    let dropInCell = false;
    for (let depth = $drop.depth; depth > 0; depth--) {
      if (CELL_NODES.has($drop.node(depth).type.name)) dropInCell = true;
    }
    expect(dropInCell).toBe(true);
    tr.replaceRange(dropPos, dropPos, slice);
    editor.view.dispatch(tr);

    // The whole move is refused: nothing landed in a cell and the component is
    // still exactly where it started.
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
    expect(countJsxComponents(editor.state.doc)).toBe(1);
  });

  test('inserting a table whose cell already holds a component is refused (nested shape)', () => {
    const editor = mountGateEditor('<p>hi</p>');
    const before = editor.state.doc;

    editor.chain().setTextSelection(1).insertContent(tableJsonWithComponentInCell()).run();

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
    expect(countJsxComponents(editor.state.doc)).toBe(0);
  });

  test('wrapping an existing component into a fresh table cell is refused (ReplaceAroundStep)', () => {
    // No user affordance performs this wrap today (the only table-creation
    // command inserts a new empty table), but the gate is route-agnostic: a
    // future command or extension issuing the wrap step must hit the same
    // refusal. Built as a raw ReplaceAroundStep so the step class itself is
    // exercised, not just ReplaceStep insertions.
    const seed: JSONContent = { type: 'doc', content: [componentJSON()] };
    const buildWrapStep = (doc: ProseMirrorNode) => {
      const schema = doc.type.schema;
      let compPos = -1;
      let compNode: ProseMirrorNode | null = null;
      doc.forEach((node, offset) => {
        if (compNode === null && node.type.name === 'jsxComponent') {
          compPos = offset;
          compNode = node;
        }
      });
      if (compNode === null) throw new Error('seed lost its component');
      const cell = schema.nodes.tableCell.create();
      const row = schema.nodes.tableRow.create(null, cell);
      const table = schema.nodes.table.create(null, row);
      const from = compPos;
      const to = compPos + (compNode as ProseMirrorNode).nodeSize;
      return new ReplaceAroundStep(
        from,
        to,
        from,
        to,
        new Slice(Fragment.from(table), 0, 0),
        3,
        true,
      );
    };

    // Fixture guard: without the gate, the identical step applies cleanly and
    // produces the component-in-cell state — so the refusal below is the
    // gate's doing, not step invalidity.
    const control = mountEditor(seed);
    const controlTr = control.state.tr.step(buildWrapStep(control.state.doc));
    control.view.dispatch(controlTr);
    expect(hasComponentInCell(control.state.doc)).toBe(true);

    const editor = mountGateEditor(seed);
    const before = editor.state.doc;
    const tr = editor.state.tr.step(buildWrapStep(editor.state.doc));
    editor.view.dispatch(tr);

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(hasComponentInCell(editor.state.doc)).toBe(false);
  });
});
