/**
 * Coverage for the embed-group slash items — generic blank-HTML entry and
 * the themed `html preview` starter family.
 *
 * Pins the load-bearing insertion shape (every item inserts a `codeBlock`
 * with `language: 'html'` + `meta: 'preview'` so the inserted block opens
 * straight into preview mode) and the 1:1 mapping between the themed
 * entries and the shared `PREVIEW_EMBED_STARTERS` set.
 */

import { describe, expect, test } from 'bun:test';
import { PREVIEW_EMBED_STARTERS } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/react';
import { getEmbedStarterItems } from './embed-starter-items';

interface InsertedNode {
  type: string;
  attrs: { language: string; meta: string };
  content: Array<{ type: string; text: string }>;
}

/** Minimal editor double that captures the `insertContent` payload. */
function makeEditor(): { editor: Editor; getInserted: () => InsertedNode | undefined } {
  let inserted: InsertedNode | undefined;
  const chain = {
    focus: () => chain,
    insertContent: (node: InsertedNode) => {
      inserted = node;
      return chain;
    },
    run: () => true,
  };
  return {
    editor: { chain: () => chain } as unknown as Editor,
    getInserted: () => inserted,
  };
}

describe('getEmbedStarterItems', () => {
  test('exposes the generic blank-HTML entry plus one item per shared starter, all in the embed category', () => {
    const items = getEmbedStarterItems();
    const expectedNames = [
      'embed-starter-html',
      ...PREVIEW_EMBED_STARTERS.map((s) => `embed-starter-${s.id}`),
    ];
    expect(items.map((i) => i.name)).toEqual(expectedNames);
    for (const item of items) {
      expect(item.category).toBe('embed');
      expect(typeof item.command).toBe('function');
      expect(item.preview).toBeDefined();
      expect(typeof item.preview?.render).toBe('function');
    }
  });

  test('the generic blank-HTML entry comes FIRST so /embed lands on it ahead of templates', () => {
    expect(getEmbedStarterItems()[0]?.name).toBe('embed-starter-html');
  });

  test('every command inserts a code block that opens in HTML preview mode', () => {
    for (const item of getEmbedStarterItems()) {
      const { editor, getInserted } = makeEditor();
      item.command(editor);
      const node = getInserted();
      expect(node?.type).toBe('codeBlock');
      expect(node?.attrs).toEqual({ language: 'html', meta: 'preview' });
      expect(node?.content[0]?.type).toBe('text');
      // Every embed body wires colors through theme tokens so light/dark
      // renders without hand-picked values.
      expect(node?.content[0]?.text).toContain('var(--');
    }
  });

  test('each themed item inserts the corresponding shared starter html exactly', () => {
    const items = getEmbedStarterItems();
    for (const starter of PREVIEW_EMBED_STARTERS) {
      const item = items.find((i) => i.name === `embed-starter-${starter.id}`);
      const { editor, getInserted } = makeEditor();
      item?.command(editor);
      expect(getInserted()?.content[0]?.text).toBe(starter.html);
    }
  });

  test('blank-HTML inserts a seeded Hello-world body so the preview shows something on first paint', () => {
    const blank = getEmbedStarterItems().find((i) => i.name === 'embed-starter-html');
    expect(blank).toBeDefined();
    const { editor, getInserted } = makeEditor();
    blank?.command(editor);
    const text = getInserted()?.content[0]?.text ?? '';
    expect(text).toContain('Hello, world!');
    // The seed nudges the author toward editing — without it the iframe
    // would render empty and the preview affordance is invisible.
    expect(text.toLowerCase()).toContain('edit this html');
  });

  test('blank-HTML exposes the full set of search aliases', () => {
    const blank = getEmbedStarterItems().find((i) => i.name === 'embed-starter-html');
    // Exhaustive equality (not arrayContaining) — every alias is a
    // discoverability contract with users typing `/html`, `/iframe`,
    // `/sandbox`, `/web`, `/snippet`. Silent removal of any one would
    // regress the user-facing search surface.
    expect(blank?.aliases).toEqual([
      'html',
      'embed',
      'preview',
      'iframe',
      'sandbox',
      'web',
      'snippet',
    ]);
  });
});
