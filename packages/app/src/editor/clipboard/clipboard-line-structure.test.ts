import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { AllSelection, EditorState, type TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { EditorView } from '@tiptap/pm/view';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared';
import {
  reflectCheckboxCheckedState,
  walkLiveDomToInlineStyledFragment,
} from './clipboard-walker.ts';
import { detectSource } from './detect-source.ts';
import { createHandlePaste } from './handle-paste.ts';
import { isMarkdown } from './is-markdown.ts';
import {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
  serializeCellSelectionAsText,
} from './serialize.ts';
import { __resetShiftTrackerForTests } from './shift-tracker.ts';

function installDomGlobals(): () => void {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'http://localhost:5173',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const installed: Record<string, unknown> = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Document: win.Document,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Range: win.Range,
    DOMParser: win.DOMParser,
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    InputEvent: win.InputEvent,
    CompositionEvent: win.CompositionEvent,
    FocusEvent: win.FocusEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(installed)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalRecord, key);
      }
    }
    dom.window.close();
  };
}

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  __resetShiftTrackerForTests();
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'PRE',
  'SECTION',
  'ARTICLE',
  'HR',
]);

function visibleLines(node: Node): string[] {
  let buf = '';
  const walk = (n: Node): void => {
    if (n.nodeType === TEXT_NODE) {
      buf += (n.nodeValue ?? '').replace(/[\t\r\n\f ]+/g, ' ');
      return;
    }
    if (n.nodeType === ELEMENT_NODE) {
      const el = n as Element;
      if (el.tagName.toUpperCase() === 'BR') {
        buf += '\n';
        return;
      }
      const isBlock = BLOCK_TAGS.has(el.tagName.toUpperCase());
      if (isBlock) buf += '\n';
      for (const child of Array.from(el.childNodes)) walk(child);
      if (isBlock) buf += '\n';
      return;
    }
    for (const child of Array.from(n.childNodes)) walk(child);
  };
  walk(node);
  return buf
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function expectSeparateLines(root: Node, first: string, second: string): void {
  const lines = visibleLines(root);
  const iFirst = lines.findIndex((l) => l.includes(first));
  const iSecond = lines.findIndex((l) => l.includes(second));
  expect(iFirst).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThan(iFirst);
}

const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function docFromMarkdown(md: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(md));
}

function mountView(doc: PmNode): EditorView {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, { state: EditorState.create({ schema, doc }) });
}

function emitClipboardHtml(view: EditorView): DocumentFragment | HTMLElement {
  const handle = createClipboardHtmlSerializer({ mdManager });
  handle.setView(view);
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  const target = document.createDocumentFragment();
  return handle.serializer.serializeFragment(
    view.state.selection.content().content,
    undefined,
    target,
  );
}

describe('S1 — walker tier: soft breaks survive without relying on inline white-space', () => {
  test('a soft-break paragraph keeps its two lines apart in the emitted text/html', () => {
    const view = mountView(docFromMarkdown('alpha\nbeta'));
    try {
      const result = emitClipboardHtml(view);
      expectSeparateLines(result, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });

  test('a soft break inside a blockquote survives', () => {
    const view = mountView(docFromMarkdown('> alpha\n> beta'));
    try {
      const result = emitClipboardHtml(view);
      expectSeparateLines(result, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });

  test('a soft break inside a list item survives', () => {
    const view = mountView(docFromMarkdown('- alpha\n  beta'));
    try {
      const result = emitClipboardHtml(view);
      expectSeparateLines(result, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });

  test('inline white-space is NOT destination-robust: break-spaces alone still loses the line', () => {
    const view = mountView(docFromMarkdown('alpha\nbeta'));
    try {
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      const env = {
        getComputedStyle: () => ({
          getPropertyValue: (p: string) => (p === 'white-space' ? 'break-spaces' : ''),
        }),
      };
      const frag = walkLiveDomToInlineStyledFragment(view.state.selection.content(), view, env);
      expectSeparateLines(frag, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });

  test('code-block newlines are NOT promoted to <br> — significant whitespace stays verbatim', () => {
    const view = mountView(docFromMarkdown('```\nline1\nline2\n```'));
    try {
      const result = emitClipboardHtml(view);
      const wrapper = document.createElement('div');
      wrapper.appendChild(result);
      const pre = wrapper.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(wrapper.querySelector('pre br')).toBeNull();
      expect(pre?.textContent ?? '').toContain('line1\nline2');
    } finally {
      view.destroy();
    }
  });
});

describe('S3 — reachability: the app emitter never ships a break-dropped text/html on a void <br>', () => {
  test('an unclosed <br> fragment yields a NON-EMPTY text/html with the break intact', () => {
    const doc = docFromMarkdown('alpha<br>beta');
    const handle = createClipboardHtmlSerializer({ mdManager });
    const target = document.createDocumentFragment();
    const result = handle.serializer.serializeFragment(doc.content, undefined, target);
    expect(result.childNodes.length).toBeGreaterThan(0);
    expectSeparateLines(result, 'alpha', 'beta');
    const wrapper = document.createElement('div');
    wrapper.appendChild(result);
    expect(wrapper.querySelector('br')).not.toBeNull();
  });

  test('a self-closing <br/> fragment keeps the break (not an empty mdx-inline span)', () => {
    const doc = docFromMarkdown('alpha<br/>beta');
    const handle = createClipboardHtmlSerializer({ mdManager });
    const target = document.createDocumentFragment();
    const result = handle.serializer.serializeFragment(doc.content, undefined, target);
    expectSeparateLines(result, 'alpha', 'beta');
    const wrapper = document.createElement('div');
    wrapper.appendChild(result);
    expect(wrapper.querySelector('span.mdx-inline:empty')).toBeNull();
  });
});

function cellNode(inline: PmNode[], header = false): PmNode {
  const cellType = header ? schema.nodes.tableHeader : schema.nodes.tableCell;
  return cellType.createChecked(null, schema.nodes.paragraph.create(null, inline));
}

function tableStateWithCells(
  rows: PmNode[][],
  anchor: [number, number],
  head: [number, number],
): EditorState {
  const table = schema.nodes.table.createChecked(
    null,
    rows.map((cells) => schema.nodes.tableRow.createChecked(null, cells)),
  );
  const doc = schema.nodes.doc.create(null, table);
  const state = EditorState.create({ schema, doc });
  const tableStart = 1;
  const map = TableMap.get(table);
  const anchorPos = map.positionAt(anchor[0], anchor[1], table) + tableStart;
  const headPos = map.positionAt(head[0], head[1], table) + tableStart;
  const selection = new CellSelection(state.doc.resolve(anchorPos), state.doc.resolve(headPos));
  return state.apply(state.tr.setSelection(selection as unknown as TextSelection));
}

function multiLineInline(a: string, b: string): PmNode[] {
  return [schema.text(a), schema.nodes.hardBreak.create(), schema.text(b)];
}

describe('serializeCellSelectionAsText — multi-line cells emit a line separator', () => {
  test('a single multi-line cell is quoted with its embedded newline preserved', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode(multiLineInline('line1', 'line2'))]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('"line1\nline2"');
  });

  test('a multi-line cell alongside a plain cell stays disambiguated from the row separator', () => {
    const state = tableStateWithCells(
      [
        [cellNode([schema.text('H1')], true), cellNode([schema.text('H2')], true)],
        [cellNode(multiLineInline('a', 'b')), cellNode([schema.text('plain')])],
      ],
      [1, 0],
      [1, 1],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('"a\nb"\tplain');
  });

  test('a cell containing a tab is quoted so the tab is not read as a column boundary', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode([schema.text('col1\tcol2')])]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('"col1\tcol2"');
  });

  test('a cell containing a double quote is quoted with the quote doubled (RFC 4180 §2.7)', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode([schema.text('say "hi"')])]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('"say ""hi"""');
  });

  test('a cell that is a single double quote encodes to the RFC 4180 degenerate quad-quote form', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode([schema.text('"')])]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    expect(text).toBe('""""');
  });
});

describe('S6 — non-regression pins (green before and after the fix)', () => {
  test('whole-table walker copy keeps a real <br> inside a multi-line cell', () => {
    const view = mountView(docFromMarkdown('| a |\n| - |\n| left<br>right |'));
    try {
      const result = emitClipboardHtml(view);
      const wrapper = document.createElement('div');
      wrapper.appendChild(result);
      expect(wrapper.querySelector('td br, th br')).not.toBeNull();
      expectSeparateLines(wrapper, 'left', 'right');
    } finally {
      view.destroy();
    }
  });

  test('oracle validity: a real paragraph boundary already renders as two separate lines', () => {
    const view = mountView(docFromMarkdown('alpha\n\nbeta'));
    try {
      const result = emitClipboardHtml(view);
      expectSeparateLines(result, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });
});

function emitFlavors(md: string): { html: string; plain: string } {
  const view = mountView(docFromMarkdown(md));
  try {
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const slice = view.state.selection.content();

    const htmlHandle = createClipboardHtmlSerializer({ mdManager });
    htmlHandle.setView(view);
    const frag = htmlHandle.serializer.serializeFragment(
      slice.content,
      undefined,
      document.createDocumentFragment(),
    );
    const holder = document.createElement('div');
    holder.appendChild(frag as Node);
    holder.firstElementChild?.setAttribute('data-pm-slice', '0 0 []');
    const html = holder.innerHTML;

    const textSerializer = createClipboardTextSerializer({ mdManager });
    const plain = textSerializer(slice, view);
    return { html, plain };
  } finally {
    view.destroy();
  }
}

function fakeClipboardEvent(plain: string, html: string): ClipboardEvent {
  const dt = {
    types: ['text/plain', 'text/html'],
    getData: (mime: string) => (mime === 'text/plain' ? plain : mime === 'text/html' ? html : ''),
  };
  return { clipboardData: dt } as unknown as ClipboardEvent;
}

function mountPasteTarget(): EditorView {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, {
    state: EditorState.create({ schema, doc: docFromMarkdown('placeholder') }),
    handlePaste: createHandlePaste({ mdManager }),
  });
}

function pasteOkToOk(plain: string, html: string): PmNode {
  const dest = mountPasteTarget();
  try {
    dest.dispatch(dest.state.tr.setSelection(new AllSelection(dest.state.doc)));
    dest.pasteHTML(html, fakeClipboardEvent(plain, html));
    return dest.state.doc;
  } finally {
    dest.destroy();
  }
}

function pastedDocLines(doc: PmNode): string[] {
  const lines: string[] = [];
  let cur = '';
  const flush = (): void => {
    const trimmed = cur.trim();
    if (trimmed.length > 0) lines.push(trimmed);
    cur = '';
  };
  doc.descendants((node) => {
    if (node.isText) {
      const parts = (node.text ?? '').split('\n');
      cur += parts[0];
      for (let i = 1; i < parts.length; i++) {
        flush();
        cur += parts[i];
      }
      return false;
    }
    if (node.type.name === 'hardBreak') {
      flush();
      return false;
    }
    if (node.isBlock) {
      flush();
      return true;
    }
    return true;
  });
  flush();
  return lines;
}

function expectPastedSeparateLines(doc: PmNode, first: string, second: string): void {
  const lines = pastedDocLines(doc);
  const iFirst = lines.findIndex((l) => l.includes(first));
  const iSecond = lines.findIndex((l) => l.includes(second));
  expect(iFirst).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThan(iFirst);
}

describe('S7 — OK→OK paste round-trip: signal-less soft break (GREEN non-regression pin)', () => {
  test('routes to Branch C (PM-native), not the markdown tiebreak', () => {
    const { html, plain } = emitFlavors('alpha\nbeta');
    const event = fakeClipboardEvent(plain, html);
    const dt = event.clipboardData as unknown as DataTransfer;

    expect(detectSource(dt)).toBe('pm-origin');
    expect(isMarkdown(plain)).toBe(false);

    const probe = mountView(docFromMarkdown('placeholder'));
    try {
      const handled = createHandlePaste({ mdManager })(probe, event);
      expect(handled).toBe(false);
    } finally {
      probe.destroy();
    }
  });

  test('copy→paste keeps the two lines separate (soft break or hardBreak carrier)', () => {
    const { html, plain } = emitFlavors('alpha\nbeta');
    const pasted = pasteOkToOk(plain, html);

    expectPastedSeparateLines(pasted, 'alpha', 'beta');

    expect(pasted.textContent).not.toBe('alpha beta');
    let hasCarrier = false;
    pasted.descendants((node) => {
      if (node.type.name === 'hardBreak') hasCarrier = true;
      if (node.isText && (node.text ?? '').includes('\n')) hasCarrier = true;
      return true;
    });
    expect(hasCarrier).toBe(true);
  });
});

describe('S10 — task checkbox checked-state survives the walker clone', () => {
  test('a checked checkbox reflects its live property onto the clone attribute', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    const clone = input.cloneNode(true) as HTMLInputElement;
    expect(clone.hasAttribute('checked')).toBe(false);

    reflectCheckboxCheckedState(input, clone);
    expect(clone.getAttribute('checked')).toBe('');
  });

  test('an unchecked checkbox leaves no checked attribute on the clone', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = false;
    const clone = input.cloneNode(true) as HTMLInputElement;
    reflectCheckboxCheckedState(input, clone);
    expect(clone.hasAttribute('checked')).toBe(false);
  });

  test('an unchecked checkbox removes a pre-existing checked attribute from the clone', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = false;
    const clone = input.cloneNode(true) as HTMLInputElement;
    clone.setAttribute('checked', '');
    expect(clone.hasAttribute('checked')).toBe(true);

    reflectCheckboxCheckedState(input, clone);
    expect(clone.hasAttribute('checked')).toBe(false);
  });

  test('a non-checkbox input is left untouched', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'hello';
    const clone = input.cloneNode(true) as HTMLInputElement;
    reflectCheckboxCheckedState(input, clone);
    expect(clone.hasAttribute('checked')).toBe(false);
  });

  test('a non-input element is left untouched', () => {
    const div = document.createElement('div');
    const clone = div.cloneNode(true) as HTMLElement;
    reflectCheckboxCheckedState(div, clone);
    expect(clone.hasAttribute('checked')).toBe(false);
  });
});
