/**
 * Block ordinals derived from source alone.
 *
 * The property under test is not "these are the right strings" — the strings
 * are opaque identities and no consumer reads them. It is that the table is
 * INDEX-ALIGNED with the projected ProseMirror document's top-level children,
 * because every consumer indexes one by an ordinal taken from the other: the
 * agent write-flash maps a server-computed ordinal onto the client's PM doc,
 * and the lint decorations map a source line onto a PM block. So the oracle
 * throughout is `buildProjection(...).doc`, the very document the client builds
 * under the projection binding.
 *
 * The second property is the one `changedBlockRange` rests on: a block's
 * identity changes when its own bytes change, and only then. A snapshot that
 * missed a link-target rewrite would flash the wrong region; one that reported
 * an untouched block as changed would flash the whole document.
 */

import { describe, expect, it } from 'vitest';
import { changedBlockRange } from '../constants/activity.ts';
import { sharedExtensions } from '../extensions/shared.ts';
import { buildProjection } from '../projection/block-splice.ts';
import { MarkdownManager } from './index.ts';
import { computeSourceBlocks, sourceBlockSnapshot } from './source-blocks.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

/** Every block's identity, plus the PM child count the ordinals must match. */
function snapshotAndDoc(source: string): { blocks: string[]; childCount: number } {
  return {
    blocks: sourceBlockSnapshot(source, md),
    childCount: buildProjection(source, md).doc.childCount,
  };
}

describe('the source block table', () => {
  it.each([
    ['plain blocks', '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n'],
    ['a list and a fence', '- one\n- two\n\n```js\nconst a = 1;\n```\n'],
    ['a table', '| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n'],
    ['frontmatter', '---\ntitle: T\n---\n\n# Heading\n\nBody text.\n'],
    ['a preserved blank run', 'First.\n\n\n\nSecond.\n'],
    ['a thematic break', 'Above.\n\n---\n\nBelow.\n'],
  ])('is index-aligned with the projected document — %s', (_label, source) => {
    const { blocks, childCount } = snapshotAndDoc(source);
    expect(blocks).toHaveLength(childCount);
  });

  it('slices each block to its own source bytes', () => {
    const source = '# Title\n\nA paragraph.\n';
    const { blocks } = computeSourceBlocks(source, md);
    const sliced = blocks.map((b) =>
      b.sourceStart !== null && b.sourceEnd !== null
        ? source.slice(b.sourceStart, b.sourceEnd)
        : null,
    );
    expect(sliced).toEqual(['# Title', 'A paragraph.']);
  });

  it('shifts spans past the frontmatter fence', () => {
    const source = '---\ntitle: T\n---\n\n# Heading\n';
    const { blocks, fmLineCount } = computeSourceBlocks(source, md);
    const heading = blocks[0];
    expect(fmLineCount).toBeGreaterThan(0);
    expect(heading).toBeDefined();
    // Full-source coordinates: slicing the ORIGINAL source (fence included)
    // with the reported offsets must land on the heading, not on the fence.
    expect(source.slice(heading?.sourceStart ?? 0, heading?.sourceEnd ?? 0)).toBe('# Heading');
  });

  it('gives a materialized blank-run paragraph a zero-width span, not a null one', () => {
    // A preserved blank run becomes an empty top-level paragraph in the editor
    // view. It occupies no bytes, which is different from having no position —
    // conflating the two would let it slice up a neighbour's bytes.
    const { blocks } = computeSourceBlocks('First.\n\n\n\nSecond.\n', md);
    const empty = blocks.filter((b) => b.kind === 'paragraph' && b.text === '');
    expect(empty.length).toBeGreaterThan(0);
    for (const block of empty) {
      expect(block.sourceStart).not.toBeNull();
      expect(block.sourceStart).toBe(block.sourceEnd);
    }
  });

  it('answers no blocks rather than throwing on unparseable MDX', () => {
    // A half-typed JSX tag is a routine transient state in source mode.
    const source = '# Fine\n\n<Unclosed\n';
    expect(() => sourceBlockSnapshot(source, md)).not.toThrow();
  });
});

describe('a snapshot pair driving changedBlockRange', () => {
  const before = '# Title\n\nUntouched.\n\nEdit me.\n\nAlso untouched.\n';

  it('reports only the block whose bytes changed', () => {
    const after = before.replace('Edit me.', 'Edited.');
    const range = changedBlockRange(
      sourceBlockSnapshot(before, md),
      sourceBlockSnapshot(after, md),
    );
    expect(range).toEqual({ from: 2, to: 3 });
  });

  it('catches a change that leaves the visible text identical', () => {
    // The block's plain text is the same either way; only the link target
    // moved. A text-based identity would report no change and flash nothing.
    const linked = '# Title\n\nSee [docs](one.md).\n';
    const relinked = '# Title\n\nSee [docs](two.md).\n';
    const range = changedBlockRange(
      sourceBlockSnapshot(linked, md),
      sourceBlockSnapshot(relinked, md),
    );
    expect(range).toEqual({ from: 1, to: 2 });
  });

  it('collapses an append to the appended block', () => {
    const appended = `${before}\nNew section.\n`;
    const range = changedBlockRange(
      sourceBlockSnapshot(before, md),
      sourceBlockSnapshot(appended, md),
    );
    expect(range).not.toBeNull();
    expect(range?.to).toBe(sourceBlockSnapshot(appended, md).length);
    // The point of the prefix scan: an append must not claim the whole doc.
    expect(range?.from).toBeGreaterThan(0);
  });

  it('reports nothing for an unchanged document', () => {
    expect(
      changedBlockRange(sourceBlockSnapshot(before, md), sourceBlockSnapshot(before, md)),
    ).toBe(null);
  });
});
