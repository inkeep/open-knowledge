/**
 * Branch-routing tests for the WYSIWYG paste dispatcher.
 *
 * The dispatcher is a priority-ordered series of guards:
 *   0. Cmd+Shift+V escape hatch
 *   0. Cursor-in-codeBlock short-circuit
 *   0. Lone-URL step: single-URL payloads linkify (over-selection keeps
 *      the selected text; cursor converts GFM shapes via the markdown
 *      parse); everything else falls through
 *   A. vscode-editor-data → fenced code block
 *   B. text/x-gfm → MarkdownManager.parse
 *   B. Markdown-first tiebreak: plain (markdown-shaped) + html → mdManager.parse(plain).
 *      Runs ahead of Branch C so OK→OK and cross-PM-editor pastes route
 *      through the canonical text/plain markdown bytes.
 *   C. data-pm-slice → PM native parseFromClipboard (return false). Reached
 *      only when the markdown-first tiebreak above did not fire.
 *   D. Generic HTML → shared htmlToMdast pipeline
 *   E. text/plain only → markdown-first if threshold hit, else verbatim
 *
 * Each test arranges a DataTransfer + empty doc and asserts which branch
 * fired, via the dispatcher's return value and its side effects on the
 * fake view. We use a narrow fake EditorView since the real one requires
 * a full schema + document; the dispatcher only touches a small surface
 * (`state.selection`, `state.schema.nodes.codeBlock`, `state.schema.text`,
 * `state.tr.*`, `dispatch`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualCore from '@inkeep/open-knowledge-core';
import { LinkFidelity, MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as actualSonner from 'sonner';

import { GfmAutolink } from '../gfm-autolink-plugin.ts';
import { flushMicrotasksAndTimers, installDomGlobals } from '../walk-currency-test-harness.ts';

// Mock the shared pipeline so tests don't exercise the full rehype stack.
mock.module('@inkeep/open-knowledge-core', () => {
  return {
    ...actualCore,
    htmlToMdast: mock((_html: string) => ({ type: 'root', children: [] })),
    mdastToMarkdown: mock((_tree: unknown) => '**bold**'),
  };
});

// Mock sonner to no-op toasts — we don't assert on them here.
mock.module('sonner', () => ({ ...actualSonner, toast: { error: mock(() => {}) } }));

// The dispatcher imports the mocked `@inkeep/open-knowledge-core`; bind it after
// the mock is registered so the stubbed htmlToMdast/mdastToMarkdown take effect
// (the mock facade only rewrites imports resolved after the doMock call).
let createHandlePaste: typeof import('./handle-paste.ts').createHandlePaste;
beforeAll(async () => {
  ({ createHandlePaste } = await import('./handle-paste.ts'));
});

function fakeDT(data: Record<string, string>): ClipboardEvent {
  const evt = {
    clipboardData: {
      types: Object.keys(data),
      getData: (k: string) => data[k] ?? '',
    },
  } as unknown as ClipboardEvent;
  return evt;
}

function fakeMdManager() {
  return {
    parse: mock((_md: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parsed' }] }],
    })),
  };
}

// Fake PM view: only the fields the dispatcher reads.
// biome-ignore lint/suspicious/noExplicitAny: narrow fake view for unit test
function fakeView(opts: { inCodeBlock?: boolean } = {}): any {
  const dispatch = mock(() => {});
  const codeBlockType = {
    create: mock((_attrs: unknown, _content: unknown) => ({
      slice: (_f: number, _t: number) => 'CODE-SLICE',
    })),
  };
  // Simulated $from $node chain: if inCodeBlock, one node at depth is named 'codeBlock'.
  const $from = {
    depth: 1,
    node: (_d: number) => ({ type: { name: opts.inCodeBlock ? 'codeBlock' : 'paragraph' } }),
  };
  return {
    state: {
      selection: { $from, empty: true },
      schema: {
        nodes: { codeBlock: codeBlockType },
        text: (s: string) => ({ textContent: s }),
        // biome-ignore lint/suspicious/noExplicitAny: fake schema for unit test
        nodeFromJSON: (json: any) => ({
          slice: (_f: number, _t: number) => ({ json, size: 10, content: { size: 10 } }),
          // fakeMdManager parses to a single non-list block; model the fragment
          // shape applyJsonSlice's list-splice check reads (childCount + forEach)
          // so it recognizes "not all lists" and takes the closed-slice path.
          content: {
            size: 10,
            childCount: 1,
            // biome-ignore lint/suspicious/noExplicitAny: fake fragment child
            forEach: (fn: (child: any) => void) => fn({ type: { name: 'paragraph' } }),
          },
        }),
      },
      tr: {
        replaceSelectionWith: mock(function (this: unknown, _node: unknown) {
          return this;
        }),
        replaceSelection: mock(function (this: unknown, _slice: unknown) {
          return this;
        }),
        setMeta: mock(function (this: unknown, _key: unknown, _value: unknown) {
          return this;
        }),
        scrollIntoView: mock(function (this: unknown) {
          return this;
        }),
      },
    },
    dispatch,
  };
}

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

describe('WYSIWYG paste dispatcher — branch routing', () => {
  test('empty clipboard returns false (PM default runs)', () => {
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = {
      clipboardData: { types: [] as string[], getData: () => '' },
    } as unknown as ClipboardEvent;
    expect(paste(view, evt)).toBe(false);
  });

  test('FR-10: cursor-in-codeBlock short-circuits to plain-text insert', () => {
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView({ inCodeBlock: true });
    const evt = fakeDT({ 'text/plain': 'raw code', 'text/html': '<b>bold</b>' });
    expect(paste(view, evt)).toBe(true);
    // Plain text was dispatched, not parsed as markdown or HTML.
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('Branch A: vscode-editor-data produces a codeBlock with language', () => {
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'vscode-editor-data': '{"mode":"typescript"}',
      'text/plain': 'const x = 1;',
    });
    expect(paste(view, evt)).toBe(true);
    expect(view.state.schema.nodes.codeBlock.create).toHaveBeenCalledWith(
      { language: 'typescript' },
      expect.anything(),
    );
  });

  test('Branch A: unsanitized language falls back to empty lang string', () => {
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      // Newline + fence char would break out of the fence — dispatcher must reject.
      'vscode-editor-data': '{"mode":"ts\\n```evil"}',
      'text/plain': 'code',
    });
    paste(view, evt);
    expect(view.state.schema.nodes.codeBlock.create).toHaveBeenCalledWith(
      { language: '' },
      expect.anything(),
    );
  });

  test('Branch A: malformed vscode-editor-data JSON falls through to a later branch', () => {
    // The dispatcher's catch contract: when `JSON.parse` throws on
    // malformed VS Code metadata, `tryBranchA` returns false (not throws),
    // emits structured telemetry, and the dispatcher continues to the next
    // branch. Without this contract, every paste from a misbehaving VS
    // Code extension would die with an uncaught throw and lose the user's
    // content. Pin the behavior so a refactor can't silently remove the
    // catch.
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      // Truncated / non-JSON metadata — `JSON.parse` throws.
      'vscode-editor-data': '{not json',
      'text/plain': 'fallback content',
    });
    // Returns true because a later branch (Branch E text/plain markdown
    // tiebreak — `fallback content` is plain prose so isMarkdown returns
    // false → CM6-default verbatim insert via Branch E) handles the
    // payload. The exact branch isn't load-bearing here — the test pins
    // that the catch path returned false so the dispatcher could continue
    // (i.e., the throw didn't escape).
    expect(paste(view, evt)).toBe(true);
    // Branch A's codeBlock.create must NOT have been called — the throw
    // happened before dispatch.
    expect(view.state.schema.nodes.codeBlock.create).not.toHaveBeenCalled();
  });

  test('Branch B: a throwing mdManager.parse falls through instead of escaping', () => {
    // tryBranchMarkdown shares the parse->apply path with Branch E and the
    // lone-URL cursor branch; its catch contract (return false, dispatcher
    // continues) is as load-bearing as Branch A's. A narrowed/removed catch
    // would lose the user's clipboard content with an uncaught throw.
    const throwingMd = {
      parse: mock(() => {
        throw new Error('parse exploded');
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
    const paste = createHandlePaste({ mdManager: throwingMd as any });
    const view = fakeView();
    const evt = fakeDT({ 'text/x-gfm': '# heading', 'text/plain': '# heading' });
    expect(paste(view, evt)).toBe(true);
    expect(throwingMd.parse).toHaveBeenCalled();
  });

  test('lone-URL cursor paste: a throwing mdManager.parse falls through to plain insert', () => {
    const throwingMd = {
      parse: mock(() => {
        throw new Error('parse exploded');
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
    const paste = createHandlePaste({ mdManager: throwingMd as any });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'https://example.com' });
    expect(paste(view, evt)).toBe(true);
    expect(throwingMd.parse).toHaveBeenCalled();
    // The URL still reached the doc via a later branch's dispatch.
    expect(view.dispatch).toHaveBeenCalled();
  });

  test('Branch C: data-pm-slice fingerprint returns false (PM handles)', () => {
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/html': '<div data-pm-slice="0 0 paragraph"><p>hi</p></div>',
      'text/plain': 'hi',
    });
    expect(paste(view, evt)).toBe(false);
  });

  test('Branch B: text/x-gfm routes through MarkdownManager.parse', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/x-gfm': '# gfm heading', 'text/plain': '# gfm heading' });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('# gfm heading');
  });

  test('Branch B (FR-13 ambiguous): plain+html with markdown-shaped plain → markdown path wins', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    // isMarkdown signal count ≥ threshold via heading + list + code.
    const markdownPlain = '# H\n\n- a\n- b\n\n```\ncode\n```\n';
    const evt = fakeDT({
      'text/plain': markdownPlain,
      'text/html': '<h1>H</h1>',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith(markdownPlain);
  });

  test('Branch D: generic HTML (no markdown signals in text/plain) goes through htmlToMdast', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': 'plain prose no signals',
      'text/html': '<p>rich <b>html</b></p>',
    });
    expect(paste(view, evt)).toBe(true);
    // Branch D calls mdManager.parse with the markdown that htmlToMdast +
    // mdastToMarkdown produced (the mocked stub returns '**bold**').
    expect(md.parse).toHaveBeenCalledWith('**bold**');
  });

  test('Branch E: text/plain only with markdown signals parses as markdown', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': '# H\n\n- a\n- b\n\n```\ncode\n```\n',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalled();
  });

  test('Branch E: text/plain only prose inserts verbatim (no markdown parse)', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'hello world, plain prose' });
    expect(paste(view, evt)).toBe(true);
    // Prose below threshold — no parse call, plain-text dispatch instead.
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('FR-17: Cmd+Shift+V (via injected shiftKey) → verbatim text/plain insert', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': '# H', 'text/html': '<h1>H</h1>' });
    Object.defineProperty(evt, 'shiftKey', { value: true, configurable: true });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
  });
});

describe('WYSIWYG paste dispatcher — markdown-first tiebreak ordering (D5/D13)', () => {
  test('OK→OK <img/> JSX paste: markdown-first wins over Branch C data-pm-slice', () => {
    // OK copy of `<img src="x.png" />` writes both text/plain (canonical
    // markdown-shaped via lowercase-JSX-with-attr) AND text/html (with
    // PM's auto-attached data-pm-slice). Pre-reorder, Branch C would catch
    // first → return false → PM parseFromClipboard → TipTap Image extension
    // parseDOM (priority 50) silently flips to image node. Post-reorder,
    // markdown-first fires and routes through mdManager.parse so descriptor
    // identity is preserved.
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': '<img src="x.png" />',
      'text/html': '<div data-pm-slice="0 0 paragraph"><img src="x.png" /></div>',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('<img src="x.png" />');
  });

  test('OK→OK <Callout> JSX paste: markdown-first wins over Branch C', () => {
    // Capitalized JSX signal in the heuristic catches `<Callout>` shape.
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': '<Callout type="note">body</Callout>',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><pre><code>&lt;Callout&gt;</code></pre></div>',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('<Callout type="note">body</Callout>');
  });

  test('Cross-PM-editor: markdown-canonical text/plain routes through markdown path even with PM slice', () => {
    // Linear/Outline/BlockNote canonical markdown text/plain. Branch C
    // would also handle this correctly today, but markdown-first preserves
    // the canonical bytes more directly (no PM-tree round-trip through
    // parseFromClipboard).
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': '# H\n\n- a\n- b\n',
      'text/html': '<div data-pm-slice="0 0 paragraph"><h1>H</h1></div>',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('# H\n\n- a\n- b\n');
  });

  test('Branch C still fires when text/plain is non-markdown prose (no false-positive on heuristic)', () => {
    // OK→OK paste of plain prose (no markdown signals) → markdown-first
    // does not fire → Branch C catches → PM handles natively.
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': 'plain prose without markdown signals',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><p>plain prose without markdown signals</p></div>',
    });
    expect(paste(view, evt)).toBe(false);
    expect(md.parse).not.toHaveBeenCalled();
  });
});

describe('WYSIWYG paste dispatcher — lone-URL routing', () => {
  test('lone GFM URL at a cursor routes through the markdown parse (payload trimmed)', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'https://inkeep.com\n' });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('https://inkeep.com');
  });

  test('lone GFM URL wins over a text/html sibling (browser link-copy shape)', () => {
    // A browser URL copy carries an <a> wrapper in text/html; without the
    // lone-URL step it would take Branch D's html pipeline. The step runs
    // first so the bytes come from the markdown parse of the plain URL.
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'text/plain': 'https://inkeep.com',
      'text/html': '<a href="https://inkeep.com">https://inkeep.com</a>',
    });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('https://inkeep.com');
  });

  test('lone non-GFM token (bare domain) at a cursor inserts verbatim', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'example.com' });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('URL inside plain prose inserts verbatim (not a lone URL)', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'see https://inkeep.com for the docs' });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('Cmd+Shift+V of a lone URL pastes verbatim (plain-paste gate runs first)', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'https://inkeep.com' });
    Object.defineProperty(evt, 'shiftKey', { value: true, configurable: true });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('lone URL pasted into a codeBlock inserts verbatim (code gate runs first)', () => {
    const md = fakeMdManager();
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView({ inCodeBlock: true });
    const evt = fakeDT({ 'text/plain': 'https://inkeep.com' });
    expect(paste(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });
});

describe('WYSIWYG paste dispatcher — lone-URL linkification (real editor)', () => {
  let restoreDomGlobals: (() => void) | null = null;
  let mdManager: MarkdownManager;

  beforeAll(() => {
    restoreDomGlobals = installDomGlobals();
    mdManager = new MarkdownManager({ extensions: sharedExtensions });
  });
  afterAll(() => {
    restoreDomGlobals?.();
    restoreDomGlobals = null;
  });

  function makeRealEditor(content: string, extraExtensions: Extensions = []): Editor {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return new Editor({
      element: host,
      content,
      extensions: [
        // StarterKit v3 bundles its own Link; drop it so the fidelity mark
        // (which carries `linkStyle`) is the only `link` in the schema.
        StarterKit.configure({ link: false }),
        LinkFidelity.configure({ autolink: false }),
        ...extraExtensions,
      ],
    });
  }

  function pasteInto(editor: Editor, data: Record<string, string>): boolean {
    const paste = createHandlePaste({ mdManager });
    return paste(editor.view, fakeDT(data));
  }

  /** Select `text` by content offset — valid for single-paragraph fixtures
   *  (the +1 crosses the paragraph's opening boundary). */
  function selectText(editor: Editor, text: string): void {
    const idx = editor.state.doc.textContent.indexOf(text);
    if (idx < 0) throw new Error(`selectText: "${text}" not in doc`);
    editor.commands.setTextSelection({ from: idx + 1, to: idx + 1 + text.length });
  }

  function linkMarks(editor: Editor): Array<{ text: string; attrs: Record<string, unknown> }> {
    const found: Array<{ text: string; attrs: Record<string, unknown> }> = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === 'link');
      if (mark) found.push({ text: node.text ?? '', attrs: mark.attrs });
    });
    return found;
  }

  test('cursor paste of a URL creates a gfm-autolink mark over the bare literal', () => {
    const editor = makeRealEditor('<p></p>');
    try {
      expect(pasteInto(editor, { 'text/plain': 'https://inkeep.com' })).toBe(true);
      expect(editor.state.doc.textContent).toBe('https://inkeep.com');
      const marks = linkMarks(editor);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.text).toBe('https://inkeep.com');
      expect(marks[0]?.attrs.href).toBe('https://inkeep.com');
      expect(marks[0]?.attrs.linkStyle).toBe('gfm-autolink');
    } finally {
      editor.destroy();
    }
  });

  test('cursor paste of a bare domain stays plain text', () => {
    const editor = makeRealEditor('<p></p>');
    try {
      expect(pasteInto(editor, { 'text/plain': 'example.com' })).toBe(true);
      expect(editor.state.doc.textContent).toBe('example.com');
      expect(linkMarks(editor)).toHaveLength(0);
    } finally {
      editor.destroy();
    }
  });

  test('paste over a selection keeps the selected text and links it', () => {
    const editor = makeRealEditor('<p>read the docs today</p>');
    try {
      selectText(editor, 'docs');
      expect(pasteInto(editor, { 'text/plain': 'https://inkeep.com' })).toBe(true);
      expect(editor.state.doc.textContent).toBe('read the docs today');
      const marks = linkMarks(editor);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.text).toBe('docs');
      expect(marks[0]?.attrs.href).toBe('https://inkeep.com');
      // Default style — serializes as [docs](https://inkeep.com).
      expect(marks[0]?.attrs.linkStyle).toBe('inline');
    } finally {
      editor.destroy();
    }
  });

  test.each([
    ['example.com', 'https://example.com'],
    ['www.example.com', 'https://www.example.com'],
    ['nick@inkeep.com', 'mailto:nick@inkeep.com'],
  ])('paste of %s over a selection links to %s', (payload, expectedHref) => {
    const editor = makeRealEditor('<p>read the docs today</p>');
    try {
      selectText(editor, 'docs');
      expect(pasteInto(editor, { 'text/plain': payload })).toBe(true);
      expect(editor.state.doc.textContent).toBe('read the docs today');
      expect(linkMarks(editor)[0]?.attrs.href).toBe(expectedHref);
    } finally {
      editor.destroy();
    }
  });

  test('paste of a non-allowlisted scheme over a selection never links — the payload lands as inert plain text', () => {
    const editor = makeRealEditor('<p>read the docs today</p>');
    try {
      selectText(editor, 'docs');
      pasteInto(editor, { 'text/plain': 'javascript:alert(1)' });
      expect(linkMarks(editor)).toHaveLength(0);
      // Fall-through = ordinary replace: the string is text, never an href.
      expect(editor.state.doc.textContent).toBe('read the javascript:alert(1) today');
    } finally {
      editor.destroy();
    }
  });

  test('paste of a URL over a code-marked selection falls through to a plain replace', () => {
    const editor = makeRealEditor('<p>run <code>bun install</code> now</p>');
    try {
      selectText(editor, 'install');
      pasteInto(editor, { 'text/plain': 'https://inkeep.com' });
      expect(linkMarks(editor)).toHaveLength(0);
      expect(editor.state.doc.textContent).toBe('run bun https://inkeep.com now');
    } finally {
      editor.destroy();
    }
  });

  test('paste of a URL over a cross-block selection falls through (no link mark)', () => {
    const editor = makeRealEditor('<p>one</p><p>two</p>');
    try {
      editor.commands.setTextSelection({ from: 2, to: 8 });
      pasteInto(editor, { 'text/plain': 'https://inkeep.com' });
      expect(linkMarks(editor)).toHaveLength(0);
      // The fall-through is the normal paste path: the cross-block selection
      // is replaced by the URL as plain text — content delivered, not dropped.
      expect(editor.state.doc.textContent).toContain('https://inkeep.com');
    } finally {
      editor.destroy();
    }
  });

  test('paste of a URL over already-linked text re-points the link, keeping the text', () => {
    const editor = makeRealEditor('<p><a href="https://old.example">docs</a> page</p>');
    try {
      selectText(editor, 'docs');
      expect(pasteInto(editor, { 'text/plain': 'https://new.example' })).toBe(true);
      expect(editor.state.doc.textContent).toBe('docs page');
      const marks = linkMarks(editor);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.text).toBe('docs');
      expect(marks[0]?.attrs.href).toBe('https://new.example');
    } finally {
      editor.destroy();
    }
  });

  test('pasted prose ending in a URL + space is never linkified by the typed-autolink plugin', async () => {
    // The verbatim Branch E insert looks exactly like "typed a URL then a
    // boundary" to the autolink plugin's changed-range scan. The dispatcher
    // stamps its transactions with preventAutolink so paste output is never
    // re-scanned as typing — pasted prose stays byte-identical.
    const editor = makeRealEditor('<p></p>', [
      GfmAutolink.configure({ isActiveEditor: () => true }),
    ]);
    try {
      expect(pasteInto(editor, { 'text/plain': 'see https://inkeep.com ' })).toBe(true);
      await flushMicrotasksAndTimers();
      expect(linkMarks(editor)).toHaveLength(0);
      expect(editor.state.doc.textContent).toBe('see https://inkeep.com ');
    } finally {
      editor.destroy();
    }
  });

  test('lone-URL cursor paste with the typed-autolink plugin active yields exactly one mark', async () => {
    const editor = makeRealEditor('<p></p>', [
      GfmAutolink.configure({ isActiveEditor: () => true }),
    ]);
    try {
      pasteInto(editor, { 'text/plain': 'https://inkeep.com' });
      await flushMicrotasksAndTimers();
      const marks = linkMarks(editor);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.attrs.linkStyle).toBe('gfm-autolink');
    } finally {
      editor.destroy();
    }
  });
});
