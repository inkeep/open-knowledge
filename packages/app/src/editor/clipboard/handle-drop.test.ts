/**
 * Branch-routing tests for the WYSIWYG DROP dispatcher.
 *
 * `createHandleDrop` mirrors `createHandlePaste` — same branches, same
 * is-markdown gate, same Cmd+Shift escape — with two surface differences:
 *   1. Data lives on `event.dataTransfer` (DragEvent), not
 *      `event.clipboardData` (ClipboardEvent).
 *   2. Shift state reads off the DragEvent's `shiftKey` flag directly
 *      (DragEvent extends MouseEvent, so modifiers are first-class —
 *      no keydown latch dance).
 *
 * Drag-from-Finder of files routes through FileHandler.onDrop in
 * `extensions/shared.ts`; the dispatcher returns false whenever
 * `dataTransfer.files.length > 0` so that path takes over.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualCore from '@inkeep/open-knowledge-core';
import * as actualSonner from 'sonner';

import { createHandleDrop } from './handle-paste.ts';

mock.module('@inkeep/open-knowledge-core', () => {
  return {
    ...actualCore,
    htmlToMdast: mock((_html: string) => ({ type: 'root', children: [] })),
    mdastToMarkdown: mock((_tree: unknown) => '**bold**'),
  };
});

mock.module('sonner', () => ({ ...actualSonner, toast: { error: mock(() => {}) } }));

interface FakeDropOptions {
  data: Record<string, string>;
  filesCount?: number;
  shiftKey?: boolean;
}

function fakeDropEvent({ data, filesCount = 0, shiftKey = false }: FakeDropOptions): DragEvent {
  // Files are not exposed to dispatcher beyond .length checks, so a stub
  // array of `length` is sufficient for the file-defer assertion.
  const files = { length: filesCount } as unknown as FileList;
  const evt = {
    dataTransfer: {
      types: Object.keys(data),
      getData: (k: string) => data[k] ?? '',
      files,
    },
    shiftKey,
  } as unknown as DragEvent;
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

describe('WYSIWYG drop dispatcher — file-defer + branch routing parity', () => {
  test('defers to FileHandler when dataTransfer.files is non-empty (returns false)', () => {
    // Drag-from-Finder semantics. The FileHandler extension's plugin
    // handleDrop fires after editorProps.handleDrop returns false; if our
    // dispatcher consumed the event here, the file-upload path would
    // never run.
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': 'irrelevant' },
      filesCount: 1,
    });
    expect(drop(view, evt)).toBe(false);
    // mdManager.parse must NOT be called — the file path takes over.
    expect(md.parse).not.toHaveBeenCalled();
  });

  test('empty dataTransfer returns false (PM default runs)', () => {
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = {
      dataTransfer: { types: [] as string[], getData: () => '', files: { length: 0 } },
      shiftKey: false,
    } as unknown as DragEvent;
    expect(drop(view, evt)).toBe(false);
  });

  test('FR-10 cursor-in-codeBlock short-circuits to plain-text insert', () => {
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView({ inCodeBlock: true });
    const evt = fakeDropEvent({
      data: { 'text/plain': 'raw code', 'text/html': '<b>bold</b>' },
    });
    expect(drop(view, evt)).toBe(true);
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('Branch A: vscode-editor-data produces a codeBlock with language', () => {
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: {
        'vscode-editor-data': '{"mode":"typescript"}',
        'text/plain': 'const x = 1;',
      },
    });
    expect(drop(view, evt)).toBe(true);
    expect(view.state.schema.nodes.codeBlock.create).toHaveBeenCalledWith(
      { language: 'typescript' },
      expect.anything(),
    );
  });

  test('Branch B (text/x-gfm): routes through MarkdownManager.parse', () => {
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/x-gfm': '# gfm heading', 'text/plain': '# gfm heading' },
    });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('# gfm heading');
  });

  test('Branch B (markdown-first tiebreak): plain+html with markdown-shaped plain → markdown path', () => {
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const markdownPlain = '# H\n\n- a\n- b\n\n```\ncode\n```\n';
    const evt = fakeDropEvent({
      data: { 'text/plain': markdownPlain, 'text/html': '<h1>H</h1>' },
    });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith(markdownPlain);
  });

  test('Branch C: data-pm-slice fingerprint returns false (PM handles)', () => {
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: fakeMdManager() as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: {
        'text/html': '<div data-pm-slice="0 0 paragraph"><p>hi</p></div>',
        'text/plain': 'hi',
      },
    });
    expect(drop(view, evt)).toBe(false);
  });

  test('Branch D: generic HTML routes through htmlToMdast', () => {
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: {
        'text/plain': 'plain prose no signals',
        'text/html': '<p>rich <b>html</b></p>',
      },
    });
    expect(drop(view, evt)).toBe(true);
    // Branch D calls mdManager.parse with the markdown that htmlToMdast +
    // mdastToMarkdown produced (the mocked stub returns '**bold**').
    expect(md.parse).toHaveBeenCalledWith('**bold**');
  });

  test('Branch E (text/plain only with markdown signals): parses as markdown', () => {
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': '# H\n\n- a\n- b\n\n```\ncode\n```\n' },
    });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalled();
  });

  test('Branch E (plain prose): inserts verbatim, no markdown parse', () => {
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': 'hello world, plain prose' },
    });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).not.toHaveBeenCalled();
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });
});

describe('WYSIWYG drop dispatcher — shift-key plaintext override (FR-37)', () => {
  test('shift-held drop reads DragEvent.shiftKey directly (no latch needed)', () => {
    // Paste reads `pasteShiftHeld()` because ClipboardEvent doesn't carry
    // modifier flags; drop reads the DragEvent's own `shiftKey` property
    // (DragEvent extends MouseEvent → modifiers are first-class). Both
    // surfaces produce the same outcome — verbatim plain-text insert.
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': '# H', 'text/html': '<h1>H</h1>' },
      shiftKey: true,
    });
    expect(drop(view, evt)).toBe(true);
    // Markdown path must NOT fire — shift overrides to plaintext.
    expect(md.parse).not.toHaveBeenCalled();
    // Plaintext insertion path fires.
    expect(view.state.tr.replaceSelectionWith).toHaveBeenCalled();
  });

  test('shift-not-held drop with markdown plain runs the heuristic + parse', () => {
    // Mirror of the test above with shiftKey: false — confirms the shift
    // gate is the discriminator, not some other surface difference.
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': '# H\n\n- a\n- b\n\n```\ncode\n```\n' },
      shiftKey: false,
    });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalled();
  });
});

describe('WYSIWYG drop dispatcher — paste/drop parity on canonical inputs', () => {
  test('FR-38 widened heuristic: dropping `__foo__` text/plain routes through markdown parse', () => {
    // single underscore-emphasis would not trip the heuristic
    // (the existing STRONG_UNDER_RE is `__bold__`-shaped). The widened
    // heuristic catches both, so the dispatcher routes through
    // mdManager.parse and the sourceDelimiter='__' attr survives
    // round-trip.
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({ data: { 'text/plain': '__foo__' } });
    expect(drop(view, evt)).toBe(true);
    expect(md.parse).toHaveBeenCalledWith('__foo__');
  });

  test('files + text payload: file path always wins over text dispatch', () => {
    // Dropping a .md file from Finder: dataTransfer carries both `files`
    // (the file blob) and may also surface a text/plain reading from the
    // file. The dispatcher must defer regardless of text shape so the
    // file-upload path runs and the resulting wiki-link / asset-embed
    // shape is correct.
    const md = fakeMdManager();
    const drop = createHandleDrop({
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
      mdManager: md as any,
    });
    const view = fakeView();
    const evt = fakeDropEvent({
      data: { 'text/plain': '# Title\n\n- bullet\n' },
      filesCount: 1,
    });
    expect(drop(view, evt)).toBe(false);
    expect(md.parse).not.toHaveBeenCalled();
  });
});
