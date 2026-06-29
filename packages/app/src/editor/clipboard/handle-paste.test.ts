
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualCore from '@inkeep/open-knowledge-core';
import * as actualSonner from 'sonner';

import { createHandlePaste } from './handle-paste.ts';

mock.module('@inkeep/open-knowledge-core', () => {
  return {
    ...actualCore,
    htmlToMdast: mock((_html: string) => ({ type: 'root', children: [] })),
    mdastToMarkdown: mock((_tree: unknown) => '**bold**'),
  };
});

mock.module('sonner', () => ({ ...actualSonner, toast: { error: mock(() => {}) } }));

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

// biome-ignore lint/suspicious/noExplicitAny: narrow fake view for unit test
function fakeView(opts: { inCodeBlock?: boolean } = {}): any {
  const dispatch = mock(() => {});
  const codeBlockType = {
    create: mock((_attrs: unknown, _content: unknown) => ({
      slice: (_f: number, _t: number) => 'CODE-SLICE',
    })),
  };
  const $from = {
    depth: 1,
    node: (_d: number) => ({ type: { name: opts.inCodeBlock ? 'codeBlock' : 'paragraph' } }),
  };
  return {
    state: {
      selection: { $from },
      schema: {
        nodes: { codeBlock: codeBlockType },
        text: (s: string) => ({ textContent: s }),
        // biome-ignore lint/suspicious/noExplicitAny: fake schema for unit test
        nodeFromJSON: (json: any) => ({
          slice: (_f: number, _t: number) => ({ json, size: 10, content: { size: 10 } }),
          content: { size: 10 },
        }),
      },
      tr: {
        replaceSelectionWith: mock(function (this: unknown, _node: unknown) {
          return this;
        }),
        replaceSelection: mock(function (this: unknown, _slice: unknown) {
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
    expect(() => paste(view, evt)).not.toThrow();
    expect(view.state.schema.nodes.codeBlock.create).not.toHaveBeenCalled();
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
