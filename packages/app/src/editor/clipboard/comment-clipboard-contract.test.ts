/**
 * Comment clipboard contract — `%%…%%` / `<!-- … -->` annotations.
 *
 * The contract: comments travel with copied content WITHIN OK (every
 * paste branch), and NEVER reach external targets in any clipboard
 * flavor. Concretely:
 *
 *   - text/plain and text/html (walker tier, markdown tier, cell tier)
 *     carry ZERO comment bytes — no visible `%%…%%`, no entity-escaped
 *     `<!-- -->` text, no hidden spans or HTML comments.
 *   - An OK-origin copy of a comment-bearing selection carries the full
 *     slice markdown (comments included) on a private clipboard flavor
 *     (`application/x-openknowledge-markdown`); the paste router prefers
 *     that flavor, so OK→OK paste restores the comment on every branch
 *     shape (pm-slice, markdown-first, generic-html).
 *   - Cut and copy behave identically with respect to comment carriage.
 *   - Copies with no comment content don't engage the private flavor at
 *     all (native behavior, byte-identical payloads).
 */

import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, test, vi } from 'vitest';

import { createHandlePaste } from './handle-paste.ts';
import { isMarkdown } from './is-markdown.ts';
import { createClipboardHtmlSerializer, createClipboardTextSerializer } from './serialize.ts';

/** The private OK→OK clipboard flavor. Pinned here as a contract constant. */
const INTERNAL_MIME = 'application/x-openknowledge-markdown';

const COMMENT_BYTE_PATTERNS = ['%%', '<!--', '&#x3C;!--', '&lt;!--', 'hidden note'];

function expectNoCommentBytes(payload: string): void {
  for (const pattern of COMMENT_BYTE_PATTERNS) {
    expect(payload).not.toContain(pattern);
  }
}

const md = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);
const textSerializer = createClipboardTextSerializer({ mdManager: md });

/** Build a real EditorState from markdown, select-all, and run the real text/plain serializer. */
function copyAllAsPlainText(markdown: string): string {
  const json = md.parse(markdown);
  const doc = schema.nodeFromJSON(json);
  const state = EditorState.create({ schema, doc });
  const sel = TextSelection.create(doc, 0, doc.content.size);
  const st = state.apply(state.tr.setSelection(sel));
  const view = { state: st } as unknown as Parameters<typeof textSerializer>[1];
  return textSerializer(st.selection.content(), view);
}

function findMarkNames(json: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(json)) {
    for (const c of json) findMarkNames(c, out);
    return out;
  }
  if (json && typeof json === 'object') {
    const o = json as { type?: string; marks?: { type: string }[]; content?: unknown };
    for (const m of o.marks ?? []) out.add(m.type);
    findMarkNames(o.content, out);
  }
  return out;
}

function findNodeTypes(json: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(json)) {
    for (const c of json) findNodeTypes(c, out);
    return out;
  }
  if (json && typeof json === 'object') {
    const o = json as { type?: string; content?: unknown };
    if (o.type) out.add(o.type);
    findNodeTypes(o.content, out);
  }
  return out;
}

// ─── text/plain: zero comment bytes ────────────────────────────────────

describe('text/plain (copy) omits comment constructs', () => {
  test('inline %%…%% comment is scrubbed from text/plain', () => {
    const out = copyAllAsPlainText('Plain prose before %%hidden note%% and after.');
    expectNoCommentBytes(out);
    expect(out).toContain('Plain prose before');
    expect(out).toContain('and after.');
  });

  test('inline <!-- … --> comment is scrubbed from text/plain', () => {
    const out = copyAllAsPlainText('Plain prose before <!-- hidden note --> and after.');
    expectNoCommentBytes(out);
    expect(out).toContain('Plain prose before');
  });

  test('block %% fence is scrubbed from text/plain', () => {
    const out = copyAllAsPlainText('Visible paragraph.\n\n%%\n\nsecret block body\n\n%%');
    expect(out).not.toContain('secret block body');
    expect(out).not.toContain('%%');
    expect(out).toContain('Visible paragraph.');
  });

  test('comment-only copy yields empty text/plain', () => {
    const out = copyAllAsPlainText('%%only a comment%%');
    expect(out.trim()).toBe('');
  });
});

// ─── isMarkdown gate: comment forms carry zero markdown signals ────────
// (Unchanged behavior, pinned: this is WHY text/plain cannot rescue an
// OK→OK paste and a private flavor is required.)

describe('isMarkdown gate — comment forms carry zero markdown signals', () => {
  test('plain prose + inline %% comment fails the gate', () => {
    expect(isMarkdown('Plain prose before %%hidden note%% and after.')).toBe(false);
  });

  test('plain prose + inline HTML comment fails the gate', () => {
    expect(isMarkdown('Plain prose before <!-- hidden note --> and after.')).toBe(false);
  });

  test('block %% fence alone fails the gate', () => {
    expect(isMarkdown('Visible paragraph.\n\n%%\n\nsecret block body\n\n%%')).toBe(false);
  });

  test('control: the same payload with one markdown signal passes the gate', () => {
    expect(isMarkdown('# Title\n\nProse with %%hidden note%% inside.')).toBe(true);
  });
});

// ─── markdown-tier text/html: zero comment bytes ───────────────────────

describe('markdown-tier text/html omits comment constructs', () => {
  let domInstalled = false;

  async function markdownTierHtmlFor(markdown: string): Promise<string> {
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    // No view attached → serializeFragment falls to the markdown tier.
    const handle = createClipboardHtmlSerializer({ mdManager: mgr });
    const doc = schema.nodeFromJSON(mgr.parse(markdown));
    const frag = handle.serializer.serializeFragment(doc.content, { document });
    const div = document.createElement('div');
    div.appendChild(frag);
    return div.innerHTML;
  }

  test('inline %% form is scrubbed from the markdown-tier payload', async () => {
    const html = await markdownTierHtmlFor('Plain prose before %%hidden note%% and after.');
    expectNoCommentBytes(html);
    expect(html).toContain('Plain prose before');
  });

  test('inline HTML form is scrubbed from the markdown-tier payload', async () => {
    const html = await markdownTierHtmlFor('Plain prose before <!-- hidden note --> and after.');
    expectNoCommentBytes(html);
    expect(html).toContain('Plain prose before');
  });

  test('block %% fence is scrubbed from the markdown-tier payload', async () => {
    const html = await markdownTierHtmlFor('Visible paragraph.\n\n%%\n\nsecret block body\n\n%%');
    expect(html).not.toContain('secret block body');
    expect(html).not.toContain('%%');
    expect(html).toContain('Visible paragraph.');
  });

  test('drag-style TextSelection (walker bails → markdown tier) is scrubbed', async () => {
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    const { Editor } = await import('@tiptap/core');
    const { TextSelection: TS } = await import('@tiptap/pm/state');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: sharedExtensions,
      content: mgr.parse('Prose before %%hidden note%% and after.\n\nSecond paragraph.'),
    });
    try {
      const view = editor.view;
      const handle = createClipboardHtmlSerializer({ mdManager: mgr });
      handle.setView(view);
      const doc = view.state.doc;
      view.dispatch(view.state.tr.setSelection(TS.create(doc, 1, doc.content.size - 1)));
      const slice = view.state.selection.content();
      const frag = handle.serializer.serializeFragment(slice.content, { document });
      const div = document.createElement('div');
      div.appendChild(frag);
      expectNoCommentBytes(div.innerHTML);
      expect(div.innerHTML).toContain('Prose before');
    } finally {
      editor.destroy();
    }
  });
});

// ─── walker tier: comment omission (already-enforced cells, pinned) ────

describe('walker tier (real EditorView, AllSelection) omits comment content', () => {
  let domInstalled = false;

  async function walkerHtmlFor(markdown: string): Promise<string> {
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    const { Editor } = await import('@tiptap/core');
    const { AllSelection } = await import('@tiptap/pm/state');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: sharedExtensions,
      content: mgr.parse(markdown),
    });
    try {
      const view = editor.view;
      const handle = createClipboardHtmlSerializer({ mdManager: mgr });
      handle.setView(view);
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      const slice = view.state.selection.content();
      const frag = handle.serializer.serializeFragment(slice.content, { document });
      const div = document.createElement('div');
      div.appendChild(frag);
      return div.innerHTML;
    } finally {
      editor.destroy();
    }
  }

  test('inline comment span is dropped from the walker payload', async () => {
    const html = await walkerHtmlFor(
      'Prose before %%hidden note%% and after.\n\nSecond paragraph.',
    );
    expect(html).toContain('Prose before');
    expect(html).toContain('Second paragraph.');
    expect(html).not.toContain('hidden note');
    expect(html).not.toContain('data-comment-mark');
  });

  test('top-level commentBlock is skipped by the walker payload', async () => {
    const html = await walkerHtmlFor('Visible paragraph.\n\n%%\n\nsecret block body\n\n%%');
    expect(html).toContain('Visible paragraph.');
    expect(html).not.toContain('secret block body');
  });

  test('comment-only selection yields an empty paragraph, zero comment bytes', async () => {
    // Documented external artifact for a comment-only copy: the walker keeps
    // the (now empty) paragraph so PM has an element to stamp data-pm-slice
    // on; external rich targets receive an empty paragraph, never bytes.
    const html = await walkerHtmlFor('%%only a comment%%');
    expect(html).toMatch(/<p[^>]*><\/p>/);
    expect(html).not.toContain('only a comment');
  });
});

// ─── copy/cut interception: the private OK flavor ──────────────────────

type CopyModule = typeof import('./handle-copy.ts');

async function loadCopyModule(): Promise<CopyModule | null> {
  try {
    return await import('./handle-copy.ts');
  } catch {
    return null;
  }
}

interface FakeClipboardData {
  data: Map<string, string>;
  types: string[];
  getData: (k: string) => string;
  setData: (k: string, v: string) => void;
  clearData: () => void;
}

function fakeClipboardEvent(): ClipboardEvent & { clipboardData: FakeClipboardData } {
  const data = new Map<string, string>();
  const clipboardData: FakeClipboardData = {
    data,
    get types() {
      return Array.from(data.keys());
    },
    getData: (k: string) => data.get(k) ?? '',
    setData: (k: string, v: string) => {
      data.set(k, v);
    },
    clearData: () => data.clear(),
  };
  return {
    clipboardData,
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent & { clipboardData: FakeClipboardData };
}

describe('copy/cut interception — private flavor carries the comment, public flavors do not', () => {
  let domInstalled = false;

  async function withEditor<T>(
    markdown: string,
    fn: (view: import('@tiptap/pm/view').EditorView) => Promise<T> | T,
  ): Promise<T> {
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    const { Editor } = await import('@tiptap/core');
    const { AllSelection } = await import('@tiptap/pm/state');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    // Mirror the production editorProps wiring (TiptapEditor.tsx): the
    // copy intercept delegates public flavors to these serializers via
    // view.serializeForClipboard.
    const htmlHandle = createClipboardHtmlSerializer({ mdManager: mgr });
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: sharedExtensions,
      content: mgr.parse(markdown),
      editorProps: {
        clipboardTextSerializer: createClipboardTextSerializer({ mdManager: mgr }),
        clipboardSerializer: htmlHandle.serializer,
      },
    });
    try {
      const view = editor.view;
      htmlHandle.setView(view);
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      return await fn(view);
    } finally {
      editor.destroy();
    }
  }

  test('copy sets the private flavor with comment bytes; public flavors are scrubbed', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    await withEditor('Prose before %%hidden note%% and after.', (view) => {
      const handler = mod.createCopyCutHandler({ mdManager: md });
      const event = fakeClipboardEvent();
      expect(handler(view, event, false)).toBe(true);
      const internal = event.clipboardData.getData(INTERNAL_MIME);
      expect(internal).toContain('%%hidden note%%');
      expectNoCommentBytes(event.clipboardData.getData('text/html'));
      expectNoCommentBytes(event.clipboardData.getData('text/plain'));
      expect(event.clipboardData.getData('text/plain')).toContain('Prose before');
    });
  });

  test('cut behaves identically to copy for comment carriage and deletes the selection', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    await withEditor('Prose before %%hidden note%% and after.', (view) => {
      const handler = mod.createCopyCutHandler({ mdManager: md });
      const event = fakeClipboardEvent();
      expect(handler(view, event, true)).toBe(true);
      expect(event.clipboardData.getData(INTERNAL_MIME)).toContain('%%hidden note%%');
      expectNoCommentBytes(event.clipboardData.getData('text/html'));
      expectNoCommentBytes(event.clipboardData.getData('text/plain'));
      expect(view.state.doc.textContent).toBe('');
    });
  });

  test('comment-only copy: private flavor carries the comment, public flavors are empty', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    await withEditor('%%only a comment%%', (view) => {
      const handler = mod.createCopyCutHandler({ mdManager: md });
      const event = fakeClipboardEvent();
      expect(handler(view, event, false)).toBe(true);
      expect(event.clipboardData.getData(INTERNAL_MIME)).toContain('%%only a comment%%');
      expect(event.clipboardData.getData('text/plain').trim()).toBe('');
      expect(event.clipboardData.getData('text/html')).not.toContain('only a comment');
    });
  });

  test('a selection with no comment content declines the intercept (native path)', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    await withEditor('Plain prose, no annotations.\n\nSecond paragraph.', (view) => {
      const handler = mod.createCopyCutHandler({ mdManager: md });
      const event = fakeClipboardEvent();
      expect(handler(view, event, false)).toBe(false);
      expect(event.clipboardData.types).toHaveLength(0);
    });
  });

  test('cell selection: public flavors scrubbed, NO private flavor (table convention)', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    const { Editor } = await import('@tiptap/core');
    const { CellSelection } = await import('@tiptap/pm/tables');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const htmlHandle = createClipboardHtmlSerializer({ mdManager: mgr });
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: sharedExtensions,
      content: mgr.parse('| a | b |\n| --- | --- |\n| %%hidden note%% x | d |'),
      editorProps: {
        clipboardTextSerializer: createClipboardTextSerializer({ mdManager: mgr }),
        clipboardSerializer: htmlHandle.serializer,
      },
    });
    try {
      const view = editor.view;
      htmlHandle.setView(view);
      const cellPositions: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
          cellPositions.push(pos);
        }
      });
      expect(cellPositions.length).toBeGreaterThanOrEqual(3);
      // Select the comment-bearing body cell (third cell: row 2, col 1).
      view.dispatch(
        view.state.tr.setSelection(CellSelection.create(view.state.doc, cellPositions[2])),
      );
      const handler = mod.createCopyCutHandler({ mdManager: mgr });
      const event = fakeClipboardEvent();
      expect(handler(view, event, false)).toBe(true);
      expectNoCommentBytes(event.clipboardData.getData('text/plain'));
      expectNoCommentBytes(event.clipboardData.getData('text/html'));
      expect(event.clipboardData.getData('text/plain')).toContain('x');
      expect(event.clipboardData.getData(INTERNAL_MIME)).toBe('');
    } finally {
      editor.destroy();
    }
  });

  test('interior selection: private flavor peels partial wrappers but keeps the comment', async () => {
    const mod = await loadCopyModule();
    if (!mod) expect.fail('handle-copy.ts missing — internal clipboard channel not implemented');
    const { installDomGlobals } = await import('../walk-currency-test-harness.ts');
    const { Editor } = await import('@tiptap/core');
    const { TextSelection: TS } = await import('@tiptap/pm/state');
    if (!domInstalled) {
      installDomGlobals();
      domInstalled = true;
    }
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const htmlHandle = createClipboardHtmlSerializer({ mdManager: mgr });
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: sharedExtensions,
      content: mgr.parse('> Quoted %%hidden note%% text tail'),
      editorProps: {
        clipboardTextSerializer: createClipboardTextSerializer({ mdManager: mgr }),
        clipboardSerializer: htmlHandle.serializer,
      },
    });
    try {
      const view = editor.view;
      htmlHandle.setView(view);
      const doc = view.state.doc;
      // Strict interior subset of the blockquote's text → the text/plain
      // carrier historically peeled the `> ` wrapper; the private flavor
      // must match that shape while keeping the comment bytes.
      view.dispatch(view.state.tr.setSelection(TS.create(doc, 3, doc.content.size - 3)));
      const handler = mod.createCopyCutHandler({ mdManager: mgr });
      const event = fakeClipboardEvent();
      expect(handler(view, event, false)).toBe(true);
      const internal = event.clipboardData.getData(INTERNAL_MIME);
      expect(internal).toContain('%%hidden note%%');
      expect(internal).not.toContain('>');
      expectNoCommentBytes(event.clipboardData.getData('text/plain'));
    } finally {
      editor.destroy();
    }
  });
});

// ─── paste router: the private flavor wins for OK-origin payloads ──────

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: {
      types: Object.keys(data),
      getData: (k: string) => data[k] ?? '',
    },
  } as unknown as ClipboardEvent;
}

// Narrow fake PM view (mirrors handle-paste.test.ts): the router only reads
// selection/codeBlock lookups before deciding a branch.
// biome-ignore lint/suspicious/noExplicitAny: narrow fake for router-only test
function fakeView(parentNodeName = 'paragraph'): any {
  const $from = {
    depth: 1,
    parent: { isTextblock: true },
    node: (_d: number) => ({ type: { name: parentNodeName } }),
  };
  return {
    state: {
      selection: { empty: true, from: 1, to: 1, $from, $to: $from },
      schema: {
        nodes: {},
        marks: {},
        text: (t: string) => ({ text: t }),
        nodeFromJSON: () => ({
          content: { size: 0, childCount: 0, forEach: () => {} },
          slice: () => ({}),
        }),
      },
      tr: {
        replaceSelectionWith: () => ({ setMeta: () => ({ scrollIntoView: () => ({}) }) }),
        replaceSelection: () => ({ setMeta: () => ({ scrollIntoView: () => ({}) }) }),
      },
    },
    dispatch: vi.fn(),
  };
}

describe('paste router — private flavor restores comments on every OK→OK branch shape', () => {
  const internalPayload = 'Plain prose before %%hidden note%% and after.';

  test('pm-slice shape (Branch C cell): private flavor wins, comment carried', () => {
    const mdManager = {
      parse: vi.fn(() => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
      })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake manager
    const handle = createHandlePaste({ mdManager: mdManager as any });
    const result = handle(
      fakeView(),
      fakeDT({
        [INTERNAL_MIME]: internalPayload,
        'text/html': '<p data-pm-slice="1 1 []">Plain prose before  and after.</p>',
        'text/plain': 'Plain prose before  and after.',
      }),
    );
    expect(result).toBe(true);
    expect(mdManager.parse).toHaveBeenCalledWith(internalPayload);
  });

  test('markdown-first shape (Branch B cell): private flavor wins, comment carried', () => {
    const mdManager = {
      parse: vi.fn(() => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
      })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake manager
    const handle = createHandlePaste({ mdManager: mdManager as any });
    const internalMd = '# Title\n\nProse with %%hidden note%% inside.';
    const result = handle(
      fakeView(),
      fakeDT({
        [INTERNAL_MIME]: internalMd,
        'text/html': '<h1 data-pm-slice="1 1 []">Title</h1><p>Prose with  inside.</p>',
        'text/plain': '# Title\n\nProse with  inside.',
      }),
    );
    expect(result).toBe(true);
    expect(mdManager.parse).toHaveBeenCalledWith(internalMd);
  });

  test('generic-html shape (Branch D cell): private flavor wins, comment carried', () => {
    const mdManager = {
      parse: vi.fn(() => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
      })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake manager
    const handle = createHandlePaste({ mdManager: mdManager as any });
    const result = handle(
      fakeView(),
      fakeDT({
        [INTERNAL_MIME]: internalPayload,
        'text/html': '<p>Plain prose before  and after.</p>',
        'text/plain': 'Plain prose before  and after.',
      }),
    );
    expect(result).toBe(true);
    expect(mdManager.parse).toHaveBeenCalledWith(internalPayload);
  });

  test('no private flavor + pm-slice + non-markdown plain → Branch C unchanged', () => {
    const mdManager = { parse: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: fake manager
    const handle = createHandlePaste({ mdManager: mdManager as any });
    const result = handle(
      fakeView(),
      fakeDT({
        'text/html': '<p data-pm-slice="1 1 []">Plain prose before  and after.</p>',
        'text/plain': 'Plain prose before  and after.',
      }),
    );
    expect(result).toBe(false);
    expect(mdManager.parse).not.toHaveBeenCalled();
  });

  test('codeBlock cursor gate precedes the private flavor (verbatim plain insert)', () => {
    const mdManager = { parse: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: fake manager
    const handle = createHandlePaste({ mdManager: mdManager as any });
    const view = fakeView('codeBlock');
    const result = handle(
      view,
      fakeDT({
        [INTERNAL_MIME]: internalPayload,
        'text/plain': 'Plain prose before  and after.',
      }),
    );
    expect(result).toBe(true);
    expect(mdManager.parse).not.toHaveBeenCalled();
    expect(view.dispatch).toHaveBeenCalled();
  });
});

// ─── carrier proof: mdManager.parse restores comment constructs ────────

describe('carrier proof — mdManager.parse restores comment constructs from the private flavor', () => {
  test('inline %% form re-parses to a comment mark', () => {
    const json = md.parse('Prose with %%hidden note%% inside.');
    expect(findMarkNames(json).has('comment')).toBe(true);
  });

  test('inline HTML form re-parses to a comment construct', () => {
    const json = md.parse('Prose with <!-- hidden note --> inside.');
    const kinds = new Set([...findMarkNames(json), ...findNodeTypes(json)]);
    expect(kinds.has('comment') || kinds.has('commentBlock')).toBe(true);
  });

  test('block %% fence re-parses to a commentBlock node', () => {
    const json = md.parse('Visible.\n\n%%\n\nsecret block body\n\n%%');
    expect(findNodeTypes(json).has('commentBlock')).toBe(true);
  });
});

// ─── renderHTML omission contract (attribute level, pinned) ────────────

describe('renderHTML stamps the clipboard opt-out attr', () => {
  test('comment mark renders with data-clipboard-omit="true" + display:none', () => {
    const json = md.parse('Prose with %%hidden note%% inside.');
    const doc = schema.nodeFromJSON(json);
    let found = false;
    doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === 'comment') {
          const spec = mark.type.spec.toDOM?.(mark, true);
          const attrs = (spec as [string, Record<string, string>])?.[1] ?? {};
          expect(attrs['data-clipboard-omit']).toBe('true');
          expect(attrs.style).toContain('display: none');
          found = true;
        }
      }
    });
    expect(found).toBe(true);
  });

  test('commentBlock renders with data-clipboard-omit="true" + display:none', () => {
    const json = md.parse('Visible.\n\n%%\n\nsecret block body\n\n%%');
    const doc = schema.nodeFromJSON(json);
    let found = false;
    doc.descendants((node) => {
      if (node.type.name === 'commentBlock') {
        const spec = node.type.spec.toDOM?.(node);
        const attrs = (spec as [string, Record<string, string>])?.[1] ?? {};
        expect(attrs['data-clipboard-omit']).toBe('true');
        expect(attrs.style).toContain('display: none');
        found = true;
      }
    });
    expect(found).toBe(true);
  });
});
