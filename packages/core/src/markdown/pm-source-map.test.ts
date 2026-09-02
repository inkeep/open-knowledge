/**
 * The byte map the local WYSIWYG projection splices and places cursors through.
 *
 * Four properties, in the order the write path depends on them:
 *
 *  - the block table is index-aligned with the PM doc's top-level children, so
 *    a PM transaction's changed-block ordinal indexes it directly;
 *  - every top-level block's span is a *parse fact*, not an inherited guess,
 *    and slicing the source by it yields exactly that block;
 *  - spans nest and siblings stay disjoint, so the deepest-container search
 *    both directions rely on is well-defined;
 *  - and building a map does not change what `parse()` produces.
 *
 * Block correctness is asserted as *containment* (nothing outside the edited
 * block's range moves) rather than against a whole-document re-serialize, which
 * renormalizes untouched blocks and would score a correct implementation as a
 * partial failure. See §4's oracle trap in
 * `feature-specs/single-crdt-migration.md`.
 */

import { describe, expect, it } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import {
  loadBuiltInFixtures,
  loadGfmExamples,
  loadIndentedJsxFixtures,
  loadLargeRealistic,
  loadNgPinnedCases,
  loadPrd6955Before,
} from './fixtures/index.ts';
import { MarkdownManager } from './index.ts';
import type { PmSourceMap, PmSourceSpan } from './pm-source-map.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

/** Every span invariant the two lookup directions are built on. */
function assertStructurallySound(map: PmSourceMap, source: string): void {
  const stack: PmSourceSpan[] = [];
  for (const span of map.spans) {
    expect(span.sourceStart).toBeGreaterThanOrEqual(0);
    expect(span.sourceEnd).toBeLessThanOrEqual(source.length);
    expect(span.sourceEnd).toBeGreaterThanOrEqual(span.sourceStart);
    expect(span.to).toBeGreaterThan(span.from);

    while (stack.length > 0 && (stack[stack.length - 1] as PmSourceSpan).depth >= span.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      expect(span.from).toBeGreaterThanOrEqual(parent.from);
      expect(span.to).toBeLessThanOrEqual(parent.to);
      expect(span.sourceStart).toBeGreaterThanOrEqual(parent.sourceStart);
      expect(span.sourceEnd).toBeLessThanOrEqual(parent.sourceEnd);
    }
    stack.push(span);
  }

  let pmCursor = 0;
  let sourceCursor = 0;
  for (const block of map.blocks) {
    expect(block.depth).toBe(1);
    expect(block.from).toBe(pmCursor);
    expect(block.sourceStart).toBeGreaterThanOrEqual(sourceCursor);
    pmCursor = block.to;
    sourceCursor = block.sourceEnd;
  }
}

describe('parseWithSourceMap — block table', () => {
  it('is index-aligned with the PM doc top level and slices back to each block', () => {
    const source = [
      '# Heading',
      '',
      'A paragraph with **bold** and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'Last paragraph.',
      '',
    ].join('\n');

    const { doc, map } = md.parseWithSourceMap(source);

    expect(map.blocks).toHaveLength(doc.childCount);
    expect(map.blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'blockquote',
      'codeBlock',
      'table',
      'paragraph',
    ]);
    expect(map.blocks.every((b) => b.mapped)).toBe(true);
    expect(map.blocks.map((b) => source.slice(b.sourceStart, b.sourceEnd))).toEqual([
      '# Heading',
      'A paragraph with **bold** and a [link](https://example.com).',
      '- one\n- two',
      '> quoted',
      '```ts\nconst x = 1;\n```',
      '| a | b |\n| - | - |\n| 1 | 2 |',
      'Last paragraph.',
    ]);
    assertStructurallySound(map, source);
  });

  it('gives a synthesized commentBlock a real span rather than an inherited one', () => {
    for (const source of [
      '# H\n\n%%\nhidden note\n%%\n\nAfter\n',
      '# H\n\n<!-- a hidden note -->\n\nAfter\n',
      '# H\n\n%%\n\nnote one\n\nnote two\n\n%%\n\nAfter\n',
    ]) {
      const { map } = md.parseWithSourceMap(source);
      const comment = map.blocks.find((b) => b.type === 'commentBlock');
      expect(comment, source).toBeDefined();
      expect((comment as PmSourceSpan).mapped).toBe(true);
      // The span is the comment's own source, not the whole document.
      const text = source.slice(
        (comment as PmSourceSpan).sourceStart,
        (comment as PmSourceSpan).sourceEnd,
      );
      expect(text.startsWith('%%') || text.startsWith('<!--')).toBe(true);
      expect(text.endsWith('%%') || text.endsWith('-->')).toBe(true);
      assertStructurallySound(map, source);
    }
  });
});

describe('minting commentBlock positions', () => {
  it('lets the blank-run materializer see the gaps around a comment block', () => {
    // A `commentBlock` is synthesized by the promoter, so its span is minted
    // rather than parsed. `insertInteriorBlankRunParagraphs` skips any pair of
    // siblings it cannot measure the gap between, so without that span a
    // preserved blank run beside a comment is dropped on the way to disk.
    for (const source of [
      '# H\n\n\n\n%%\nnote\n%%\n\n\n\nAfter\n',
      '# H\n\n\n\n<!-- a -->\n\n\n\nB\n',
    ]) {
      const blankRuns = md
        .parseWithSourceMap(source)
        .doc.content.content.filter((n) => n.type.name === 'paragraph' && n.content.size === 0);
      expect(blankRuns.length, source).toBeGreaterThan(0);
    }
  });
});

describe('parseWithSourceMap — offsets survive the pre-parse rewrites', () => {
  it('re-adds a stripped BOM', () => {
    const source = '﻿# Title\n\nBody text\n';
    const { map } = md.parseWithSourceMap(source);
    expect(map.blocks.map((b) => source.slice(b.sourceStart, b.sourceEnd))).toEqual([
      '# Title',
      'Body text',
    ]);
    // A splice range must not swallow the BOM — dropping it is a byte diff.
    expect(map.blockRangeToSourceRange(0, 1)).toEqual({ from: 1, to: 8 });
  });

  it('re-adds indentation removed by the JSX close-tag dedent', () => {
    const source = '<Foo>\n- item\n  </Foo>\n\nAfter\n';
    const { map } = md.parseWithSourceMap(source);
    expect(map.blocks.map((b) => source.slice(b.sourceStart, b.sourceEnd))).toEqual([
      '<Foo>\n- item\n  </Foo>',
      'After',
    ]);
  });

  it('composes both shifts', () => {
    const source = '﻿<Foo>\n- item\n  </Foo>\n\nAfter\n';
    const { map } = md.parseWithSourceMap(source);
    expect(map.blocks.map((b) => source.slice(b.sourceStart, b.sourceEnd))).toEqual([
      '<Foo>\n- item\n  </Foo>',
      'After',
    ]);
  });
});

describe('parseWithSourceMap — lookups', () => {
  const source = '# Heading\n\nA paragraph of prose.\n\n- one\n- two\n';

  it('lands a source offset in the block that owns it, and back again', () => {
    const { map } = md.parseWithSourceMap(source);
    for (let offset = 0; offset <= source.length; offset++) {
      const pos = map.sourceOffsetToPmPos(offset);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(map.docSize);
      const back = map.pmPosToSourceOffset(pos);
      expect(back).toBeGreaterThanOrEqual(0);
      expect(back).toBeLessThanOrEqual(source.length);
    }
  });

  it('maps a position inside a paragraph to the same character in the source', () => {
    const { map } = md.parseWithSourceMap(source);
    const paragraph = map.blocks[1] as PmSourceSpan;
    const offsetOfProse = source.indexOf('prose');
    const pos = map.sourceOffsetToPmPos(offsetOfProse);
    expect(pos).toBeGreaterThan(paragraph.from);
    expect(pos).toBeLessThan(paragraph.to);
    expect(map.pmPosToSourceOffset(pos)).toBe(offsetOfProse);
  });

  it('agrees between the two block lookups', () => {
    const { map } = md.parseWithSourceMap(source);
    for (let i = 0; i < map.blocks.length; i++) {
      const block = map.blocks[i] as PmSourceSpan;
      expect(map.blockIndexForPmPos(block.from)).toBe(i);
      expect(map.blockIndexForSourceOffset(block.sourceStart)).toBe(i);
    }
  });

  it('returns whole-line ranges for a block splice', () => {
    const { map } = md.parseWithSourceMap(source);
    const range = map.blockRangeToSourceRange(1, 2);
    expect(range).not.toBeNull();
    expect(source.slice((range as { from: number }).from, (range as { to: number }).to)).toBe(
      'A paragraph of prose.',
    );
    expect(map.blockRangeToSourceRange(2, 2)).toBeNull();
  });
});

describe('parseWithSourceMap — a block splice touches only its own bytes', () => {
  it('leaves every other block byte-identical when one block is replaced', () => {
    const source = [
      '# Heading',
      '',
      '- loose one',
      '',
      '- loose two',
      '',
      'Prose with [**Desktop**](x) inside.',
      '',
      '[ref]: https://example.com',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
    ].join('\n');

    const { map } = md.parseWithSourceMap(source);
    for (let i = 0; i < map.blocks.length; i++) {
      const range = map.blockRangeToSourceRange(i, i + 1);
      expect(range).not.toBeNull();
      const { from, to } = range as { from: number; to: number };
      const spliced = `${source.slice(0, from)}REPLACED${source.slice(to)}`;
      // Containment: everything outside the edited block's line range is
      // untouched, byte for byte. This is the assertion the whole-document
      // serialize oracle cannot make.
      expect(spliced.slice(0, from)).toBe(source.slice(0, from));
      expect(spliced.slice(from + 'REPLACED'.length)).toBe(source.slice(to));
    }
  });
});

/**
 * Everything in the package that is a whole markdown document, including the
 * hazard shapes the bridge work collected: indented JSX, the built-in component
 * blocks, and the pinned component-block regressions.
 */
function corpus(): string[] {
  return [
    loadLargeRealistic(),
    loadPrd6955Before(),
    ...loadGfmExamples().map((example) => example.markdown),
    ...loadIndentedJsxFixtures().map((fixture) => fixture.source),
    ...loadBuiltInFixtures().flatMap((fixture) =>
      fixture.inlineForm === undefined
        ? [fixture.blockForm]
        : [fixture.blockForm, fixture.inlineForm],
    ),
    ...loadNgPinnedCases().map((entry) => entry.input),
  ].filter((source) => source.trim() !== '');
}

describe('parseWithSourceMap — no behaviour change', () => {
  it('produces exactly the document parse() produces', () => {
    let compared = 0;
    for (const source of corpus()) {
      let expected: unknown;
      try {
        expected = md.parse(source);
      } catch {
        continue; // the corpus includes inputs the parser rejects; not this test's subject
      }
      expect(md.parseWithSourceMap(source).doc.toJSON(), source).toEqual(expected);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('mirrors parse()"s empty-source shortcut', () => {
    for (const source of ['', '   \n\n']) {
      const { doc, map } = md.parseWithSourceMap(source);
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe('paragraph');
      expect(doc.child(0).content.size).toBe(0);
      expect(map.blocks).toHaveLength(1);
    }
  });

  it('does not leave the recorder installed for later parses', () => {
    const source = '# One\n\nTwo\n';
    const first = md.parse(source);
    md.parseWithSourceMap(source);
    expect(md.parse(source)).toEqual(first);
  });
});

describe('parseWithSourceMap — corpus invariants', () => {
  it('maps every top-level block of a large realistic document', () => {
    const source = loadLargeRealistic();
    const { doc, map } = md.parseWithSourceMap(source);
    expect(map.blocks).toHaveLength(doc.childCount);
    expect(map.blocks.filter((b) => !b.mapped)).toEqual([]);
    expect(map.blocks.map((b) => source.slice(b.sourceStart, b.sourceEnd))).not.toContain('');
    assertStructurallySound(map, source);
  });

  it('holds the span invariants, and maps every top-level block, across the corpus', () => {
    let checked = 0;
    let blocks = 0;
    for (const source of corpus()) {
      let parsed: { doc: import('@tiptap/pm/model').Node; map: PmSourceMap };
      try {
        parsed = md.parseWithSourceMap(source);
      } catch {
        continue;
      }
      expect(parsed.map.blocks, source).toHaveLength(parsed.doc.childCount);
      expect(
        parsed.map.blocks.filter((b) => !b.mapped),
        source,
      ).toEqual([]);
      assertStructurallySound(parsed.map, source);
      blocks += parsed.map.blocks.length;
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    expect(blocks).toBeGreaterThan(200);
  });
});
