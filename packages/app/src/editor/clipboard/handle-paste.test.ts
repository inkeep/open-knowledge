import * as actualCore from '@inkeep/open-knowledge-core';
import { LinkFidelity, MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as actualSonner from 'sonner';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { GfmAutolink } from '../gfm-autolink-plugin.ts';
import { flushMicrotasksAndTimers, installDomGlobals } from '../walk-currency-test-harness.ts';

vi.doMock('@inkeep/open-knowledge-core', () => {
  return {
    ...actualCore,
    htmlToMdast: vi.fn((_html: string) => ({ type: 'root', children: [] })),
    mdastToMarkdown: vi.fn((_tree: unknown) => '**bold**'),
  };
});

vi.doMock('sonner', () => ({ ...actualSonner, toast: { error: vi.fn(() => {}) } }));

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
    parse: vi.fn((_md: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parsed' }] }],
    })),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: narrow fake view for unit test
function fakeView(opts: { inCodeBlock?: boolean } = {}): any {
  const dispatch = vi.fn(() => {});
  const codeBlockType = {
    create: vi.fn((_attrs: unknown, _content: unknown) => ({
      slice: (_f: number, _t: number) => 'CODE-SLICE',
    })),
  };
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
          content: {
            size: 10,
            childCount: 1,
            // biome-ignore lint/suspicious/noExplicitAny: fake fragment child
            forEach: (fn: (child: any) => void) => fn({ type: { name: 'paragraph' } }),
          },
        }),
      },
      tr: {
        replaceSelectionWith: vi.fn(function (this: unknown, _node: unknown) {
          return this;
        }),
        replaceSelection: vi.fn(function (this: unknown, _slice: unknown) {
          return this;
        }),
        setMeta: vi.fn(function (this: unknown, _key: unknown, _value: unknown) {
          return this;
        }),
        scrollIntoView: vi.fn(function (this: unknown) {
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
    const paste = createHandlePaste({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDT({
      'vscode-editor-data': '{not json',
      'text/plain': 'fallback content',
    });
    expect(paste(view, evt)).toBe(true);
    expect(view.state.schema.nodes.codeBlock.create).not.toHaveBeenCalled();
  });

  test('Branch B: a throwing mdManager.parse falls through instead of escaping', () => {
    const throwingMd = {
      parse: vi.fn(() => {
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
      parse: vi.fn(() => {
        throw new Error('parse exploded');
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
    const paste = createHandlePaste({ mdManager: throwingMd as any });
    const view = fakeView();
    const evt = fakeDT({ 'text/plain': 'https://example.com' });
    expect(paste(view, evt)).toBe(true);
    expect(throwingMd.parse).toHaveBeenCalled();
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
