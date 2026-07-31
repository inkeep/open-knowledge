/**
 * Unit coverage for the shared file-tree options builder. Asserts the generic
 * option slice both trees rely on: the read-only `unsafeCSS` default (and its
 * override), the markdown icon override, sprite concatenation, and the
 * context-menu gate. Pure — no DOM, mirrors `file-tree-density.test.ts`.
 */

import { describe, expect, test } from 'vitest';
import {
  buildOkFileTreeOptions,
  MARKDOWN_FILE_ICON_ID,
  MARKDOWN_FILE_ICON_SYMBOL,
  OK_FILE_TREE_READONLY_UNSAFE_CSS,
} from './file-tree-shared.ts';

describe('buildOkFileTreeOptions', () => {
  test('passes paths through and defaults to the read-only unsafeCSS base', () => {
    const opts = buildOkFileTreeOptions({ paths: ['a.md', 'b/c.ts'] });
    expect(opts.paths).toEqual(['a.md', 'b/c.ts']);
    expect(opts.unsafeCSS).toBe(OK_FILE_TREE_READONLY_UNSAFE_CSS);
  });

  test('unsafeCSS override wins (the editable main tree passes its full composition)', () => {
    const full = `${OK_FILE_TREE_READONLY_UNSAFE_CSS}\n/* rename + drop */`;
    const opts = buildOkFileTreeOptions({ paths: [], unsafeCSS: full });
    expect(opts.unsafeCSS).toBe(full);
  });

  test('md and mdx map to the custom markdown glyph override', () => {
    const { icons } = buildOkFileTreeOptions({ paths: [] });
    // `FileTreeIcons` is `"minimal" | {…}`; the builder always emits the object.
    if (typeof icons !== 'object') throw new Error('expected object icons config');
    expect(icons.set).toBe('complete');
    // md + mdx both remap to the custom markdown glyph id (RemappedIcon is itself
    // a union, so assert on the serialized map rather than fight the types).
    const byExt = JSON.stringify(icons.byFileExtension);
    expect(byExt).toContain('"md"');
    expect(byExt).toContain('"mdx"');
    expect(byExt).toContain(MARKDOWN_FILE_ICON_ID);
  });

  test('extraSpriteSymbols are concatenated into the sprite ahead of the markdown symbol', () => {
    const extra = '<symbol id="x"></symbol>';
    const { icons } = buildOkFileTreeOptions({ paths: [], extraSpriteSymbols: extra });
    if (typeof icons !== 'object') throw new Error('expected object icons config');
    const sheet = icons.spriteSheet ?? '';
    expect(sheet).toContain(extra);
    expect(sheet).toContain(MARKDOWN_FILE_ICON_SYMBOL);
    // Both the extra symbols and the markdown glyph live inside one sprite host.
    expect(sheet.indexOf(extra)).toBeLessThan(sheet.indexOf(MARKDOWN_FILE_ICON_SYMBOL));
  });

  test('the markdown symbol is always present even with no extra symbols', () => {
    const { icons } = buildOkFileTreeOptions({ paths: [] });
    if (typeof icons !== 'object') throw new Error('expected object icons config');
    expect(icons.spriteSheet ?? '').toContain(MARKDOWN_FILE_ICON_SYMBOL);
  });

  test('context menu is gated on enableContextMenu', () => {
    expect(buildOkFileTreeOptions({ paths: [] }).composition).toBeUndefined();
    expect(
      buildOkFileTreeOptions({ paths: [], enableContextMenu: true }).composition?.contextMenu
        ?.enabled,
    ).toBe(true);
  });
});
