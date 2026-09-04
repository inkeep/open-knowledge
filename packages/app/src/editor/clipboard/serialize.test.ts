import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import type { Fragment } from '@tiptap/pm/model';
import { Fragment as PmFragment, type Node as PmNode, Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
  findDescriptorRoot,
  serializeCellSelectionAsText,
  sliceToDocJson,
  wrapAsTableFragment,
} from './serialize.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
});

function makeSlice(text: string) {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]);
  return doc.slice(0, doc.content.size);
}

function fakeMdManager() {
  return {
    serialize: vi.fn((doc: JSONContent) => {
      const p = doc.content?.[0]?.content?.[0]?.text ?? '';
      return `# ${p}`;
    }),
    parse: vi.fn(() => ({ type: 'doc', content: [] })),
  };
}

function fakeView() {
  return { state: { schema } } as unknown as Parameters<
    ReturnType<typeof createClipboardTextSerializer>
  >[1];
}

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

describe('createClipboardTextSerializer', () => {
  test('produces markdown from a slice via MarkdownManager.serialize', () => {
    const md = fakeMdManager();
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const text = serializer(makeSlice('hello'), fakeView());
    expect(text).toBe('# hello');
    expect(md.serialize).toHaveBeenCalledTimes(1);
  });

  test('falls through to PM textBetween on serialize throw', () => {
    const md = fakeMdManager();
    md.serialize = vi.fn(() => {
      throw new Error('boom');
    });
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const text = serializer(makeSlice('hello world'), fakeView());
    expect(text).toContain('hello world');
  });

  test('never throws — even on an empty-selection slice', () => {
    const md = fakeMdManager();
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const emptyDoc = schema.node('doc', null, [schema.node('paragraph')]);
    const slice = emptyDoc.slice(0, emptyDoc.content.size);
    expect(() => serializer(slice, fakeView())).not.toThrow();
  });
});

describe('createClipboardHtmlSerializer — walker→markdown tier dispatch', () => {
  function emptyFragment(): Fragment {
    return { firstChild: null } as unknown as Fragment;
  }

  function sentinelTarget(): DocumentFragment {
    return {} as DocumentFragment;
  }

  let warnCalls: string[];
  let innerOrigWarn: typeof console.warn;
  beforeEach(() => {
    warnCalls = [];
    innerOrigWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnCalls.push(typeof msg === 'string' ? msg : String(msg));
    };
  });
  afterEach(() => {
    console.warn = innerOrigWarn;
  });

  test('view attached + active selection + walker throws → catch fires + markdown tier returns target', () => {
    const view = {
      state: {
        selection: {
          from: 0,
          to: 5,
          content: () => {
            throw new Error('walker-boom');
          },
        },
      },
    } as unknown as EditorView;

    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    const failEvent = warnCalls.find((w) => w.includes('clipboard-serialize-failed'));
    expect(failEvent).toBeDefined();
    expect(failEvent).toContain('walker:walker-boom');

    expect(result).toBe(target);
  });

  test('no view attached → walker tier skipped → markdown tier returns target', () => {
    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    expect(warnCalls.find((w) => w.includes('walker:'))).toBeUndefined();
    expect(result).toBe(target);
  });

  test('collapsed selection (from === to) → walker tier skipped → markdown tier returns target', () => {
    const view = {
      state: {
        selection: {
          from: 0,
          to: 0,
          content: () => {
            throw new Error('should-not-be-called');
          },
        },
      },
    } as unknown as EditorView;

    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    expect(warnCalls.find((w) => w.includes('walker:'))).toBeUndefined();
    expect(result).toBe(target);
  });
});

describe('createClipboardHtmlSerializer — walker env wires markdown reconstruction', () => {
  let warnCalls: string[];
  let innerOrigWarn: typeof console.warn;
  beforeEach(() => {
    warnCalls = [];
    innerOrigWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnCalls.push(typeof msg === 'string' ? msg : String(msg));
    };
  });
  afterEach(() => {
    console.warn = innerOrigWarn;
  });

  test('walker tier receives an env with `serializeElementMarkdown` when view is attached', () => {
    const view = {
      posAtDOM: () => 0,
      state: {
        schema: {} as Schema,
        selection: {
          from: 0,
          to: 5,
          content: () => {
            throw new Error('walker-boom');
          },
        },
        doc: {
          nodeAt: () => null,
          slice: () => ({ content: { toJSON: () => [] } }),
        },
      },
    } as unknown as EditorView;
    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);
    const target = {} as DocumentFragment;
    handle.serializer.serializeFragment(
      { firstChild: null } as unknown as Fragment,
      undefined,
      target,
    );
    const failEvent = warnCalls.find((w) => w.includes('clipboard-serialize-failed'));
    expect(failEvent).toBeDefined();
    expect(failEvent).toContain('walker:walker-boom');
  });
});

interface FakeDescriptorElement {
  parentElement: FakeDescriptorElement | null;
  classes: Set<string>;
  attrs: Set<string>;
}

function makeDescriptorEl(opts?: { classes?: string[]; attrs?: string[] }): FakeDescriptorElement {
  return {
    parentElement: null,
    classes: new Set(opts?.classes ?? []),
    attrs: new Set(opts?.attrs ?? []),
  };
}

function chainDescriptorEls(...els: FakeDescriptorElement[]): FakeDescriptorElement {
  for (let i = 1; i < els.length; i++) {
    els[i].parentElement = els[i - 1];
  }
  return els[els.length - 1];
}

const descriptorWrappers = new WeakMap<FakeDescriptorElement, Element>();

function wrapDescriptor(el: FakeDescriptorElement): Element {
  const existing = descriptorWrappers.get(el);
  if (existing) return existing;
  const wrapper = {
    classList: { contains: (c: string) => el.classes.has(c) },
    hasAttribute: (a: string) => el.attrs.has(a),
    get parentElement() {
      return el.parentElement === null ? null : wrapDescriptor(el.parentElement);
    },
  } as unknown as Element;
  descriptorWrappers.set(el, wrapper);
  return wrapper;
}

describe('findDescriptorRoot — outermost-wrapper selection', () => {
  test('(a) bare element with only ProseMirror parent → returns null', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, img);
    expect(findDescriptorRoot(wrapDescriptor(live))).toBeNull();
  });

  test('(b) single .react-renderer wrapper → returns that wrapper', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const reactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, reactRenderer, img);
    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root?.classList.contains('react-renderer')).toBe(true);
  });

  test('(c) nested wrappers → returns the OUTERMOST wrapper (CRITICAL — load-bearing)', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const reactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const innerWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-jsx-component'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, reactRenderer, innerWrapper, img);

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root?.classList.contains('react-renderer')).toBe(true);
    expect(root?.hasAttribute('data-node-view-wrapper')).toBe(false);
  });

  test('(d) climbing stops at the .ProseMirror boundary', () => {
    const outerChrome = makeDescriptorEl({ classes: ['react-renderer'] });
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(outerChrome, proseMirror, img);

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).toBeNull();
  });

  test('(e) detached element with no .ProseMirror ancestor → returns null', () => {
    const detached = makeDescriptorEl();
    const root = findDescriptorRoot(wrapDescriptor(detached));
    expect(root).toBeNull();
  });

  test("(f) wrappers carrying `data-clipboard-inline-leaf` are skipped, including the same node view's outer .react-renderer (ImageInlineZoom opt-out)", () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const para = makeDescriptorEl();
    const outerReactRenderer = makeDescriptorEl({ classes: ['react-renderer', 'node-image'] });
    const inlineLeafWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-clipboard-inline-leaf'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, para, outerReactRenderer, inlineLeafWrapper, img);

    expect(findDescriptorRoot(wrapDescriptor(live))).toBeNull();
  });

  test("(g) opt-out neutralizes only the same node view's stack — a genuine descriptor ABOVE it still matches", () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const outerReactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const outerWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-jsx-component'],
    });
    const innerReactRenderer = makeDescriptorEl({ classes: ['react-renderer', 'node-image'] });
    const inlineLeafWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-clipboard-inline-leaf'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(
      proseMirror,
      outerReactRenderer,
      outerWrapper,
      innerReactRenderer,
      inlineLeafWrapper,
      img,
    );

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root).toBe(wrapDescriptor(outerReactRenderer));
    expect(root).not.toBe(wrapDescriptor(innerReactRenderer));
    expect(root).not.toBe(wrapDescriptor(inlineLeafWrapper));
  });
});

describe('sliceToDocJson — inline-first wrapping branch', () => {
  const inlineImageSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block',
        content: 'inline*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
      },
      image: {
        group: 'inline',
        inline: true,
        atom: true,
        attrs: { src: { default: '' }, alt: { default: '' } },
        toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt }],
        parseDOM: [{ tag: 'img' }],
      },
      text: { group: 'inline' },
    },
  });

  test('inline-first slice → wraps in paragraph, doc JSON contains image atom', () => {
    const img = inlineImageSchema.node('image', { src: 'cat.png', alt: 'cat' });
    const paragraph = inlineImageSchema.node('paragraph', null, [img]);
    const slice = paragraph.slice(0, paragraph.content.size);
    expect(slice.content.firstChild?.isInline).toBe(true);

    const docJson = sliceToDocJson(slice, inlineImageSchema);

    expect(docJson.type).toBe('doc');
    const firstBlock = docJson.content?.[0];
    expect(firstBlock?.type).toBe('paragraph');
    const firstInline = firstBlock?.content?.[0];
    expect(firstInline?.type).toBe('image');
    expect(firstInline?.attrs?.src).toBe('cat.png');
  });

  test('block-first slice → no wrap, doc JSON nests block directly under doc', () => {
    const img = inlineImageSchema.node('image', { src: 'cat.png', alt: 'cat' });
    const paragraph = inlineImageSchema.node('paragraph', null, [img]);
    const doc = inlineImageSchema.node('doc', null, [paragraph]);
    const slice = doc.slice(0, doc.content.size);
    expect(slice.content.firstChild?.isInline).toBe(false);
    expect(slice.content.firstChild?.type.name).toBe('paragraph');

    const docJson = sliceToDocJson(slice, inlineImageSchema);

    expect(docJson.type).toBe('doc');
    expect(docJson.content?.[0]?.type).toBe('paragraph');
    expect(docJson.content?.[0]?.content?.[0]?.type).toBe('image');
  });
});

const tableSchema = getSchema(sharedExtensions);

function tableCell(text: string, header = false): PmNode {
  const cellType = header ? tableSchema.nodes.tableHeader : tableSchema.nodes.tableCell;
  const p = tableSchema.nodes.paragraph.create(null, text ? [tableSchema.text(text)] : []);
  return cellType.createChecked(null, p);
}

function tableRow(cells: PmNode[]): PmNode {
  return tableSchema.nodes.tableRow.createChecked(null, cells);
}

function tableNode(rows: string[][]): PmNode {
  return tableSchema.nodes.table.createChecked(
    null,
    rows.map((r, i) => tableRow(r.map((c) => tableCell(c, i === 0)))),
  );
}

describe('wrapAsTableFragment — normalize CellSelection.content() shapes', () => {
  test('Fragment<table> → passed through unchanged', () => {
    const t = tableNode([
      ['H1', 'H2'],
      ['a', 'b'],
    ]);
    const input = PmFragment.from(t);
    const out = wrapAsTableFragment(input, tableSchema);
    expect(out.firstChild?.type).toBe(tableSchema.nodes.table);
    expect(out.childCount).toBe(1);
    expect(out.firstChild).toBe(t);
  });

  test('Fragment<tableRow> → wrapped in a table', () => {
    const row = tableRow([tableCell('a'), tableCell('b')]);
    const input = PmFragment.from(row);
    const out = wrapAsTableFragment(input, tableSchema);
    expect(out.firstChild?.type).toBe(tableSchema.nodes.table);
    const wrappedTable = out.firstChild;
    expect(wrappedTable?.childCount).toBe(1);
    const wrappedRow = wrappedTable?.child(0);
    expect(wrappedRow?.type).toBe(tableSchema.nodes.tableRow);
    expect(wrappedRow?.childCount).toBe(2);
    expect(wrappedRow?.child(0).textContent).toBe('a');
    expect(wrappedRow?.child(1).textContent).toBe('b');
  });

  test('Fragment<tableCell> → wrapped in row, then table', () => {
    const cell = tableCell('lone');
    const input = PmFragment.from(cell);
    const out = wrapAsTableFragment(input, tableSchema);
    expect(out.firstChild?.type).toBe(tableSchema.nodes.table);
    const wrappedRow = out.firstChild?.child(0);
    expect(wrappedRow?.type).toBe(tableSchema.nodes.tableRow);
    expect(wrappedRow?.child(0).textContent).toBe('lone');
  });

  test('empty fragment → returned as-is (no throw, no synthesis)', () => {
    const empty = PmFragment.empty;
    expect(wrapAsTableFragment(empty, tableSchema)).toBe(empty);
  });

  test('non-table schema → fragment returned unchanged', () => {
    const plainSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'text*' },
        text: {},
      },
    });
    const p = plainSchema.node('paragraph', null, [plainSchema.text('hello')]);
    const frag = PmFragment.from(p);
    expect(wrapAsTableFragment(frag, plainSchema)).toBe(frag);
  });
});

function tableStateWithSelection(
  rows: string[][],
  anchorCoords: [number, number],
  headCoords: [number, number],
) {
  const t = tableNode(rows);
  const doc = tableSchema.nodes.doc.create(null, t);
  const state = EditorState.create({ schema: tableSchema, doc });
  const tableStart = 1;
  const map = TableMap.get(t);
  const anchorPos = map.positionAt(anchorCoords[0], anchorCoords[1], t) + tableStart;
  const headPos = map.positionAt(headCoords[0], headCoords[1], t) + tableStart;
  const $anchor = state.doc.resolve(anchorPos);
  const $head = state.doc.resolve(headPos);
  const selection = new CellSelection($anchor, $head);
  const tr = state.tr.setSelection(selection as unknown as TextSelection);
  return state.apply(tr);
}

describe('serializeCellSelectionAsText — spreadsheet clipboard convention', () => {
  test('2×2 selection → two tab-separated rows joined with a newline', () => {
    const state = tableStateWithSelection(
      [
        ['Col X', 'Col Y'],
        ['Andrew', 'Sarah'],
        ['Robert', 'Miles'],
      ],
      [1, 0],
      [2, 1],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('Andrew\tSarah\nRobert\tMiles');
  });

  test('single-row multi-cell selection → one tab-separated row, no newline', () => {
    const state = tableStateWithSelection(
      [
        ['H1', 'H2', 'H3'],
        ['a', 'b', 'c'],
      ],
      [1, 0],
      [1, 2],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('a\tb\tc');
  });

  test('single-cell selection → cell text with no tabs, no newlines', () => {
    const state = tableStateWithSelection(
      [
        ['H1', 'H2'],
        ['a', 'b'],
      ],
      [1, 1],
      [1, 1],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('b');
  });

  test('whole-column selection → cells joined by newlines, no tabs', () => {
    const state = tableStateWithSelection(
      [
        ['H1', 'H2'],
        ['a', 'b'],
        ['c', 'd'],
      ],
      [0, 0],
      [2, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('H1\na\nc');
  });
});

describe('createClipboardTextSerializer — CellSelection routing decision', () => {
  test('CellSelection state → routes to spreadsheet text, skips markdown pipeline', () => {
    const state = tableStateWithSelection(
      [
        ['H1', 'H2'],
        ['a', 'b'],
        ['c', 'd'],
      ],
      [1, 0],
      [2, 1],
    );
    const md = fakeMdManager();
    md.serialize = vi.fn(() => 'MARKDOWN-PATH-FALLTHROUGH');
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const slice = state.selection.content();
    const text = serializer(slice, {
      state,
    } as unknown as Parameters<ReturnType<typeof createClipboardTextSerializer>>[1]);
    expect(text).toBe('a\tb\nc\td');
    expect(md.serialize).not.toHaveBeenCalled();
  });
});

const realMd = new MarkdownManager({ extensions: sharedExtensions });
const realTextSerializer = createClipboardTextSerializer({ mdManager: realMd });

function viewFor(state: EditorState) {
  return { state } as unknown as Parameters<typeof realTextSerializer>[1];
}

function singleCellTableDoc(text: string, markName?: string): PmNode {
  const marks = markName ? [tableSchema.marks[markName].create()] : undefined;
  const textNode = tableSchema.text(text, marks);
  const p = tableSchema.nodes.paragraph.create(null, [textNode]);
  const th = tableSchema.nodes.tableHeader.createChecked(null, p);
  const row = tableSchema.nodes.tableRow.createChecked(null, [th]);
  const table = tableSchema.nodes.table.createChecked(null, [row]);
  return tableSchema.nodes.doc.create(null, [table]);
}

function copyTextIn(doc: PmNode, needle: string, subFrom = 0, subTo = needle.length): string {
  const state = EditorState.create({ schema: tableSchema, doc });
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text?.includes(needle)) {
      const base = pos + node.text.indexOf(needle);
      from = base + subFrom;
      to = base + subTo;
    }
  });
  const sel = TextSelection.create(doc, from, to);
  const st = state.apply(state.tr.setSelection(sel));
  return realTextSerializer(st.selection.content(), viewFor(st));
}

describe('createClipboardTextSerializer — text selection inside one table cell', () => {
  test('inline-code cell → `command`, formatting kept, no table markup', () => {
    const out = copyTextIn(singleCellTableDoc('command', 'code'), 'command');
    expect(out.trimEnd()).toBe('`command`');
    expect(out).not.toContain('|');
  });

  test('sub-word selection inside an inline-code cell → the sub-word, still code', () => {
    const out = copyTextIn(singleCellTableDoc('npm run build', 'code'), 'npm run build', 4, 7);
    expect(out.trimEnd()).toBe('`run`');
    expect(out).not.toContain('|');
  });

  test('mixed inline marks in a cell are preserved, table markup is not', () => {
    const doc = tableSchema.nodes.doc.create(null, [
      tableSchema.nodes.table.createChecked(null, [
        tableSchema.nodes.tableRow.createChecked(null, [
          tableSchema.nodes.tableHeader.createChecked(
            null,
            tableSchema.nodes.paragraph.create(null, [
              tableSchema.text('run '),
              tableSchema.text('now', [tableSchema.marks.strong.create()]),
            ]),
          ),
        ]),
      ]),
    ]);
    const out = copyTextIn(doc, 'run ', 0, 7);
    expect(out.trimEnd()).toBe('run **now**');
    expect(out).not.toContain('|');
  });

  test('plain (unmarked) cell text → the text, no pipes', () => {
    const out = copyTextIn(singleCellTableDoc('hello world'), 'hello world');
    expect(out.trimEnd()).toBe('hello world');
    expect(out).not.toContain('|');
    expect(out).not.toContain('`');
  });

  test('selecting text in one body cell of a multi-row table → only that cell', () => {
    const doc = tableSchema.nodes.doc.create(
      null,
      tableNode([
        ['H1', 'H2'],
        ['alpha', 'bravo'],
        ['charlie', 'delta'],
      ]),
    );
    const out = copyTextIn(doc, 'bravo');
    expect(out.trimEnd()).toBe('bravo');
    expect(out).not.toContain('|');
    expect(out).not.toContain('alpha');
    expect(out).not.toContain('delta');
  });

  test('control: a text selection in a plain paragraph is untouched (markdown path)', () => {
    const doc = tableSchema.nodes.doc.create(null, [
      tableSchema.nodes.paragraph.create(null, [tableSchema.text('some prose here')]),
    ]);
    const out = copyTextIn(doc, 'some prose here');
    expect(out.trimEnd()).toBe('some prose here');
  });

  test('control: whole-doc selection spanning paragraph + table + paragraph keeps the table markup', () => {
    const doc = tableSchema.nodes.doc.create(null, [
      tableSchema.nodes.paragraph.create(null, [tableSchema.text('before')]),
      tableNode([
        ['H1', 'H2'],
        ['a', 'b'],
      ]),
      tableSchema.nodes.paragraph.create(null, [tableSchema.text('after')]),
    ]);
    const state = EditorState.create({ schema: tableSchema, doc });
    const sel = TextSelection.create(doc, 1, doc.content.size - 1);
    const st = state.apply(state.tr.setSelection(sel));
    const out = realTextSerializer(st.selection.content(), viewFor(st));
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('| H1 | H2 |');
    expect(out).toContain('| a | b |');
    expect(out).toMatch(/\|\s*-+\s*\|/);
  });
});
