/**
 * Integration: WYSIWYG paste dispatcher reorder — markdown-first ahead of
 * Branch C (data-pm-slice).
 *
 * Verifies the OK→OK regression path with the real `MarkdownManager`
 * (sharedExtensions) and the real PM schema. The unit tests in
 * `handle-paste.test.ts` mock `mdManager.parse`; this file confirms that
 * realistic OK clipboard payloads (`<img/>` JSX, `<Callout>` JSX) round-trip
 * through the canonical markdown path and produce the expected PM tree
 * shape — descriptor identity preserved.
 *
 * Source-side dispatcher reorder is exercised end-to-end via Playwright
 * — CM6 `EditorView.domEventHandlers` wiring requires a real DOM.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { mdManager, schema } from './test-harness.ts';

// Mock sonner so toast.error doesn't throw in node.
mock.module('sonner', () => ({ toast: { error: mock(() => {}) } }));

// Imported after the mock so the dispatcher module picks up the stub.
let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;
beforeEach(async () => {
  ({ createHandlePaste } = await import('../../src/editor/clipboard/handle-paste.ts'));
});

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

interface CapturedDispatch {
  json?: JSONContent;
  plain?: string;
  branch: 'replaceSelection' | 'replaceSelectionWith' | 'none';
}

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: {
      types: Object.keys(data),
      getData: (k: string) => data[k] ?? '',
    },
  } as unknown as ClipboardEvent;
}

function fakeView() {
  const captured: CapturedDispatch = { branch: 'none' };
  // Mirror the structure handle-paste reads — selection at depth 0
  // (paragraph), real schema for nodeFromJSON.
  const $from = {
    depth: 1,
    node: (_d: number) => ({ type: { name: 'paragraph' } }),
  };
  return {
    captured,
    view: {
      state: {
        selection: { $from },
        schema,
        tr: {
          replaceSelection(slice: { content: { firstChild?: { toJSON: () => JSONContent } } }) {
            captured.branch = 'replaceSelection';
            // Slice carries the parsed JSON one level deep — capture the doc child.
            const first = slice.content.firstChild;
            if (first) captured.json = first.toJSON();
            return this;
          },
          replaceSelectionWith(node: { textContent?: string }) {
            captured.branch = 'replaceSelectionWith';
            captured.plain = node.textContent;
            return this;
          },
          scrollIntoView() {
            return this;
          },
        },
      },
      dispatch: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake view
    } as any,
  };
}

function findFirstNode(node: JSONContent | undefined, type: string): JSONContent | undefined {
  if (!node) return undefined;
  if (node.type === type) return node;
  if (!node.content) return undefined;
  for (const child of node.content) {
    const found = findFirstNode(child, type);
    if (found) return found;
  }
  return undefined;
}

describe('WYSIWYG dispatcher reorder — OK→OK <img/> JSX preserves descriptor identity', () => {
  test('text/plain `<img src="x.png" />` + data-pm-slice html → markdown path produces jsxComponent(img)', () => {
    const paste = createHandlePaste({ mdManager });
    const { view, captured } = fakeView();
    paste(
      view,
      fakeDT({
        'text/plain': '<img src="x.png" />',
        'text/html': '<div data-pm-slice="0 0 paragraph"><img src="x.png" /></div>',
      }),
    );
    expect(captured.branch).toBe('replaceSelection');
    const jsxNode = findFirstNode(captured.json, 'jsxComponent');
    expect(jsxNode).toBeDefined();
    // The tag normalizes to lowercase per the canonical descriptor.
    expect(jsxNode?.attrs?.componentName).toBe('img');
  });
});

describe('WYSIWYG dispatcher reorder — OK→OK <Callout> JSX preserves source bytes', () => {
  test('single-line text/plain `<Callout type="note">body</Callout>` + data-pm-slice html → jsxInline preserves source', () => {
    // Single-line MDX JSX with body + closing tag on one line cannot
    // promote to block-level jsxComponent (MDX parsing rule). It parses
    // as `jsxInline` whose text node is the verbatim source — bytes are
    // preserved. The dispatcher reorder ensures the markdown path runs
    // (yielding canonical jsxInline) instead of falling to Branch C
    // where CodeBlockFidelity's `<pre>` parseDOM would steal the slice.
    const paste = createHandlePaste({ mdManager });
    const { view, captured } = fakeView();
    paste(
      view,
      fakeDT({
        'text/plain': '<Callout type="note">body</Callout>',
        'text/html':
          '<div data-pm-slice="0 0 paragraph"><pre class="mdx-component"><code>&lt;Callout&gt;</code></pre></div>',
      }),
    );
    expect(captured.branch).toBe('replaceSelection');
    // jsxInline shape: paragraph > jsxInline > text(source)
    const jsxInline = findFirstNode(captured.json, 'jsxInline');
    expect(jsxInline).toBeDefined();
    const textNode = jsxInline?.content?.[0];
    expect(textNode?.text).toBe('<Callout type="note">body</Callout>');
    // No codeBlock should appear — that's the regression Branch C would cause.
    expect(findFirstNode(captured.json, 'codeBlock')).toBeUndefined();
  });

  test('multi-line text/plain `<Callout>` + data-pm-slice html → jsxComponent(Callout) descriptor identity', () => {
    const paste = createHandlePaste({ mdManager });
    const { view, captured } = fakeView();
    paste(
      view,
      fakeDT({
        'text/plain': '<Callout type="note">\n\nbody\n\n</Callout>',
        'text/html':
          '<div data-pm-slice="0 0 paragraph"><pre class="mdx-component"><code>&lt;Callout&gt;</code></pre></div>',
      }),
    );
    expect(captured.branch).toBe('replaceSelection');
    const jsxNode = findFirstNode(captured.json, 'jsxComponent');
    expect(jsxNode).toBeDefined();
    expect(jsxNode?.attrs?.componentName).toBe('Callout');
    expect(jsxNode?.attrs?.props?.type).toBe('note');
  });
});

describe('WYSIWYG dispatcher reorder — Branch C still fires for non-markdown text/plain', () => {
  test('plain prose with no markdown signals + data-pm-slice html → returns false (PM handles)', () => {
    const paste = createHandlePaste({ mdManager });
    const { view } = fakeView();
    const handled = paste(
      view,
      fakeDT({
        'text/plain': 'plain prose without any markdown signals at all',
        'text/html':
          '<div data-pm-slice="0 0 paragraph"><p>plain prose without any markdown signals at all</p></div>',
      }),
    );
    expect(handled).toBe(false);
  });
});

describe('WYSIWYG dispatcher reorder — cross-PM-editor markdown text/plain preserved', () => {
  test('Linear-style markdown text/plain + their PM html → markdown path wins, not Branch C', () => {
    const paste = createHandlePaste({ mdManager });
    const { view, captured } = fakeView();
    const linearStyle =
      '## Heading\n\n- item one\n- item two\n\nAnd a paragraph with [a link](https://x).\n';
    paste(
      view,
      fakeDT({
        'text/plain': linearStyle,
        'text/html':
          '<div data-pm-slice="0 0 paragraph"><h2>Heading</h2><ul><li>item one</li><li>item two</li></ul></div>',
      }),
    );
    expect(captured.branch).toBe('replaceSelection');
    const heading = findFirstNode(captured.json, 'heading');
    expect(heading).toBeDefined();
  });
});
