import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { loadLargeRealistic } from '../markdown/fixtures/index.ts';
import { MarkdownManager } from '../markdown/index.ts';
import {
  alignProjectionToDoc,
  applySplice,
  buildProjection,
  changedProjectionBlocks,
  computeBlockSplice,
  type Projection,
  rebaseProjection,
  serializeBlockRange,
} from './block-splice.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

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

describe('buildProjection — a document the MDX parser rejects', () => {
  const BROKEN = 'Above.\n\n</Callout>\n\nBelow.\n';

  it('boxes only the rejected region and keeps its neighbours as real blocks', () => {
    const projection = buildProjection(BROKEN, md);
    expect(projection.doc.childCount).toBe(3);
    expect(projection.doc.child(0).type.name).toBe('paragraph');
    expect(projection.doc.child(1).type.name).toBe('rawMdxFallback');
    expect(projection.doc.child(2).type.name).toBe('paragraph');
    expect(projection.doc.child(1).textContent).toBe('</Callout>');
    expect(projection.doc.child(1).attrs.reason).toContain('closing slash');
  });

  it('gives every block an exact byte span, the raw one included', () => {
    const projection = buildProjection(BROKEN, md);
    expect(projection.map.blocks).toHaveLength(3);
    for (const [index, block] of projection.map.blocks.entries()) {
      expect(BROKEN.slice(block.sourceStart, block.sourceEnd)).toBe(
        projection.doc.child(index).textContent,
      );
    }
    expect(projection.map.blockRangeToSourceRange(0, 3)).toEqual({
      from: 0,
      to: BROKEN.trimEnd().length,
    });
    expect(projection.map.sourceLength).toBe(BROKEN.length);
  });

  it('rewrites only the edited neighbour and leaves the rejected bytes alone', () => {
    const projection = buildProjection(BROKEN, md);
    const children = [];
    for (let i = 0; i < projection.doc.childCount; i++) children.push(projection.doc.child(i));
    const replacement = projection.doc.type.schema.nodeFromJSON(md.parse('Edited.\n')).child(0);
    const after = projection.doc.type.schema.topNodeType.create(projection.doc.attrs, [
      replacement,
      ...children.slice(1),
    ] as never);

    const changed = changedProjectionBlocks(projection.doc, after);
    const splice = computeBlockSplice(projection, after, md, changed);
    expect(splice).toEqual({ from: 0, to: 6, text: 'Edited.' });
    expect(applySplice(BROKEN, splice as never)).toBe('Edited.\n\n</Callout>\n\nBelow.\n');
  });

  it('still boxes the whole body when the rejected region is the whole body', () => {
    const lone = '</Callout>\n';
    const projection = buildProjection(lone, md);
    expect(projection.doc.childCount).toBe(1);
    expect(projection.doc.child(0).type.name).toBe('rawMdxFallback');
    expect(projection.map.blocks).toHaveLength(1);
    expect(projection.map.blockRangeToSourceRange(0, 1)).toEqual({ from: 0, to: lone.length });
  });

  it('round-trips the rejected bytes verbatim', () => {
    const projection = buildProjection(BROKEN, md);
    expect(md.serialize(projection.doc.toJSON())).toBe(BROKEN);
  });

  it('keeps frontmatter out of the body it boxes', () => {
    const withFm = `---\ntitle: T\n---\n\n${BROKEN}`;
    const projection = buildProjection(withFm, md);
    expect(projection.doc.child(1).textContent).toBe('</Callout>');
    expect(projection.map.sourceLength).toBe(withFm.length - projection.bodyOffset);
    const body = withFm.slice(projection.bodyOffset);
    for (const [index, block] of projection.map.blocks.entries()) {
      expect(body.slice(block.sourceStart, block.sourceEnd)).toBe(
        projection.doc.child(index).textContent,
      );
    }
  });

  it('recovers a normal projection once the source parses again', () => {
    const repaired = buildProjection('Above.\n\nBelow.\n', md);
    expect(repaired.doc.childCount).toBe(2);
    expect(repaired.doc.child(0).type.name).toBe('paragraph');
  });
});

describe('computeBlockSplice — a block landing in a blank run', () => {
  function kids(doc: Projection['doc']) {
    const out = [];
    for (let i = 0; i < doc.childCount; i++) out.push(doc.child(i));
    return out;
  }

  function blank(projection: Projection) {
    return projection.doc.type.schema.node('paragraph');
  }

  function block(projection: Projection, markdown: string) {
    return projection.doc.type.schema.nodeFromJSON(md.parse(markdown)).child(0);
  }

  function docOf(projection: Projection, children: unknown[]) {
    return projection.doc.type.schema.topNodeType.create(projection.doc.attrs, children as never);
  }

  function advance(projection: Projection, after: Projection['doc']): Projection {
    const changed = changedProjectionBlocks(projection.doc, after);
    if (changed === null) return alignProjectionToDoc(projection, after);
    const splice = computeBlockSplice(projection, after, md, changed);
    expect(splice).not.toBeNull();
    const source = applySplice(projection.source, splice as never);
    const rebased = rebaseProjection(projection, after, changed, splice as never);
    if (rebased !== null) return rebased;
    const rebuilt = buildProjection(source, md);
    return rebuilt.doc.childCount === after.childCount
      ? { ...rebuilt, doc: after }
      : alignProjectionToDoc(rebuilt, after);
  }

  function pressEnter(projection: Projection, times: number): Projection {
    let out = projection;
    for (let i = 0; i < times; i++) out = advance(out, docOf(out, [...kids(out.doc), blank(out)]));
    return out;
  }

  function expectTableHolds(projection: Projection) {
    expect(projection.map.blocks).toHaveLength(projection.doc.childCount);
    expect(buildProjection(projection.source, md).doc.childCount).toBe(projection.doc.childCount);
  }

  it('reclaims the blank line spelling a lone interior blank once it gains content', () => {
    const before = buildProjection('hello\n\n\nhello\n', md);
    expect(before.doc.childCount).toBe(3);
    expect(before.map.blocks[1]?.sourceStart).toBe(before.map.blocks[1]?.sourceEnd);

    const after = docOf(before, [
      before.doc.child(0),
      block(before, 'error\n'),
      before.doc.child(2),
    ]);
    const changed = changedProjectionBlocks(before.doc, after);
    const splice = computeBlockSplice(before, after, md, changed);
    expect(splice).not.toBeNull();
    expect(applySplice(before.source, splice as never)).toBe('hello\n\nerror\n\nhello\n');
  });

  it('leaves a blank on each side of an interior blank run that only partly fills', () => {
    const before = buildProjection('hello\n\n\n\nhello\n', md);
    expect(before.doc.childCount).toBe(4);

    const after = docOf(before, [
      before.doc.child(0),
      block(before, 'error\n'),
      before.doc.child(2),
      before.doc.child(3),
    ]);
    const changed = changedProjectionBlocks(before.doc, after);
    const splice = computeBlockSplice(before, after, md, changed);
    expect(splice).not.toBeNull();
    const written = applySplice(before.source, splice as never);
    expect(buildProjection(written, md).doc.childCount).toBe(after.childCount);
  });

  it('writes the block below the blank run that precedes it, not above it', () => {
    const seeded = pressEnter(buildProjection('hello\n', md), 8);
    expect(seeded.source).toBe('hello\n\n\n\n\n\n\n\n\n');
    expect(seeded.doc.childCount).toBe(9);

    const after = advance(
      seeded,
      docOf(seeded, [...kids(seeded.doc).slice(0, 8), block(seeded, '# \n')]),
    );
    expect(after.source).toBe('hello\n\n\n\n\n\n\n\n\n#\n');
    expectTableHolds(after);

    const typed = advance(
      after,
      docOf(after, [...kids(after.doc).slice(0, 8), block(after, '# Head\n')]),
    );
    expect(typed.source).toBe('hello\n\n\n\n\n\n\n\n\n# Head\n');
    expectTableHolds(typed);
  });

  it('splits the run around a block inserted inside it', () => {
    const seeded = pressEnter(buildProjection('hello\n', md), 8);
    const children = kids(seeded.doc);
    const after = advance(
      seeded,
      docOf(seeded, [...children.slice(0, 4), block(seeded, '# \n'), ...children.slice(5)]),
    );
    expect(after.source).toBe('hello\n\n\n\n\n#\n\n\n\n\n');
    expectTableHolds(after);
  });

  it('keeps an interior run above a paragraph written over one of its blanks', () => {
    const seeded = buildProjection('Above.\n\n\n\nBelow.\n', md);
    const children = kids(seeded.doc);
    const after = advance(
      seeded,
      docOf(seeded, [...children.slice(0, 2), block(seeded, 'New.\n'), ...children.slice(3)]),
    );
    expect(after.source).toBe('Above.\n\n\nNew.\n\nBelow.\n');
    expectTableHolds(after);
  });

  it('writes the trailing blank Enter creates, and reclaims its line on materialisation', () => {
    const seeded = pressEnter(buildProjection('Hello.\n', md), 1);
    expect(seeded.source).toBe('Hello.\n\n');
    expectTableHolds(seeded);

    const typed = advance(seeded, docOf(seeded, [seeded.doc.child(0), block(seeded, 'Tail.\n')]));
    expect(typed.source).toBe('Hello.\n\nTail.\n');
    expectTableHolds(typed);
  });

  it('turns the written trailing blank into an interior run when a block lands after it', () => {
    const seeded = pressEnter(buildProjection('Hello.\n', md), 1);
    const after = advance(seeded, docOf(seeded, [...kids(seeded.doc), block(seeded, 'Tail.\n')]));
    expect(after.source).toBe('Hello.\n\n\nTail.\n');
    expectTableHolds(after);
  });

  it('places the block from the run it can see when the table holds the blanks at one offset', () => {
    const seeded = buildProjection('hello\n', md);
    const held = alignProjectionToDoc(
      seeded,
      docOf(seeded, [...kids(seeded.doc), blank(seeded), blank(seeded), blank(seeded)]),
    );
    expect(held.map.blocks).toHaveLength(4);
    expect(held.map.blocks.slice(1).every((b) => b.sourceStart === b.sourceEnd)).toBe(true);

    const after = advance(
      held,
      docOf(held, [...kids(held.doc).slice(0, 3), block(held, '# Head\n')]),
    );
    expect(after.source).toBe('hello\n\n\n\n# Head\n');
    expectTableHolds(after);
  });

  it('writes a leading blank run', () => {
    const seeded = buildProjection('Above.\n\nBelow.\n', md);
    const after = advance(
      seeded,
      docOf(seeded, [blank(seeded), blank(seeded), ...kids(seeded.doc)]),
    );
    expect(after.source).toBe('\n\nAbove.\n\nBelow.\n');
    expectTableHolds(after);
  });

  it('holds a single leading blank, which no source can spell, without losing the table', () => {
    const seeded = buildProjection('Above.\n\nBelow.\n', md);
    const after = advance(seeded, docOf(seeded, [blank(seeded), ...kids(seeded.doc)]));
    expect(after.source).toBe('Above.\n\nBelow.\n');
    expect(after.map.blocks).toHaveLength(after.doc.childCount);

    const typed = advance(
      after,
      docOf(after, [...kids(after.doc).slice(0, 2), block(after, 'Edited.\n')]),
    );
    expect(typed.source).toBe('Above.\n\nEdited.\n');
    expect(typed.map.blocks).toHaveLength(typed.doc.childCount);
  });

  it('keeps every keystroke of Return-go-Return-go in an empty document', () => {
    let p = buildProjection('', md);
    const at = (doc: PmNode, pos: number) => {
      const state = EditorState.create({ doc });
      const tr = state.tr.setSelection(TextSelection.near(doc.resolve(pos)));
      return state.apply(tr.split(tr.selection.from)).doc;
    };
    const typeInto = (doc: PmNode, ch: string) =>
      EditorState.create({ doc }).apply(
        EditorState.create({ doc }).tr.insertText(ch, doc.content.size - 1),
      ).doc;

    p = advance(p, at(p.doc, 1));
    for (const ch of 'go') p = advance(p, typeInto(p.doc, ch));
    p = advance(p, at(p.doc, p.doc.content.size - 1));
    for (const ch of 'go') p = advance(p, typeInto(p.doc, ch));

    expect(p.source).toBe('go\n\ngo\n');
    expect(p.doc.child(1).textContent).toBe('go');
    expect(p.doc.child(2).textContent).toBe('go');
    expect(p.map.blocks).toHaveLength(p.doc.childCount);
  });

  it('leaves an insertion with no blank run in play on its old anchor', () => {
    const seeded = buildProjection('Above.\n\nBelow.\n', md);
    const children = kids(seeded.doc);
    const after = advance(
      seeded,
      docOf(seeded, [children[0], block(seeded, 'Mid.\n'), children[1]]),
    );
    expect(after.source).toBe('Above.\n\nMid.\n\nBelow.\n');
    expectTableHolds(after);
  });
});

describe('a refused splice names its reason', () => {
  function recorder() {
    const seen: { reason: string; detail: Record<string, number> }[] = [];
    return {
      seen,
      onDecline: (reason: string, detail?: Readonly<Record<string, number>>) => {
        seen.push({ reason, detail: { ...detail } });
      },
    };
  }

  function kids(doc: Projection['doc']) {
    const out = [];
    for (let i = 0; i < doc.childCount; i++) out.push(doc.child(i));
    return out;
  }

  function docOf(projection: Projection, children: unknown[]) {
    return projection.doc.type.schema.topNodeType.create(projection.doc.attrs, children as never);
  }

  function block(projection: Projection, markdown: string) {
    return projection.doc.type.schema.nodeFromJSON(md.parse(markdown)).child(0);
  }

  function outgrownTable(): { stale: Projection; reason: string; detail: Record<string, number> } {
    const seeded = buildProjection('- one\n\n- two\n', md);
    expect(seeded.doc.childCount).toBe(1);
    const twoLists = docOf(seeded, [seeded.doc.child(0), seeded.doc.child(0)]);
    const { seen, onDecline } = recorder();
    const stale = alignProjectionToDoc(seeded, twoLists, onDecline);
    expect(stale.map.blocks).toHaveLength(1);
    expect(stale.doc.childCount).toBe(2);
    return { stale, reason: seen[0].reason, detail: seen[0].detail };
  }

  it('says so when the block table has been outgrown by the doc', () => {
    const { reason, detail } = outgrownTable();
    expect(reason).toBe('unaccounted-doc-block');
    expect(detail).toEqual({ index: 1, blocks: 1, children: 2 });
  });

  it('says so when the block table is longer than the doc', () => {
    const seeded = buildProjection(DOC, md);
    const { seen, onDecline } = recorder();
    alignProjectionToDoc(seeded, docOf(seeded, kids(seeded.doc).slice(0, 2)), onDecline);
    expect(seen).toEqual([
      { reason: 'table-longer-than-doc', detail: { blocks: seeded.doc.childCount, children: 2 } },
    ]);
  });

  it('names the bounds guard that discards a keystroke', () => {
    const { stale } = outgrownTable();
    const after = docOf(stale, [stale.doc.child(0), block(stale, 'Edited.\n')]);
    const changed = changedProjectionBlocks(stale.doc, after);
    expect(changed).toEqual({ before: { from: 1, to: 2 }, after: { from: 1, to: 2 } });

    const { seen, onDecline } = recorder();
    expect(computeBlockSplice(stale, after, md, changed, onDecline)).toBeNull();
    expect(seen).toEqual([
      {
        reason: 'block-range-out-of-bounds',
        detail: { beforeFrom: 1, beforeTo: 2, blocks: 1, children: 2 },
      },
    ]);
  });

  it('names an unchanged document rather than refusing silently', () => {
    const seeded = buildProjection(DOC, md);
    const { seen, onDecline } = recorder();
    expect(computeBlockSplice(seeded, seeded.doc, md, undefined, onDecline)).toBeNull();
    expect(seen).toEqual([
      { reason: 'no-changed-blocks', detail: { children: seeded.doc.childCount } },
    ]);
  });

  it('names the block-table invariant the STOP marker guards', () => {
    const { stale } = outgrownTable();
    const after = docOf(stale, [block(stale, 'Edited.\n'), stale.doc.child(1)]);
    const changed = changedProjectionBlocks(stale.doc, after);
    const splice = computeBlockSplice(stale, after, md, changed);
    expect(splice).not.toBeNull();

    const { seen, onDecline } = recorder();
    expect(rebaseProjection(stale, after, changed as never, splice as never, onDecline)).toBeNull();
    expect(seen).toEqual([{ reason: 'block-table-desynced', detail: { blocks: 1, children: 2 } }]);
  });

  it('names a rebase that spans more than one block', () => {
    const seeded = buildProjection(DOC, md);
    const after = docOf(seeded, [
      block(seeded, '# Changed\n'),
      block(seeded, 'Also changed.\n'),
      ...kids(seeded.doc).slice(2),
    ]);
    const changed = changedProjectionBlocks(seeded.doc, after);
    expect(changed).toEqual({ before: { from: 0, to: 2 }, after: { from: 0, to: 2 } });
    const splice = computeBlockSplice(seeded, after, md, changed);

    const { seen, onDecline } = recorder();
    expect(
      rebaseProjection(seeded, after, changed as never, splice as never, onDecline),
    ).toBeNull();
    expect(seen).toEqual([{ reason: 'multi-block-change', detail: { afterFrom: 0, afterTo: 2 } }]);
  });

  it('names a write that is nothing but newlines', () => {
    const seeded = buildProjection('a\n\nb\n', md);
    const after = docOf(seeded, [
      seeded.doc.child(0),
      seeded.doc.type.schema.node('paragraph'),
      seeded.doc.child(1),
    ]);
    const changed = changedProjectionBlocks(seeded.doc, after);
    const splice = computeBlockSplice(seeded, after, md, changed);
    expect(splice?.text).toBe('\n\n\n');

    const { seen, onDecline } = recorder();
    expect(
      rebaseProjection(seeded, after, changed as never, splice as never, onDecline),
    ).toBeNull();
    expect(seen).toEqual([{ reason: 'all-newline-write', detail: { textLength: 3 } }]);
  });

  it('stays quiet when nothing is refused', () => {
    const seeded = buildProjection(DOC, md);
    const after = docOf(seeded, [block(seeded, '# Edited\n'), ...kids(seeded.doc).slice(1)]);
    const changed = changedProjectionBlocks(seeded.doc, after);
    const { seen, onDecline } = recorder();
    const splice = computeBlockSplice(seeded, after, md, changed, onDecline);
    expect(splice).not.toBeNull();
    const rebased = rebaseProjection(seeded, after, changed as never, splice as never, onDecline);
    expect(rebased).not.toBeNull();
    alignProjectionToDoc(rebased as never, after, onDecline);
    expect(seen).toEqual([]);
  });
});
