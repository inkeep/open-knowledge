/**
 * Slash-menu cell-context filtering — inside a GFM table cell the menu must
 * withhold block-component items (they would no-op there, the cell-insertion
 * gate refuses them) while keeping every non-component item, and offer the
 * full set everywhere else.
 *
 * Real ProseMirror EditorViews over jsdom globals with the real core schema
 * (table + jsxComponent), the real item sources wired in `extensions/shared.ts`,
 * and the exact `buildSlashMenuItems` transform the slash extension runs — so
 * the predicate, the item flags, and the merge/filter path are all exercised on
 * production code, not re-implementations.
 */

import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { CellInsertionGate } from '../extensions/cell-insertion-gate';
import { SLASH_ITEM_SOURCES } from '../extensions/shared';
import { buildSlashMenuItems } from '../extensions/slash-command';
import { isSelectionInTableCell } from '../table-cell-context';
import { installDomGlobals } from '../walk-currency-test-harness';
import { getComponentItems, getInlineComponentItems } from './component-items';
import { getEmbedStarterItems } from './embed-starter-items';
import { getSlashCommandItems, type SlashCommandItem } from './items';

const mdManager = new MarkdownManager({ extensions: coreExtensions });

/** A 2x2 GFM table: header row (a,b) → tableHeader; data row (c,d) → tableCell. */
const TABLE_MD = '| a | b |\n| - | - |\n| c | d |\n';

// The production source list itself (not a mirror) — a source added to the
// wiring is automatically covered here. Category order mirrors the
// `categoryLabels` keys in `extensions/shared.ts`.
const SOURCES: (() => SlashCommandItem[])[] = [...SLASH_ITEM_SOURCES];
const CATEGORY_ORDER = ['content', 'layout', 'media', 'data', 'embed'];

let restoreDomGlobals: (() => void) | null = null;
const editors: Editor[] = [];

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function mount(content: string | JSONContent, withGate = false): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content,
    extensions: withGate ? [...coreExtensions, CellInsertionGate] : [...coreExtensions],
  });
  editors.push(editor);
  return editor;
}

/** Caret inside the first node of the named type (its inner paragraph text). */
function firstCellCaret(editor: Editor, cellType: 'tableCell' | 'tableHeader'): number {
  let cellPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cellPos === -1 && node.type.name === cellType) {
      cellPos = pos;
      return false;
    }
    return true;
  });
  if (cellPos < 0) throw new Error(`seed table has no ${cellType}`);
  const caret = cellPos + 2; // cell open +1 → paragraph, +2 → paragraph text
  expect(editor.state.doc.resolve(caret).parent.type.name).toBe('paragraph');
  return caret;
}

function names(items: SlashCommandItem[]): string[] {
  return items.map((i) => i.name);
}

function countJsxComponents(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') count += 1;
    return true;
  });
  return count;
}

describe('isSelectionInTableCell', () => {
  test('a caret inside a data cell is in cell context', () => {
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableCell'));
    expect(isSelectionInTableCell(editor.state)).toBe(true);
  });

  test('a caret inside a header cell is in cell context', () => {
    // Header cells flatten on serialize exactly like data cells, so they must
    // count as cell context too.
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableHeader'));
    expect(isSelectionInTableCell(editor.state)).toBe(true);
  });

  test('a caret in a top-level paragraph is not in cell context', () => {
    const editor = mount('<p>hello</p>');
    editor.commands.setTextSelection(1);
    expect(isSelectionInTableCell(editor.state)).toBe(false);
  });
});

describe('insertsBlockComponent flag on the real item sources', () => {
  test('every block-component item (descriptors + File) is flagged', () => {
    const items = getComponentItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.insertsBlockComponent).toBe(true);
    }
  });

  test('formatting, embed, and inline-atom items are not flagged', () => {
    // Inline atoms (link, Tag) and codeBlock-based embeds are representable in a
    // cell, so they must stay offered — only block components are withheld.
    const unflagged = [
      ...getSlashCommandItems(),
      ...getEmbedStarterItems(),
      ...getInlineComponentItems(),
    ];
    expect(unflagged.length).toBeGreaterThan(0);
    for (const item of unflagged) {
      expect(item.insertsBlockComponent).toBeFalsy();
    }
  });
});

describe('buildSlashMenuItems — cell-context filtering over the wired sources', () => {
  function offeredAt(editor: Editor, query = ''): SlashCommandItem[] {
    return buildSlashMenuItems({
      sources: SOURCES,
      categoryOrder: CATEGORY_ORDER,
      query,
      state: editor.state,
    });
  }

  test('inside a cell, no block-component item is offered but non-component items remain', () => {
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableCell'));

    const offered = offeredAt(editor);
    expect(offered.some((i) => i.insertsBlockComponent)).toBe(false);
    expect(names(offered)).not.toContain('component-Callout');
    expect(names(offered)).not.toContain('component-File');
    // Formatting, table, inline atoms, and embeds all survive.
    expect(names(offered)).toContain('heading1');
    expect(names(offered)).toContain('table');
    expect(names(offered)).toContain('link');
    expect(names(offered)).toContain('component-Tag');
    expect(names(offered)).toContain('embed-starter-html');
  });

  test('inside a header cell, block components are withheld too', () => {
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableHeader'));

    const offered = offeredAt(editor);
    expect(offered.some((i) => i.insertsBlockComponent)).toBe(false);
    expect(names(offered)).toContain('heading1');
  });

  test('outside a cell, block-component items are offered', () => {
    const editor = mount('<p>hello</p>');
    editor.commands.setTextSelection(1);

    const offered = offeredAt(editor);
    expect(names(offered)).toContain('component-Callout');
    expect(names(offered)).toContain('component-File');
    // Guard against a false green where nothing is ever flagged/offered.
    expect(offered.some((i) => i.insertsBlockComponent)).toBe(true);
  });

  test('the search query narrows within cell context, Callout stays filtered', () => {
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableCell'));

    expect(names(offeredAt(editor, 'callout'))).not.toContain('component-Callout');
    expect(names(offeredAt(editor, 'heading'))).toContain('heading1');
  });

  test('the same query at a top-level caret surfaces Callout (control)', () => {
    const editor = mount('<p>hello</p>');
    editor.commands.setTextSelection(1);
    expect(names(offeredAt(editor, 'callout'))).toContain('component-Callout');
  });
});

describe('component item command with a cell caret no-ops via the gate', () => {
  function calloutItem(): SlashCommandItem {
    const item = getComponentItems().find((i) => i.name === 'component-Callout');
    if (!item) throw new Error('Callout slash item missing');
    return item;
  }

  test('running the Callout command inside a cell leaves the doc unchanged', () => {
    const editor = mount(mdManager.parse(TABLE_MD) as JSONContent, true);
    editor.commands.setTextSelection(firstCellCaret(editor, 'tableCell'));
    const before = editor.state.doc;

    calloutItem().command(editor);

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(countJsxComponents(editor.state.doc)).toBe(0);
  });

  test('the same command at a top-level caret inserts a component (control)', () => {
    const editor = mount('<p></p>', true);
    editor.commands.setTextSelection(1);

    // Auto-open (focusInsertedComponent → rAF → setNodeSelection) is out of
    // scope here; stub rAF so the deferred selection can't fire against the
    // editor after afterEach tears it down.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame;
    try {
      calloutItem().command(editor);
      expect(countJsxComponents(editor.state.doc)).toBe(1);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});
