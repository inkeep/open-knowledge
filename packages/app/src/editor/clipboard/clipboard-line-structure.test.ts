/**
 * Clipboard line-structure contract (WYSIWYG app tier): emission preserves
 * user-visible line structure in a destination-robust form.
 *
 * Domain invariant: every user-visible line break in the editor must be
 * encoded STRUCTURALLY (a `<br>` element or a block boundary) in the emitted
 * `text/html`. Foreign destinations (Gmail, Slack/Quill, Docs, Notion) are not
 * obligated to preserve the editor's inline `white-space` value or a raw `\n`
 * in character data — both collapse to a single space under default HTML
 * whitespace folding. The destination-robust carrier is a real `<br>`.
 *
 * The oracle here is DESTINATION-robust on purpose. It does NOT assert "the
 * emitted HTML carries `white-space: break-spaces`" — that would GREEN-wash the
 * bug, because the whole failure is that destinations drop that style. Instead
 * `visibleLines()` models default whitespace folding (`white-space: normal`,
 * ignoring inline styles): text-node whitespace runs collapse to a space,
 * `<br>` and block boundaries become line breaks. A break "survives" only if
 * the two user lines land on different visible lines under that model.
 *
 * Substrate: this file needs raw DOM globals for a real ProseMirror EditorView
 * plus the markdown-tier's `DOMParser` — but no React runtime — so it installs
 * jsdom in beforeAll and RESTORES the previous globals in afterAll (sibling
 * unit-tier files rely on the no-DOM contract). Same pattern as
 * `binding-staleness-guard.test.ts`.
 *
 * Sites covered:
 *   S1  walker tier — soft breaks (raw `\n` in a paragraph / blockquote / list
 *       item) must not depend on an inline `white-space` style to render, and
 *       code-block newlines must stay verbatim (never promoted to `<br>`).
 *   S3  reachability — the app clipboard emitter must not ship an empty (or
 *       break-dropped) text/html flavor when the markdown tier meets a void
 *       `<br>` (pre-fix `markdownToHtml` crashed / empty-spanned it).
 *   S5  CellSelection text/plain — a multi-line cell must emit a line
 *       separator, not `"line1line2"`; special-character cells follow the
 *       RFC 4180 quoting rules.
 *   S6  non-regression pins (green before and after the fix): whole-table
 *       walker copy keeps `<br>` in cells; paragraph boundaries stay separate
 *       lines (oracle validity).
 *   S7  OK→OK paste round-trip (green before and after the fix) — the
 *       CONSUMER side of the S1/S2 emission fix. A signal-less soft-break
 *       paragraph ("alpha\nbeta") carries no markdown signal, so OK→OK paste
 *       bypasses the markdown-first tiebreak (handle-paste.ts Branch B) and
 *       lands on Branch C: PM-native parse of the emitted `text/html`. The
 *       emission fix changed that `text/html` from a raw `\n` to a real
 *       `<br>`; this pins that the round-trip still preserves the two lines
 *       (PM's clipboard parse turns both the raw `\n` and the `<br>` into a
 *       hardBreak inside the `data-pm-slice` context — verified). No
 *       emission-only test observes the paste side, so an emission change
 *       could silently merge/corrupt the round-trip with nothing noticing.
 */

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

// ---------------------------------------------------------------------------
// jsdom substrate (scoped to this file — restored in afterAll)
// ---------------------------------------------------------------------------

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
  // The S7 tests drive the real paste dispatcher, which lazily attaches the
  // shift-tracker's singleton listeners to this file's jsdom window. Reset that
  // shared module state so a sibling clipboard test file (shift-tracker.test.ts)
  // can re-attach to its own fake window instead of inheriting a dead
  // attachment (the reset detaches from the exact window it wired).
  __resetShiftTrackerForTests();
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

// Silence the structured `clipboard-serialize-failed` telemetry the markdown
// tier emits when a serialize step throws — the pinned contract is the
// observable output, not the log line.
let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

// ---------------------------------------------------------------------------
// Destination-robust oracle: model default HTML whitespace folding
// ---------------------------------------------------------------------------

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
// Elements that introduce a line boundary in normal flow (a subset sufficient
// for the constructs under test: paragraphs, blockquotes, lists, tables).
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

/**
 * Render `node` the way a destination with default UA styles (and NO honoring
 * of inline `white-space`) would fold it into visible lines: whitespace runs in
 * text (including a raw `\n`) collapse to a single space; `<br>` and block
 * boundaries become newlines. Returns the non-empty, trimmed visible lines.
 */
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
    // Container nodes (DocumentFragment / Document) carry no visible text of
    // their own — descend into their children. The clipboard emitter returns a
    // DocumentFragment, so the walk root is usually one of these.
    for (const child of Array.from(n.childNodes)) walk(child);
  };
  walk(node);
  return buf
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Assert `first` and `second` render on DIFFERENT visible lines. */
function expectSeparateLines(root: Node, first: string, second: string): void {
  const lines = visibleLines(root);
  const iFirst = lines.findIndex((l) => l.includes(first));
  const iSecond = lines.findIndex((l) => l.includes(second));
  // Both lines present…
  expect(iFirst).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThanOrEqual(0);
  // …and `second` renders on a LATER visible line than `first`. A payload
  // carrying the break as a raw `\n` collapses to a space and both land on
  // the same line (iSecond === iFirst) — the defect this asserts against.
  expect(iSecond).toBeGreaterThan(iFirst);
}

// ---------------------------------------------------------------------------
// Harness — real schema + real EditorView + the production clipboard serializer
// ---------------------------------------------------------------------------

const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: sharedExtensions });

/** Parse markdown into a real PM doc node via the canonical manager. */
function docFromMarkdown(md: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(md));
}

/** Mount a real EditorView for `doc` on a fresh container in document.body. */
function mountView(doc: PmNode): EditorView {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, { state: EditorState.create({ schema, doc }) });
}

/** Drive the production text/html serializer over a whole-doc selection. */
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
  // Whole-block WYSIWYG selections route to the live-DOM walker. A soft break
  // (single `\n` in a text node) is cloned verbatim and its rendering rides on
  // the editor's `white-space` value — which the destination may strip.

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
    // Anti-GREEN-wash pin. Drive the walker with the PRODUCTION computed value
    // (`white-space: break-spaces`, as captured from the live editor). The
    // emitted <p> then literally carries that style AND a raw `\n`. A test that
    // asserted the style is present would pass — but under default whitespace
    // folding (a destination that drops the style) the two lines still merge.
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
    // Boundary of the soft-break promotion: inside `<pre>`/`<code>` a `\n` is
    // significant whitespace every destination already preserves, and a `<br>`
    // there is invisible to textContent-based readers — so the walker must
    // skip those subtrees entirely.
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
  // Partial-block selections / drag-out route to the markdown tier
  // (`sliceToMarkdown` → `markdownToHtml`). A slice carrying an html-style
  // hardBreak serializes to a literal `<br>`, which pre-fix made
  // `markdownToHtml` either crash (unclosed `<br>` → whole flavor swallowed)
  // or empty-span the break (`<br/>`). The contract is pinned at the emitter
  // boundary so a change that reroutes the callsite still has to satisfy it.

  test('an unclosed <br> fragment yields a NON-EMPTY text/html with the break intact', () => {
    const doc = docFromMarkdown('alpha<br>beta');
    const handle = createClipboardHtmlSerializer({ mdManager });
    // No view attached → the markdown tier fires (the drag-out / partial path).
    const target = document.createDocumentFragment();
    const result = handle.serializer.serializeFragment(doc.content, undefined, target);
    // Pre-fix: markdownToHtml threw, the catch swallowed it, text/html
    // shipped empty (childNodes === 0) and destinations fell back to raw
    // markdown.
    expect(result.childNodes.length).toBeGreaterThan(0);
    expectSeparateLines(result, 'alpha', 'beta');
    // …and the break is a real element, not character-data whitespace.
    const wrapper = document.createElement('div');
    wrapper.appendChild(result);
    expect(wrapper.querySelector('br')).not.toBeNull();
  });

  test('a self-closing <br/> fragment keeps the break (not an empty mdx-inline span)', () => {
    const doc = docFromMarkdown('alpha<br/>beta');
    const handle = createClipboardHtmlSerializer({ mdManager });
    const target = document.createDocumentFragment();
    const result = handle.serializer.serializeFragment(doc.content, undefined, target);
    // Pre-fix: non-empty, but the break rendered as `<span class="mdx-inline"></span>`
    // — an empty span — so the two lines merged in the destination.
    expectSeparateLines(result, 'alpha', 'beta');
    const wrapper = document.createElement('div');
    wrapper.appendChild(result);
    expect(wrapper.querySelector('span.mdx-inline:empty')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S5 — CellSelection text/plain multi-line cells
// ---------------------------------------------------------------------------

function cellNode(inline: PmNode[], header = false): PmNode {
  const cellType = header ? schema.nodes.tableHeader : schema.nodes.tableCell;
  return cellType.createChecked(null, schema.nodes.paragraph.create(null, inline));
}

/** Build an EditorState carrying a CellSelection over the given anchor→head cells. */
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

/** A multi-line cell body: `line1` + hardBreak + `line2`. */
function multiLineInline(a: string, b: string): PmNode[] {
  return [schema.text(a), schema.nodes.hardBreak.create(), schema.text(b)];
}

describe('serializeCellSelectionAsText — multi-line cells emit a line separator', () => {
  // The existing suite pins the spreadsheet convention: `\t` between cells,
  // `\n` between rows, single-line cells UNQUOTED. A cell that itself contains
  // a line break needs a form whose embedded newline is NOT confused with the
  // row separator. The defensible, standard encoding is the Excel / Google
  // Sheets clipboard-TSV rule (RFC 4180 §2.5-2.7 applied with `\t` as the
  // delimiter): a field containing a newline (or tab, or quote) is wrapped in
  // double quotes, internal quotes doubled. So `line1<br>line2` → `"line1\nline2"`.
  // Pre-fix `serializeCellSelectionAsText` pushed bare `cell.textContent`, and
  // PM renders a hardBreak as the empty string — the two lines
  // flush-concatenated.

  test('a single multi-line cell is quoted with its embedded newline preserved', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode(multiLineInline('line1', 'line2'))]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    // Pre-fix: "line1line2" (flush-concatenated, break gone).
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
    // The multi-line cell is quoted (its `\n` is not a row break); the plain
    // cell is unquoted; a tab separates them. Pre-fix: "ab\tplain".
    expect(text).toBe('"a\nb"\tplain');
  });

  test('a cell containing a tab is quoted so the tab is not read as a column boundary', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode([schema.text('col1\tcol2')])]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    // Unquoted, the embedded tab would split this one cell across two columns
    // in every spreadsheet paste handler.
    expect(text).toBe('"col1\tcol2"');
  });

  test('a cell containing a double quote is quoted with the quote doubled (RFC 4180 §2.7)', () => {
    const state = tableStateWithCells(
      [[cellNode([schema.text('H')], true)], [cellNode([schema.text('say "hi"')])]],
      [1, 0],
      [1, 0],
    );
    const text = serializeCellSelectionAsText(state.selection as CellSelection);
    // An undoubled internal quote breaks TSV field-boundary parsing.
    expect(text).toBe('"say ""hi"""');
  });

  test('a cell that is a single double quote encodes to the RFC 4180 degenerate quad-quote form', () => {
    // The minimal quoting boundary: content of exactly one quote wraps in
    // quotes (2) with the one internal quote doubled (2) = four quotes total.
    // Guards the encodeTsvField branch against an off-by-one in quote-doubling.
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
    // The whole-table (non-CellSelection) copy routes to the walker, which
    // clones the live DOM where PM already rendered the hardBreak as `<br>`.
    // This is correct today and must stay correct.
    const view = mountView(docFromMarkdown('| a |\n| - |\n| left<br>right |'));
    try {
      const result = emitClipboardHtml(view);
      const wrapper = document.createElement('div');
      wrapper.appendChild(result);
      expect(wrapper.querySelector('td br, th br')).not.toBeNull();
      // And the two in-cell lines are genuinely separate under the oracle.
      expectSeparateLines(wrapper, 'left', 'right');
    } finally {
      view.destroy();
    }
  });

  test('oracle validity: a real paragraph boundary already renders as two separate lines', () => {
    // Guards the oracle itself: two blank-line-separated paragraphs are a
    // legitimate block boundary and MUST read as separate lines (GREEN). If
    // this ever went red the oracle would be trivially failing every input.
    const view = mountView(docFromMarkdown('alpha\n\nbeta'));
    try {
      const result = emitClipboardHtml(view);
      expectSeparateLines(result, 'alpha', 'beta');
    } finally {
      view.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — OK→OK paste round-trip (the CONSUMER side of the emission fix)
// ---------------------------------------------------------------------------

/**
 * Emit the two clipboard flavors OK actually writes for a whole-doc selection,
 * exactly as production does:
 *   - `text/html` via the walker-first `clipboardSerializer.serializeFragment`,
 *     then the `data-pm-slice` attribute stamped on the first element the way
 *     PM's `serializeForClipboard` does downstream (see serialize.ts header).
 *     That attribute is what routes an OK→OK paste to Branch C.
 *   - `text/plain` via the production `clipboardTextSerializer` (markdown).
 */
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
    // Reproduce PM's serializeForClipboard: it stamps data-pm-slice on the
    // first element of whatever the serializer returns. `0 0 []` = a complete
    // block, no open ends, no surrounding context (a whole-paragraph copy).
    holder.firstElementChild?.setAttribute('data-pm-slice', '0 0 []');
    const html = holder.innerHTML;

    const textSerializer = createClipboardTextSerializer({ mdManager });
    const plain = textSerializer(slice, view);
    return { html, plain };
  } finally {
    view.destroy();
  }
}

/**
 * A DataTransfer/ClipboardEvent stand-in carrying the two flavors. The paste
 * dispatcher only touches `clipboardData.types` / `.getData(mime)` and
 * `pasteShiftHeld(event)` (which reads `event.shiftKey` — absent here, so
 * false), so a plain object is a faithful driver.
 */
function fakeClipboardEvent(plain: string, html: string): ClipboardEvent {
  const dt = {
    types: ['text/plain', 'text/html'],
    getData: (mime: string) => (mime === 'text/plain' ? plain : mime === 'text/html' ? html : ''),
  };
  return { clipboardData: dt } as unknown as ClipboardEvent;
}

/** Mount a paste target wired with the production paste dispatcher. */
function mountPasteTarget(): EditorView {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, {
    state: EditorState.create({ schema, doc: docFromMarkdown('placeholder') }),
    handlePaste: createHandlePaste({ mdManager }),
  });
}

/**
 * Drive the real OK→OK paste for a signal-less payload. `pasteHTML` runs PM's
 * `doPaste`: it parses the `text/html` via `parseFromClipboard`, calls the
 * wired dispatcher (which returns false for Branch C — verified separately),
 * then inserts the parsed slice. The returned doc is what actually landed.
 */
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

/**
 * Fold the PASTED PM document into visible lines. Unlike `visibleLines` (which
 * models a foreign destination folding emitted HTML), this reads the intended
 * line structure of OK's own doc: a `hardBreak` node AND a literal `\n` inside
 * a text node BOTH count as a line carrier, and block boundaries separate
 * lines. So the contract is line structure, not node identity — either carrier
 * passes; only a merged single text run ("alpha beta" / "alphabeta") fails.
 */
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

/** Assert the pasted doc keeps `first` and `second` on different visible lines. */
function expectPastedSeparateLines(doc: PmNode, first: string, second: string): void {
  const lines = pastedDocLines(doc);
  const iFirst = lines.findIndex((l) => l.includes(first));
  const iSecond = lines.findIndex((l) => l.includes(second));
  expect(iFirst).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThanOrEqual(0);
  // A merge (`alpha beta` collapsed to one text run) lands both on the same
  // line (iSecond === iFirst) — the round-trip corruption this pins against.
  expect(iSecond).toBeGreaterThan(iFirst);
}

describe('S7 — OK→OK paste round-trip: signal-less soft break (GREEN non-regression pin)', () => {
  // Green before and after the emission fix, which changed the emitted
  // `text/html` for a soft break from a raw `\n` to a `<br>`; because a
  // signal-less soft-break paragraph routes to Branch C (PM-native parse of
  // that `text/html`), this is the surface where the `<br>` emission is
  // CONSUMED. Empirically PM's clipboard parse maps BOTH the raw `\n`
  // (pre-fix) and the `<br>` (post-fix), inside the `data-pm-slice` context,
  // to a hardBreak — so the two lines survive either way. The pin guards that
  // an emission change does not silently regress the round-trip (merge lines
  // / drop the break), which no emission-only test would notice.

  test('routes to Branch C (PM-native), not the markdown tiebreak', () => {
    // The dispatch decision itself: the payload must be signal-less (so Branch B
    // does not claim it) yet carry `data-pm-slice` (so Branch C does).
    const { html, plain } = emitFlavors('alpha\nbeta');
    const event = fakeClipboardEvent(plain, html);
    const dt = event.clipboardData as unknown as DataTransfer;

    expect(detectSource(dt)).toBe('pm-origin'); // data-pm-slice present
    expect(isMarkdown(plain)).toBe(false); // signal-less → the Branch B tiebreak cannot fire

    // Branch C returns false so PM parses the text/html natively. A throwaway
    // view — the dispatcher does not mutate when it declines.
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

    // Binding contract: the two lines are NOT merged. Accepts either carrier.
    expectPastedSeparateLines(pasted, 'alpha', 'beta');

    // Companion observation (non-binding on the contract): a real structural
    // break carrier exists — a hardBreak node, identical pre- and post-fix.
    // `textContent` flattens the hardBreak to "" (→ "alphabeta"), so
    // we assert it did NOT collapse to a single space-joined run ("alpha beta"),
    // the Branch-D-style merge, and that a carrier node/newline is present.
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
  // The taskItem NodeView sets the checkbox state as a live DOM PROPERTY
  // (input.checked), never a `checked` attribute — so cloneNode(true), which
  // copies only attributes, drops it and a checked item pastes unchecked.
  // reflectCheckboxCheckedState recovers it from the paired live element.
  //
  // The reflection is unit-tested directly against a hand-built input rather
  // than end-to-end through the serializer: the harness mounts a bare
  // `new EditorView` with no nodeViews, so it renders task items via the
  // schema's toDOM (which DOES emit the `checked` attribute) — an end-to-end
  // test would clone the attribute path and green-wash the property-only bug.

  test('a checked checkbox reflects its live property onto the clone attribute', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    const clone = input.cloneNode(true) as HTMLInputElement;
    // Pre-condition (the bug): the attribute-only clone lost the property state.
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
    // Simulate the toDOM path: `checked` emitted as an attribute, but the live
    // property has since diverged to false — the reflection must REMOVE it.
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
