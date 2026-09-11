import {
  buildProjection,
  computeSourceBlocks,
  MarkdownManager,
  type Projection,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  blockRangeToPmRange,
  blockRangeToSourceRange,
  caretPmPosToSourceOffset,
  caretSourceOffsetToPmPos,
  createFullPrecisionResolver,
  fullPrecisionProjection,
  liveCaretPmPosToSourceOffset,
  pmPosToSourceOffset,
  sourceEndOffsetToPmPos,
  sourceOffsetToPmPos,
} from './projection-coordinates';

const md = new MarkdownManager({ extensions: sharedExtensions, deriveStructuralFreshness: true });

const PARAS = [
  'Alpha paragraph zero.',
  'Bravo paragraph one.',
  'Charlie paragraph two.',
  'Delta paragraph three.',
  'Echo paragraph four.',
];
const DOC = `${PARAS.join('\n\n')}\n`;
const FM_DOC = `---\ntitle: T\n---\n\n${DOC}`;

function asBlockPrecision(projection: Projection): Projection {
  return { ...projection, map: { ...projection.map, precision: 'block' } };
}

function pmChildRange(source: string, index: number): { from: number; to: number } {
  const doc = buildProjection(source, md).doc;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return { from: pos, to: pos + doc.child(index).nodeSize };
}

describe('full precision', () => {
  it('returns the projection untouched when the map is already a parse result', () => {
    const projection = buildProjection(DOC, md);
    expect(projection.map.precision).toBe('full');
    expect(fullPrecisionProjection(projection, md)).toBe(projection);
  });

  it('rebuilds when the map did not come from a parse', () => {
    const rebased = asBlockPrecision(buildProjection(DOC, md));
    const full = fullPrecisionProjection(rebased, md);
    expect(full.map.precision).toBe('full');
    expect(full.source).toBe(rebased.source);
  });

  it('parses once for repeated lookups against one source, and again when it changes', () => {
    const resolve = createFullPrecisionResolver(md);

    resolve(asBlockPrecision(buildProjection(DOC, md)));
    resolve(asBlockPrecision(buildProjection(DOC, md)));
    expect(resolve.parses()).toBe(1);

    resolve(asBlockPrecision(buildProjection(`${DOC}\nSixth paragraph.\n`, md)));
    expect(resolve.parses()).toBe(2);
  });

  it('does not count a parse when the map needed no rebuild', () => {
    const resolve = createFullPrecisionResolver(md);
    resolve(buildProjection(DOC, md));
    expect(resolve.parses()).toBe(0);
  });
});

describe('offset and position round trips', () => {
  it('carries the frontmatter offset in both directions', () => {
    const projection = buildProjection(FM_DOC, md);
    expect(projection.bodyOffset).toBe(FM_DOC.indexOf('---\n\n') + 4);
    const alphaOffset = FM_DOC.indexOf('Alpha');
    const pos = sourceOffsetToPmPos(projection, alphaOffset);
    expect(pmPosToSourceOffset(projection, pos)).toBe(alphaOffset);
  });

  it('round trips a mid-document caret', () => {
    const projection = buildProjection(DOC, md);
    const offset = DOC.indexOf('Charlie') + 4;
    const pos = sourceOffsetToPmPos(projection, offset);
    expect(pmPosToSourceOffset(projection, pos)).toBe(offset);
  });
});

describe('an exclusive range end', () => {
  it('falls through to the end of the document when read as a caret', () => {
    const projection = buildProjection(DOC, md);
    const { blocks } = computeSourceBlocks(DOC, md);
    const blockEnd = blocks[2]?.sourceEnd as number;
    expect(sourceOffsetToPmPos(projection, blockEnd)).toBe(projection.doc.content.size);
  });

  it('stays inside its own block when read as a range end', () => {
    const projection = buildProjection(DOC, md);
    const { blocks } = computeSourceBlocks(DOC, md);
    const blockEnd = blocks[2]?.sourceEnd as number;
    const child = pmChildRange(DOC, 2);
    const pos = sourceEndOffsetToPmPos(projection, blockEnd);
    expect(pos).toBeGreaterThan(child.from);
    expect(pos).toBeLessThan(child.to);
  });
});

describe('block ranges resolve through source offsets', () => {
  it('maps one block onto that block, not onto the rest of the document', () => {
    const projection = buildProjection(DOC, md);
    const range = blockRangeToPmRange(projection, md, 3, 4);
    const child = pmChildRange(DOC, 3);
    expect(range).not.toBeNull();
    expect(range?.from).toBeGreaterThanOrEqual(child.from);
    expect(range?.to).toBeLessThanOrEqual(child.to);
    expect(range?.to).toBeLessThan(projection.doc.content.size);
  });

  it('covers exactly the text of the block it names', () => {
    const projection = buildProjection(DOC, md);
    const range = blockRangeToPmRange(projection, md, 1, 2);
    expect(range).not.toBeNull();
    expect(projection.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(PARAS[1]);
  });

  it('spans a multi-block range from the first block to the last', () => {
    const projection = buildProjection(DOC, md);
    const range = blockRangeToPmRange(projection, md, 1, 3);
    expect(projection.doc.textBetween(range?.from ?? 0, range?.to ?? 0, '\n')).toBe(
      `${PARAS[1]}\n${PARAS[2]}`,
    );
  });

  it('offsets a frontmatter document by the body offset', () => {
    const projection = buildProjection(FM_DOC, md);
    const range = blockRangeToPmRange(projection, md, 2, 3);
    expect(projection.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(PARAS[2]);
  });

  it('resolves through a block-granular map by rebuilding first', () => {
    const projection = buildProjection(DOC, md);
    const resolve = createFullPrecisionResolver(md);
    const range = blockRangeToPmRange(resolve(asBlockPrecision(projection)), md, 3, 4);
    expect(resolve.parses()).toBe(1);
    expect(projection.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(PARAS[3]);
  });

  it('declines rather than guessing when the source parses to no blocks but one fallback node', () => {
    const broken = 'one\n\n</Callout>\n\ntwo\n';
    const projection = buildProjection(broken, md);
    expect(computeSourceBlocks(broken, md).blocks).toHaveLength(0);
    expect(projection.doc.childCount).toBe(3);
    expect(blockRangeToSourceRange(broken, md, 0, 1)).toBeNull();
    expect(blockRangeToPmRange(projection, md, 0, 1)).toBeNull();
  });

  it('clamps a block range that runs past the end of the table', () => {
    const projection = buildProjection(DOC, md);
    const range = blockRangeToPmRange(projection, md, 4, 99);
    expect(projection.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(PARAS[4]);
  });
});

describe('a caret round trips at every position a user can put one', () => {
  function selectablePositions(source: string): number[] {
    const doc = buildProjection(source, md).doc;
    const positions: number[] = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      for (let offset = 0; offset <= node.content.size; offset++) positions.push(pos + 1 + offset);
      return false;
    });
    return positions;
  }

  for (const [name, source] of Object.entries({
    paragraphs: DOC,
    withFrontmatter: FM_DOC,
    withEmphasis: 'plain and **bold** and *italic* here.\n\nsecond block.\n',
    withList: 'intro\n\n- one item\n- two item\n\nafter\n',
    withHeading: '# Heading here\n\nbody text.\n',
    withBlankRun: 'one\n\n\n\ntwo\n',
    withTrailingSpace: 'Alpha paragraph zero. \n\nBravo paragraph one.\n',
  })) {
    it(`is its own inverse across ${name}`, () => {
      const projection = buildProjection(source, md);
      const broken: string[] = [];
      for (const pos of selectablePositions(source)) {
        const offset = caretPmPosToSourceOffset(projection, pos);
        const back = caretSourceOffsetToPmPos(projection, offset);
        if (back !== pos) broken.push(`pm=${pos} -> src=${offset} -> pm=${back}`);
      }
      expect(broken).toEqual([]);
    });
  }

  it('puts a caret at the end of a paragraph on that paragraph, not one character back', () => {
    const projection = buildProjection(DOC, md);
    const firstEnd = projection.doc.child(0).content.size + 1;
    const offset = caretPmPosToSourceOffset(projection, firstEnd);
    expect(DOC.slice(0, offset)).toBe(PARAS[0]);
    expect(caretSourceOffsetToPmPos(projection, offset)).toBe(firstEnd);
  });

  it('does not fling a caret at a block end to the end of the document', () => {
    const projection = buildProjection(DOC, md);
    const endOfFirst = DOC.indexOf('\n');
    expect(sourceOffsetToPmPos(projection, endOfFirst)).toBe(projection.doc.content.size);
    expect(caretSourceOffsetToPmPos(projection, endOfFirst)).toBeLessThan(
      projection.doc.content.size,
    );
  });

  it('holds a caret in the blank gap between blocks inside the block before it', () => {
    const projection = buildProjection(DOC, md);
    const gap = DOC.indexOf('\n') + 1;
    const pos = caretSourceOffsetToPmPos(projection, gap);
    expect(pos).toBeLessThan(projection.doc.child(0).nodeSize);
  });

  function topLevelBoundaries(source: string): Set<number> {
    const doc = buildProjection(source, md).doc;
    const edges = new Set<number>();
    let at = 0;
    for (let i = 0; i < doc.childCount; i++) {
      edges.add(at);
      at += doc.child(i).nodeSize;
    }
    edges.add(at);
    return edges;
  }

  for (const [name, source] of Object.entries({
    paragraphs: DOC,
    withFrontmatter: FM_DOC,
    withList: 'intro\n\n- one item\n- two item\n\nafter\n',
    withBlankRun: 'one\n\n\n\ntwo\n',
    withHeading: '# Heading here\n\nbody text.\n',
    withTrailingSpace: 'Alpha paragraph zero. \n\nBravo paragraph one.\n',
    withTrailingSpaceHeading: '# Heading here \n\nbody text.\n',
  })) {
    it(`never resolves a source offset onto a top-level block boundary in ${name}`, () => {
      const projection = buildProjection(source, md);
      const edges = topLevelBoundaries(source);
      const landed: string[] = [];
      for (let offset = 0; offset <= source.length; offset++) {
        const pos = caretSourceOffsetToPmPos(projection, offset);
        if (edges.has(pos) && pos !== 0) landed.push(`src=${offset} -> pm=${pos}`);
      }
      expect(landed).toEqual([]);
    });
  }
});

describe('a caret after trailing whitespace stays at the end of its own block', () => {
  for (const [name, source, text] of [
    ['a paragraph', 'Alpha paragraph zero. \n\nBravo paragraph one.\n', 'Alpha paragraph zero.'],
    ['two spaces', 'Alpha paragraph zero.  \n\nBravo paragraph one.\n', 'Alpha paragraph zero.'],
    ['three spaces', 'Alpha paragraph zero.   \n\nBravo paragraph one.\n', 'Alpha paragraph zero.'],
    ['a tab', 'Alpha paragraph zero.\t\n\nBravo paragraph one.\n', 'Alpha paragraph zero.'],
    ['a heading', '# Heading here \n\nbody text.\n', 'Heading here'],
    ['a list item', 'intro\n\n- one item \n- two item\n\nafter\n', 'one item'],
    ['the last list item', 'intro\n\n- one item\n- two item \n\nafter\n', 'two item'],
  ] as const) {
    it(`in ${name}`, () => {
      const projection = buildProjection(source, md);
      const textEnd = source.indexOf(text) + text.length;
      const lineEnd = source.indexOf('\n', textEnd);
      const expected = `${JSON.stringify(text)}@${text.length}`;
      const landed: string[] = [];
      for (let offset = textEnd; offset <= lineEnd; offset++) {
        const $pos = projection.doc.resolve(caretSourceOffsetToPmPos(projection, offset));
        const at = `${JSON.stringify($pos.parent.textContent)}@${$pos.parentOffset}`;
        if (at !== expected) landed.push(`src=${offset} -> ${at}`);
      }
      expect(landed).toEqual([]);
    });
  }

  it('still sends a caret before a list marker into the item it starts', () => {
    const source = 'intro\n\n- one item \n- two item\n\nafter\n';
    const projection = buildProjection(source, md);
    const $pos = projection.doc.resolve(
      caretSourceOffsetToPmPos(projection, source.indexOf('- two')),
    );
    expect($pos.parent.isTextblock ? $pos.parent.textContent : $pos.parent.type.name).not.toBe(
      'one item',
    );
  });
});

describe('a caret after characters the source does not spell yet', () => {
  const SOURCE = 'Alpha paragraph zero.\n\nBravo paragraph one.\n';

  const editorMd = new MarkdownManager({ extensions: sharedExtensions });

  function withTrailingSpace(projection: Projection): Projection['doc'] {
    const { doc } = buildProjection(projection.source, editorMd);
    const first = doc.child(0);
    const spaced = first.type.create(first.attrs, doc.type.schema.text(`${first.textContent} `));
    return doc.copy(doc.content.replaceChild(0, spaced));
  }

  it('builds the live document in a schema of its own, as the editor does', () => {
    const full = buildProjection(SOURCE, md);
    expect(withTrailingSpace(full).type.schema).not.toBe(full.doc.type.schema);
  });

  it('maps a caret after an unwritten trailing space to the end of the bytes its block has', () => {
    const full = buildProjection(SOURCE, md);
    const live = withTrailingSpace(full);
    const afterSpace = live.child(0).nodeSize - 1;
    const offset = liveCaretPmPosToSourceOffset(full, live, afterSpace);
    expect(SOURCE.slice(0, offset)).toBe('Alpha paragraph zero.');
  });

  it('maps a caret in a later block by the bytes, not one to the right per unwritten character', () => {
    const full = buildProjection(SOURCE, md);
    const live = withTrailingSpace(full);
    const start = live.child(0).nodeSize + 1;
    const text = 'Bravo paragraph one.';
    const wrong: string[] = [];
    for (let k = 0; k <= text.length; k++) {
      const offset = liveCaretPmPosToSourceOffset(full, live, start + k);
      if (offset !== SOURCE.indexOf(text) + k) wrong.push(`k=${k} -> ${offset}`);
    }
    expect(wrong).toEqual([]);
  });

  it('is the plain caret mapping when the live document is the parse', () => {
    const full = buildProjection(SOURCE, md);
    for (let pos = 1; pos < full.doc.content.size; pos++) {
      expect(liveCaretPmPosToSourceOffset(full, full.doc, pos)).toBe(
        caretPmPosToSourceOffset(full, pos),
      );
    }
  });

  it('keeps the plain caret mapping when the documents differ by more than one block', () => {
    const full = buildProjection(SOURCE, md);
    const live = full.doc.copy(full.doc.content.addToEnd(full.doc.child(1)));
    for (let pos = 1; pos < full.doc.content.size; pos++) {
      expect(liveCaretPmPosToSourceOffset(full, live, pos)).toBe(
        caretPmPosToSourceOffset(full, pos),
      );
    }
  });
});
