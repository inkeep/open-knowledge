import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { EditorView } from '@tiptap/pm/view';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createHandlePaste } from './handle-paste.ts';
import { createClipboardHtmlSerializer, createClipboardTextSerializer } from './serialize.ts';

const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const textSerialize = createClipboardTextSerializer({ mdManager });

function docFromMarkdown(md: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(md));
}

function rangeOf(doc: PmNode, needle: string, subFrom = 0, subTo = needle.length) {
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text?.includes(needle)) {
      const base = pos + (node.text?.indexOf(needle) ?? 0);
      from = base + subFrom;
      to = base + subTo;
    }
  });
  if (from === -1) throw new Error(`needle not found: ${JSON.stringify(needle)}`);
  return { from, to };
}

function rangeSpan(doc: PmNode, a: string, b: string) {
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (from === -1 && node.text.includes(a)) from = pos + node.text.indexOf(a);
      if (node.text.includes(b)) to = pos + node.text.indexOf(b) + b.length;
    }
  });
  if (from === -1 || to === -1) throw new Error(`span endpoints not found: ${a}..${b}`);
  return { from, to };
}

function copyText(md: string, range: { from: number; to: number }): string {
  const doc = docFromMarkdown(md);
  const selection = TextSelection.create(doc, range.from, range.to);
  const state = EditorState.create({ schema, doc, selection });
  return textSerialize(state.selection.content(), { state } as unknown as EditorView);
}

describe('open-depth guard — text/plain interior selections emit bare content (RED)', () => {
  test('a. blockquote interior → bare text, no "> " marker', () => {
    const out = copyText(
      '> run command now\n',
      rangeOf(docFromMarkdown('> run command now\n'), 'command'),
    );
    expect(out.trimEnd()).toBe('command');
    expect(out).not.toContain('>');
  });

  test('b. heading interior → bare text, no "# " marker', () => {
    const md = '# run command now\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'command'));
    expect(out.trimEnd()).toBe('command');
    expect(out).not.toContain('#');
  });

  test('c. bullet list item interior → bare text, no "- " marker (8a P5: "wo" in "two")', () => {
    const md = '- one\n- two\n- three\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'wo'));
    expect(out.trimEnd()).toBe('wo');
    expect(out).not.toMatch(/^\s*-\s/);
  });

  test('d. ordered list item interior → bare text, no "N. " marker', () => {
    const md = '1. one\n2. two\n3. three\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'wo'));
    expect(out.trimEnd()).toBe('wo');
    expect(out).not.toMatch(/^\s*\d+\.\s/);
  });

  test('e. task list item interior → bare text, no "- [ ] " marker', () => {
    const md = '- [ ] todo item\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'todo'));
    expect(out.trimEnd()).toBe('todo');
    expect(out).not.toContain('[ ]');
    expect(out).not.toContain('- [');
  });

  test('e2. full-item-text copy keeps the task marker (splice payload preserved)', () => {
    const md = '- [ ] alpha\n- [ ] bravo\n- [ ] charlie\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'bravo'));
    expect(out.trimEnd()).toBe('- [ ] bravo');
  });

  test('f. code block interior → bare text, no fence', () => {
    const md = '```\ncommand line\n```\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'command'));
    expect(out.trimEnd()).toBe('command');
    expect(out).not.toContain('```');
  });

  test('g. footnote definition interior → bare text, no "[^id]: " marker', () => {
    const md = '[^1]: footnote body\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'body'));
    expect(out.trimEnd()).toBe('body');
    expect(out).not.toContain('[^1]');
  });

  test('h. inline marks survive the unwrap: inline code stays `code`', () => {
    const md = '> run `command` now\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'command'));
    expect(out.trimEnd()).toBe('`command`');
    expect(out).not.toContain('>');
  });

  test('h. inline marks survive the unwrap: bold stays **strong**', () => {
    const md = '> run **command** now\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'command'));
    expect(out.trimEnd()).toBe('**command**');
    expect(out).not.toContain('>');
  });

  test('i. nested list item interior → no fabricated "- - " level (8c P4/E6)', () => {
    const md = '- one\n- two\n  - alpha\n  - beta\n- three\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'alph'));
    expect(out).not.toContain('- -');
    expect(out.trimEnd()).toBe('alph');
  });

  test('i2. full nested-item-text copy keeps a single correctly-grained marker (8c)', () => {
    const md = '- one\n- two\n  - alpha\n  - beta\n- three\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'alpha'));
    expect(out).not.toContain('- -');
    expect(out.trimEnd()).toBe('- alpha');
  });
});

describe('open-depth guard — text/plain interior selections spanning multiple items', () => {
  const spanInteriors = (doc: PmNode, a: string, b: string) => ({
    from: rangeOf(doc, a, 2).from,
    to: rangeOf(doc, b, 2).from,
  });

  test('j. two bullet items, partial span → bare text, no marker, non-empty', () => {
    const md = '- alpha\n- bravo\n- charlie\n';
    const doc = docFromMarkdown(md);
    const out = copyText(md, spanInteriors(doc, 'alpha', 'bravo'));
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('pha');
    expect(out).toContain('br');
    expect(out).not.toMatch(/^\s*-\s/);
  });

  test('k. two ordered items, partial span → bare text, no "N." marker', () => {
    const md = '1. alpha\n2. bravo\n3. charlie\n';
    const doc = docFromMarkdown(md);
    const out = copyText(md, spanInteriors(doc, 'alpha', 'bravo'));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/^\s*\d+\.\s/);
  });

  test('l. nested list, partial span of two sibling nested items → non-empty, no "- -"', () => {
    const md = '- one\n- two\n  - alpha\n  - beta\n- three\n';
    const doc = docFromMarkdown(md);
    const out = copyText(md, spanInteriors(doc, 'alpha', 'beta'));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('- -');
  });
});

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
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const rec = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(installed)) {
    prev.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return () => {
    for (const [k, d] of prev) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(rec, k);
    }
    dom.window.close();
  };
}

let restoreDomGlobals: (() => void) | null = null;
beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});
afterAll(() => {
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

function clipboardPayload(
  md: string,
  range: { from: number; to: number },
): { html: string; text: string; pmSlice: string | null; selectionType: string } {
  const doc = docFromMarkdown(md);
  const selection = TextSelection.create(doc, range.from, range.to);
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const htmlHandle = createClipboardHtmlSerializer({ mdManager });
  const view = new EditorView(mount, {
    state: EditorState.create({ schema, doc, selection }),
    clipboardTextSerializer: createClipboardTextSerializer({ mdManager }),
    clipboardSerializer: htmlHandle.serializer,
  });
  htmlHandle.setView(view);
  try {
    const selectionType =
      view.state.selection instanceof CellSelection ? 'CellSelection' : 'TextSelection';
    const { dom, text } = view.serializeForClipboard(view.state.selection.content());
    const sliceEl = dom.querySelector('[data-pm-slice]') as HTMLElement | null;
    return {
      html: dom.innerHTML,
      text,
      pmSlice: sliceEl?.getAttribute('data-pm-slice') ?? null,
      selectionType,
    };
  } finally {
    view.destroy();
    mount.remove();
  }
}

describe('open-depth guard — text/html twin, production payload (RED)', () => {
  test('blockquote spanning two quoted paragraphs → no <blockquote> wrapper', () => {
    const md = '> alpha here\n>\n> beta there\n';
    const doc = docFromMarkdown(md);
    const { html, selectionType } = clipboardPayload(md, rangeSpan(doc, 'alpha', 'beta'));
    expect(selectionType).toBe('TextSelection');
    expect(html).not.toContain('<blockquote');
  });

  test('heading interior → no <h1> wrapper', () => {
    const md = '# run command now\n';
    const doc = docFromMarkdown(md);
    const { html } = clipboardPayload(md, rangeOf(doc, 'command'));
    expect(html).not.toContain('<h1');
  });

  test('code block interior → no <pre> wrapper', () => {
    const md = '```\ncommand line\n```\n';
    const doc = docFromMarkdown(md);
    const { html } = clipboardPayload(md, rangeOf(doc, 'command'));
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('<code');
  });

  test('GREEN: data-pm-slice metadata is preserved for interior selections (OK→OK paste)', () => {
    const md = '# run command now\n';
    const doc = docFromMarkdown(md);
    const { pmSlice } = clipboardPayload(md, rangeOf(doc, 'command'));
    expect(pmSlice).not.toBeNull();
    expect(pmSlice).toMatch(/^\d+ \d+/);
  });
});

describe('open-depth guard — text/html twin, isolated serializer (RED)', () => {
  function htmlFromRawFragment(md: string, range: { from: number; to: number }): string {
    const doc = docFromMarkdown(md);
    const selection = TextSelection.create(doc, range.from, range.to);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const htmlHandle = createClipboardHtmlSerializer({ mdManager });
    const view = new EditorView(mount, {
      state: EditorState.create({ schema, doc, selection }),
    });
    htmlHandle.setView(view);
    try {
      const target = document.createDocumentFragment();
      const result = htmlHandle.serializer.serializeFragment(
        view.state.selection.content().content,
        undefined,
        target,
      );
      const wrap = document.createElement('div');
      wrap.appendChild(result as Node);
      return wrap.innerHTML;
    } finally {
      view.destroy();
      mount.remove();
    }
  }

  test('table-cell interior → no <table> wrapper', () => {
    const md = '| run command now |\n| --- |\n';
    const doc = docFromMarkdown(md);
    const html = htmlFromRawFragment(md, rangeOf(doc, 'command'));
    expect(html).not.toContain('<table');
  });

  test('blockquote interior → no <blockquote> wrapper', () => {
    const md = '> run command now\n';
    const doc = docFromMarkdown(md);
    const html = htmlFromRawFragment(md, rangeOf(doc, 'command'));
    expect(html).not.toContain('<blockquote');
  });
});

describe('open-depth guard — OK→OK paste round-trip of stripped payloads', () => {
  function pasteIntoParagraph(payload: { html: string; text: string }): PmNode {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const dest = new EditorView(mount, {
      state: EditorState.create({ schema, doc: docFromMarkdown('target paragraph here\n') }),
      handlePaste: createHandlePaste({ mdManager }),
    });
    try {
      const caret = rangeOf(dest.state.doc, 'paragraph').from;
      dest.dispatch(dest.state.tr.setSelection(TextSelection.create(dest.state.doc, caret, caret)));
      const dt = {
        types: ['text/plain', 'text/html'],
        getData: (mime: string) =>
          mime === 'text/plain' ? payload.text : mime === 'text/html' ? payload.html : '',
      };
      dest.pasteHTML(payload.html, { clipboardData: dt } as unknown as ClipboardEvent);
      return dest.state.doc;
    } finally {
      dest.destroy();
      mount.remove();
    }
  }

  function nodeTypeNames(doc: PmNode): Set<string> {
    const names = new Set<string>();
    doc.descendants((node) => {
      names.add(node.type.name);
    });
    return names;
  }

  test('heading interior copy pastes as plain text (no fabricated heading)', () => {
    const md = '# run command now\n';
    const doc = docFromMarkdown(md);
    const payload = clipboardPayload(md, rangeOf(doc, 'command'));
    const pasted = pasteIntoParagraph(payload);
    expect(pasted.textContent).toContain('command');
    expect(nodeTypeNames(pasted).has('heading')).toBe(false);
  });

  test('blockquote-span interior copy pastes without a fabricated blockquote', () => {
    const md = '> alpha here\n>\n> beta there\n';
    const doc = docFromMarkdown(md);
    const payload = clipboardPayload(md, rangeSpan(doc, 'alpha', 'beta'));
    const pasted = pasteIntoParagraph(payload);
    expect(pasted.textContent).toContain('alpha here');
    expect(pasted.textContent).toContain('beta');
    expect(nodeTypeNames(pasted).has('blockquote')).toBe(false);
  });
});

describe('open-depth guard — stay-green pins (whole-block copies preserved)', () => {
  test('whole-table copy (paragraph + table + paragraph) still emits table markdown (P8)', () => {
    const doc = schema.nodeFromJSON(
      mdManager.parse('before\n\n| H1 | H2 |\n| --- | --- |\n| a | b |\n\nafter\n'),
    );
    const state = EditorState.create({ schema, doc });
    const sel = TextSelection.create(doc, 1, doc.content.size - 1);
    const st = state.apply(state.tr.setSelection(sel));
    const out = textSerialize(st.selection.content(), { state: st } as unknown as EditorView);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('| H1 | H2 |');
    expect(out).toContain('| a | b |');
    expect(out).toMatch(/\|\s*-+\s*\|/);
  });

  test('whole-list copy (first char of first item → last char of last item) still emits list markdown', () => {
    const doc = docFromMarkdown('- one\n- two\n- three\n');
    const state = EditorState.create({ schema, doc });
    const sel = TextSelection.create(doc, 1, doc.content.size - 1);
    const st = state.apply(state.tr.setSelection(sel));
    const out = textSerialize(st.selection.content(), { state: st } as unknown as EditorView);
    expect(out).toContain('- one');
    expect(out).toContain('- two');
    expect(out).toContain('- three');
  });

  test('whole-blockquote copy (paragraph + blockquote + paragraph) still emits "> " syntax', () => {
    const doc = docFromMarkdown('before\n\n> quoted line\n\nafter\n');
    const state = EditorState.create({ schema, doc });
    const sel = TextSelection.create(doc, 1, doc.content.size - 1);
    const st = state.apply(state.tr.setSelection(sel));
    const out = textSerialize(st.selection.content(), { state: st } as unknown as EditorView);
    expect(out).toContain('> quoted line');
  });

  test('plain-paragraph interior control emits bare text (already correct; must stay)', () => {
    const md = 'some prose here\n';
    const out = copyText(md, rangeOf(docFromMarkdown(md), 'prose'));
    expect(out.trimEnd()).toBe('prose');
  });
});
