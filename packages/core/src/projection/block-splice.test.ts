/**
 * The single-CRDT write path: a WYSIWYG edit becomes one `Y.Text` splice.
 *
 * The oracle here is deliberately NOT "serialize the whole edited document".
 * That oracle disagrees with a correct block splice on roughly a tenth of real
 * documents, and every disagreement is the oracle renormalizing blocks the user
 * never touched — scoring the better behaviour as a failure. What is asserted
 * instead is the pair of properties the migration actually needs:
 *
 *  - CONTAINMENT: every byte outside the edited block's line range is identical
 *    before and after. This is strictly stronger than what today's bridge
 *    provides, which line-diffs a whole re-serialized document.
 *  - FIDELITY: re-projecting the spliced source yields the document the user
 *    edited into being — the edit landed, and nothing else moved.
 */

import { describe, expect, it } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { loadLargeRealistic } from '../markdown/fixtures/index.ts';
import { MarkdownManager } from '../markdown/index.ts';
import {
  applySplice,
  buildProjection,
  changedProjectionBlocks,
  computeBlockSplice,
  type Projection,
  rebaseProjection,
  serializeBlockRange,
} from './block-splice.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

/** Replace one top-level block of a projection's doc, the way an edit would. */
function replaceBlock(projection: Projection, index: number, markdown: string) {
  const replacement = md.parse(markdown);
  const node = projection.doc.type.schema.nodeFromJSON(replacement);
  const children = [];
  for (let i = 0; i < projection.doc.childCount; i++) children.push(projection.doc.child(i));
  children.splice(index, 1, ...Array.from({ length: node.childCount }, (_, i) => node.child(i)));
  return projection.doc.type.create(projection.doc.attrs, children);
}

function withBlocks(projection: Projection, mutate: (children: unknown[]) => void) {
  const children = [];
  for (let i = 0; i < projection.doc.childCount; i++) children.push(projection.doc.child(i));
  mutate(children);
  return projection.doc.type.create(projection.doc.attrs, children as never);
}

const DOC = [
  '# Heading',
  '',
  'A paragraph with [**Desktop**](x) inside it.',
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
  'Trailing paragraph.',
  '',
].join('\n');

describe('changedProjectionBlocks', () => {
  it('reports nothing for an untouched document', () => {
    const { doc } = buildProjection(DOC, md);
    expect(changedProjectionBlocks(doc, doc)).toBeNull();
  });

  it('narrows to the single edited block', () => {
    const projection = buildProjection(DOC, md);
    const after = replaceBlock(projection, 2, '- one\n- two\n- three\n');
    expect(changedProjectionBlocks(projection.doc, after)).toEqual({
      before: { from: 2, to: 3 },
      after: { from: 2, to: 3 },
    });
  });

  it('reports an empty before-range for an insertion and an empty after-range for a deletion', () => {
    const projection = buildProjection(DOC, md);
    const block = projection.doc.type.schema.nodeFromJSON(md.parse('Inserted.\n')).child(0);
    const withInsert = withBlocks(projection, (children) => {
      children.splice(1, 0, block as never);
    });
    expect(changedProjectionBlocks(projection.doc, withInsert)).toEqual({
      before: { from: 1, to: 1 },
      after: { from: 1, to: 2 },
    });

    const withDelete = withBlocks(projection, (children) => {
      children.splice(1, 1);
    });
    expect(changedProjectionBlocks(projection.doc, withDelete)).toEqual({
      before: { from: 1, to: 2 },
      after: { from: 1, to: 1 },
    });
  });
});

describe('serializeBlockRange', () => {
  it('emits only the requested blocks', () => {
    const { doc } = buildProjection(DOC, md);
    expect(serializeBlockRange(doc, { from: 0, to: 1 }, md)).toBe('# Heading');
    expect(serializeBlockRange(doc, { from: 2, to: 3 }, md)).toBe('- one\n- two');
    expect(serializeBlockRange(doc, { from: 0, to: 0 }, md)).toBe('');
  });

  it('does not replay the document boundary around a block', () => {
    const source = '\n\n# Heading\n\nBody.\n\n\n';
    const { doc } = buildProjection(source, md);
    const heading = doc.child(0).type.name === 'paragraph' ? 2 : 0;
    expect(serializeBlockRange(doc, { from: heading, to: heading + 1 }, md)).toBe('# Heading');
  });
});

describe('computeBlockSplice — containment', () => {
  it('replaces one block and leaves every other byte identical', () => {
    const projection = buildProjection(DOC, md);
    for (let i = 0; i < projection.doc.childCount; i++) {
      const fresh = buildProjection(DOC, md);
      const after = replaceBlock(fresh, i, 'REPLACED.\n');
      const splice = computeBlockSplice(fresh, after, md);
      expect(splice, `block ${i}`).not.toBeNull();
      const next = applySplice(DOC, splice as { from: number; to: number; text: string });
      const { from, to, text } = splice as { from: number; to: number; text: string };
      expect(next.slice(0, from)).toBe(DOC.slice(0, from));
      expect(next.slice(from + text.length)).toBe(DOC.slice(to));
      expect(next).toContain('REPLACED.');
    }
  });

  it('does not renormalize a block the user did not touch', () => {
    // The exact shape the whole-document oracle gets wrong: serializing the
    // whole doc rewrites `[**Desktop**](x)` to `**[Desktop](x)**`.
    const projection = buildProjection(DOC, md);
    const after = replaceBlock(projection, 0, '# Edited heading\n');
    const splice = computeBlockSplice(projection, after, md);
    const next = applySplice(DOC, splice as never);
    expect(next).toContain('[**Desktop**](x)');
    expect(next).not.toContain('**[Desktop](x)**');
  });

  it('round-trips the edit through a fresh projection', () => {
    const projection = buildProjection(DOC, md);
    const after = replaceBlock(projection, 4, '```ts\nconst x = 2;\n```\n');
    const next = applySplice(DOC, computeBlockSplice(projection, after, md) as never);
    const reprojected = buildProjection(next, md);
    expect(reprojected.doc.childCount).toBe(projection.doc.childCount);
    expect(next).toContain('const x = 2;');
    expect(next).not.toContain('const x = 1;');
  });
});

describe('computeBlockSplice — insertion and deletion', () => {
  it('inserts a block with its own separator', () => {
    const projection = buildProjection(DOC, md);
    const block = projection.doc.type.schema.nodeFromJSON(md.parse('Inserted.\n')).child(0);
    const after = withBlocks(projection, (children) => {
      children.splice(1, 0, block as never);
    });
    const next = applySplice(DOC, computeBlockSplice(projection, after, md) as never);
    expect(next).toBe(DOC.replace('A paragraph', 'Inserted.\n\nA paragraph'));
    expect(buildProjection(next, md).doc.childCount).toBe(projection.doc.childCount + 1);
  });

  it('appends a block at the end of the document', () => {
    const projection = buildProjection(DOC, md);
    const block = projection.doc.type.schema.nodeFromJSON(md.parse('Appended.\n')).child(0);
    const after = withBlocks(projection, (children) => {
      children.push(block as never);
    });
    const next = applySplice(DOC, computeBlockSplice(projection, after, md) as never);
    // The document's own trailing newline is outside every block span, so the
    // append lands before it and the file keeps its final newline.
    expect(next).toBe(`${DOC.slice(0, -1)}\n\nAppended.\n`);
    expect(buildProjection(next, md).doc.childCount).toBe(projection.doc.childCount + 1);
  });

  it('deletes a block and the blank run that separated it', () => {
    const projection = buildProjection(DOC, md);
    const after = withBlocks(projection, (children) => {
      children.splice(1, 1);
    });
    const next = applySplice(DOC, computeBlockSplice(projection, after, md) as never);
    expect(next).not.toContain('A paragraph with');
    expect(next).not.toMatch(/\n\n\n/);
    expect(buildProjection(next, md).doc.childCount).toBe(projection.doc.childCount - 1);
  });
});

describe('computeBlockSplice — frontmatter', () => {
  const withFm = `---\ntitle: Test\n---\n\n# Heading\n\nBody paragraph.\n`;

  it('addresses the full Y.Text, leaving the frontmatter region untouched', () => {
    const projection = buildProjection(withFm, md);
    expect(projection.bodyOffset).toBe('---\ntitle: Test\n---\n'.length);
    const after = replaceBlock(projection, 1, 'Edited body.\n');
    const splice = computeBlockSplice(projection, after, md) as {
      from: number;
      to: number;
      text: string;
    };
    expect(splice.from).toBeGreaterThanOrEqual(projection.bodyOffset);
    const next = applySplice(withFm, splice);
    expect(next.startsWith('---\ntitle: Test\n---\n')).toBe(true);
    expect(next).toContain('Edited body.');
    expect(next).toContain('# Heading');
  });
});

describe('computeBlockSplice — corpus containment', () => {
  it('touches only the edited block across a large realistic document', () => {
    const source = loadLargeRealistic();
    const projection = buildProjection(source, md);
    const count = projection.doc.childCount;
    // Sample across the document rather than every block: the property is
    // per-block and the document is long.
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 40))) {
      const fresh = buildProjection(source, md);
      const after = replaceBlock(fresh, i, 'REPLACED.\n');
      const splice = computeBlockSplice(fresh, after, md);
      if (splice === null) continue;
      const next = applySplice(source, splice);
      expect(next.slice(0, splice.from), `block ${i}`).toBe(source.slice(0, splice.from));
      expect(next.slice(splice.from + splice.text.length), `block ${i}`).toBe(
        source.slice(splice.to),
      );
      expect(splice.text, `block ${i}`).toContain('REPLACED.');
    }
  });
});

describe('rebaseProjection', () => {
  /** Every rebase claim, checked against the parse it is standing in for. */
  function expectAgreesWithRebuild(rebased: Projection) {
    const rebuilt = buildProjection(rebased.source, md);
    expect(rebased.map.precision).toBe('block');
    expect(rebuilt.doc.childCount).toBe(rebased.doc.childCount);
    expect(rebased.map.blocks).toHaveLength(rebuilt.map.blocks.length);
    for (let i = 0; i < rebuilt.map.blocks.length; i++) {
      const got = rebased.map.blocks[i] as { sourceStart: number; sourceEnd: number };
      const want = rebuilt.map.blocks[i] as { sourceStart: number; sourceEnd: number };
      const body = rebased.source.slice(rebased.bodyOffset);
      expect(body.slice(got.sourceStart, got.sourceEnd), `block ${i}`).toBe(
        body.slice(want.sourceStart, want.sourceEnd),
      );
    }
  }

  it('agrees with a full rebuild after replacing any single block', () => {
    for (let i = 0; i < buildProjection(DOC, md).doc.childCount; i++) {
      const projection = buildProjection(DOC, md);
      const after = replaceBlock(projection, i, 'REPLACED text.\n');
      const changed = changedProjectionBlocks(projection.doc, after);
      const splice = computeBlockSplice(projection, after, md, changed);
      const rebased = rebaseProjection(
        projection,
        after,
        changed as never,
        splice as never,
      ) as Projection;
      expect(rebased, `block ${i}`).not.toBeNull();
      expectAgreesWithRebuild(rebased);
    }
  });

  it('agrees with a full rebuild after an insertion and after a deletion', () => {
    const projection = buildProjection(DOC, md);
    const block = projection.doc.type.schema.nodeFromJSON(md.parse('Inserted.\n')).child(0);

    const inserted = withBlocks(projection, (children) => {
      children.splice(1, 0, block as never);
    });
    const insertChange = changedProjectionBlocks(projection.doc, inserted);
    const insertSplice = computeBlockSplice(projection, inserted, md, insertChange);
    expectAgreesWithRebuild(
      rebaseProjection(projection, inserted, insertChange as never, insertSplice as never) as never,
    );

    const deleted = withBlocks(projection, (children) => {
      children.splice(1, 1);
    });
    const deleteChange = changedProjectionBlocks(projection.doc, deleted);
    const deleteSplice = computeBlockSplice(projection, deleted, md, deleteChange);
    expectAgreesWithRebuild(
      rebaseProjection(projection, deleted, deleteChange as never, deleteSplice as never) as never,
    );
  });

  it('survives a run of consecutive edits without ever rebuilding', () => {
    // The property that matters: a rebased projection is a valid input to the
    // next splice. If it were not, the second keystroke would write at stale
    // offsets and corrupt the document.
    let projection = buildProjection(DOC, md);
    for (const [index, text] of [
      [0, '# First edit\n'],
      [6, 'Last edit.\n'],
      [2, '- one\n- two\n- three\n'],
      [0, '# Second edit\n'],
    ] as const) {
      const after = replaceBlock(projection, index, text);
      const changed = changedProjectionBlocks(projection.doc, after);
      const splice = computeBlockSplice(projection, after, md, changed);
      const next = rebaseProjection(projection, after, changed as never, splice as never);
      expect(next, text).not.toBeNull();
      projection = next as Projection;
      expectAgreesWithRebuild(projection);
    }
    expect(projection.source).toContain('# Second edit');
    expect(projection.source).toContain('- three');
    expect(projection.source).toContain('Last edit.');
    // Untouched blocks kept their authored bytes throughout.
    expect(projection.source).toContain('[**Desktop**](x)');
  });

  it('keeps the frontmatter region out of the rebased coordinates', () => {
    const withFm = `---\ntitle: Test\n---\n\n# Heading\n\nBody paragraph.\n`;
    const projection = buildProjection(withFm, md);
    const after = replaceBlock(projection, 1, 'Edited body.\n');
    const changed = changedProjectionBlocks(projection.doc, after);
    const splice = computeBlockSplice(projection, after, md, changed);
    const rebased = rebaseProjection(
      projection,
      after,
      changed as never,
      splice as never,
    ) as Projection;
    expect(rebased.bodyOffset).toBe(projection.bodyOffset);
    expectAgreesWithRebuild(rebased);
  });

  it('declines a multi-block replacement rather than guessing the separator', () => {
    const projection = buildProjection(DOC, md);
    const replacement = projection.doc.type.schema.nodeFromJSON(md.parse('One.\n\nTwo.\n'));
    const after = withBlocks(projection, (children) => {
      children.splice(1, 2, replacement.child(0) as never, replacement.child(1) as never);
    });
    const changed = changedProjectionBlocks(projection.doc, after);
    const splice = computeBlockSplice(projection, after, md, changed);
    expect(splice).not.toBeNull();
    expect(rebaseProjection(projection, after, changed as never, splice as never)).toBeNull();
  });
});
