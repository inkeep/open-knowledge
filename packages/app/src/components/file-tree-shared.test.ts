import { describe, expect, test } from 'vitest';
import {
  buildOkFileTreeOptions,
  FILE_TREE_FRACTIONAL_ZOOM_TRUNCATION_GUARD_CSS,
  FILE_TREE_USER_NAME_DIRECTION_CSS,
  lucideMaskDataUri,
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

  test('the read-only base gives every row its own writing direction', () => {
    expect(OK_FILE_TREE_READONLY_UNSAFE_CSS).toContain(FILE_TREE_USER_NAME_DIRECTION_CSS);
  });

  test('the read-only base suppresses fractional-zoom false truncation', () => {
    const opts = buildOkFileTreeOptions({ paths: [] });
    expect(opts.unsafeCSS).toContain(FILE_TREE_FRACTIONAL_ZOOM_TRUNCATION_GUARD_CSS);
  });

  test('unsafeCSS override wins (the editable main tree passes its full composition)', () => {
    const full = `${OK_FILE_TREE_READONLY_UNSAFE_CSS}\n/* rename + drop */`;
    const opts = buildOkFileTreeOptions({ paths: [], unsafeCSS: full });
    expect(opts.unsafeCSS).toBe(full);
  });

  test('md and mdx map to the custom markdown glyph override', () => {
    const { icons } = buildOkFileTreeOptions({ paths: [] });
    if (typeof icons !== 'object') throw new Error('expected object icons config');
    expect(icons.set).toBe('complete');
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

describe('lucideMaskDataUri', () => {
  test('emits a CSS-safe percent-encoded SVG mask with the stroke baked in', () => {
    const uri = lucideMaskDataUri([['path', { d: 'M4 4h16' }]]);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('stroke="black"');
    expect(svg).toContain('<path d="M4 4h16" />');
    expect(uri).not.toContain('"');
    expect(uri).not.toContain('<');
  });
});
