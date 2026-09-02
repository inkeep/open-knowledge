import {
  MarkdownManager,
  MIN_CARRIED_TRAILING_EMPTIES,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { commonmark } from 'commonmark.json';
import * as fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import { comparableChildCount, computeSourceBlocks } from './block-spans.ts';
import {
  type BlockAnchor,
  type CaptureOptions,
  CONFIDENCE_ORDER,
  createApproxResolver,
  type DocSnapshot,
  type ResolvedPosition,
} from './mode-switch-position-resolver.ts';
import { blockRangeToPositions } from './plugins/agent-insert-flash.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);
const resolver = createApproxResolver(md);

function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value, got null/undefined');
  return value;
}

function snap(markdown: string): DocSnapshot {
  const { body } = stripFrontmatter(markdown);
  const doc = schema.nodeFromJSON(md.parse(body));
  return { source: markdown, doc };
}

function pmPosOfBlock(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + 1;
}

describe('invalid-MDX resilience', () => {
  const invalid = 'Intro paragraph.\n\n<Foo>hi</Bar>\n\nMismatched JSX tag above.';

  test('computeSourceBlocks returns no blocks instead of throwing', () => {
    expect(() => computeSourceBlocks(invalid, md)).not.toThrow();
    expect(computeSourceBlocks(invalid, md).blocks).toHaveLength(0);
  });

  test('the degradation leaves a mark, so a parse regression is not silent', () => {
    const marks = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark);
    try {
      computeSourceBlocks(invalid, md);
      expect(marks).toHaveBeenCalledWith('ok/block-spans/parse-failed');

      marks.mockClear();
      computeSourceBlocks('# valid\n\nbody', md);
      expect(marks).not.toHaveBeenCalled();
    } finally {
      marks.mockRestore();
    }
  });

  test('captureFromSource degrades to null (no anchor) on invalid MDX', () => {
    expect(() => resolver.captureFromSource(invalid, 0)).not.toThrow();
    expect(resolver.captureFromSource(invalid, 0)).toBeNull();
  });

  test('resolveInSource and resolveInWysiwyg do not throw on invalid source', () => {
    const anchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: 'Intro paragraph.' };
    const { doc } = snap('Intro paragraph.\n\nSecond.');
    expect(() => resolver.resolveInSource(anchor, { source: invalid, doc })).not.toThrow();
    expect(() => resolver.resolveInWysiwyg(anchor, { source: invalid, doc })).not.toThrow();
  });
});

describe('BlockAnchor capture', () => {
  test('captures block index, kind, and content from WYSIWYG', () => {
    const { doc } = snap('# Title\n\nA paragraph.');
    const anchor = resolver.captureFromWysiwyg(doc, pmPosOfBlock(doc, 1));
    expect(anchor).toMatchObject({ blockIndex: 1, kind: 'paragraph', content: 'A paragraph.' });
  });

  test('captures block index, kind, and content from source', () => {
    const source = '# Title\n\nA paragraph.';
    const anchor = resolver.captureFromSource(source, source.indexOf('paragraph'));
    expect(anchor).toMatchObject({ blockIndex: 1, kind: 'paragraph', content: 'A paragraph.' });
  });

  test('normalizes a bullet list to the shared list kind across representations', () => {
    const source = '- one\n- two';
    const { doc } = snap(source);
    const wanchor = resolver.captureFromWysiwyg(doc, pmPosOfBlock(doc, 0));
    const sanchor = resolver.captureFromSource(source, 0);
    expect(wanchor?.kind).toBe('list');
    expect(sanchor?.kind).toBe('list');
  });
});

describe('confidence grades', () => {
  test('grades run exact to clamped, most to least precise', () => {
    expect(CONFIDENCE_ORDER).toEqual(['exact', 'same-type-ordinal', 'ordinal', 'clamped']);
  });

  test('an in-range aligned anchor whose content matches resolves exact', () => {
    const source = '# A\n\nbody\n\n## B';
    const { doc } = snap(source);
    const anchor = present(resolver.captureFromSource(source, source.indexOf('body')));
    expect(resolver.resolveInSource(anchor, { source, doc })?.confidence).toBe('exact');
  });

  test('same ordinal, same kind, different content resolves same-type-ordinal', () => {
    const source = '# A\n\nthe source paragraph';
    const { doc } = snap(source);
    const anchor: BlockAnchor = {
      blockIndex: 1,
      kind: 'paragraph',
      content: 'a different paragraph',
    };
    expect(resolver.resolveInSource(anchor, { source, doc })?.confidence).toBe('same-type-ordinal');
  });

  test('same ordinal, different kind resolves ordinal', () => {
    const source = '# A\n\nparagraph';
    const { doc } = snap(source);
    const anchor: BlockAnchor = { blockIndex: 0, kind: 'list', content: 'a stale list item' };
    expect(resolver.resolveInSource(anchor, { source, doc })?.confidence).toBe('ordinal');
  });

  test('an out-of-range ordinal clamps to the nearest block', () => {
    const source = '# A\n\nonly two blocks';
    const { doc } = snap(source);
    const anchor: BlockAnchor = { blockIndex: 9, kind: 'paragraph', content: 'gone' };
    const resolved = present(resolver.resolveInSource(anchor, { source, doc }));
    expect(resolved.confidence).toBe('clamped');
    expect(resolved.blockStart).toBeLessThanOrEqual(source.length);
    expect(resolved.blockStart).toBe(source.indexOf('only two blocks'));
  });
});

describe('count tripwire', () => {
  test('a ProseMirror/mdast block-count mismatch degrades the grade and never reports exact', () => {
    const source = 'para zero\n\npara one\n\npara two';
    const { doc } = snap('para zero\n\npara one');
    const anchor = present(resolver.captureFromSource(source, source.indexOf('para one')));
    expect(anchor.content).toBe('para one');
    expect(resolver.resolveInSource(anchor, { source, doc })?.confidence).toBe('ordinal');
  });

  test('the tripwire counts a trailing empty paragraph, because the source spells it', () => {
    const source = '# A\n\nbody\n\n## Tail\n\n';
    const doc = snap(source).doc;
    const mdastCount = computeSourceBlocks(source, md).blocks.length;

    expect(doc.child(doc.childCount - 1).type.name).toBe('paragraph');
    expect(doc.child(doc.childCount - 1).content.size).toBe(0);
    expect(comparableChildCount(doc)).toBe(mdastCount);
    expect(comparableChildCount(doc)).toBe(doc.childCount);

    const anchor = present(resolver.captureFromWysiwyg(doc, pmPosOfBlock(doc, 0)));
    expect(resolver.resolveInSource(anchor, { source, doc })?.confidence).toBe('exact');
  });

  test('a source-carried trailing blank run stays in the comparable count at every length', () => {
    expect(MIN_CARRIED_TRAILING_EMPTIES).toBe(1);
    for (const [carried, expected] of [
      ['# A\n\nbody\n\n', 3],
      ['# A\n\nbody\n\n\n', 4],
    ] as const) {
      const doc = snap(carried).doc;
      const blocks = computeSourceBlocks(carried, md).blocks;
      expect(blocks.length).toBe(expected);
      expect(comparableChildCount(doc)).toBe(blocks.length);
      expect(comparableChildCount(doc)).toBe(doc.childCount);
    }
  });

  test('an all-empty doc is the schema minimum, the one paragraph no source spells', () => {
    for (const source of ['', '\n', '\n\n\n']) {
      const doc = snap(source).doc;
      expect(doc.childCount).toBe(1);
      expect(computeSourceBlocks(source, md).blocks.length).toBe(0);
      expect(comparableChildCount(doc)).toBe(0);
    }
  });

  test('a leading blank run is never subtracted, at or below the floor', () => {
    for (const source of ['\n\n# A\n\nbody\n', '\n\n\n# A\n\nbody\n']) {
      const doc = snap(source).doc;
      expect(comparableChildCount(doc)).toBe(computeSourceBlocks(source, md).blocks.length);
      expect(comparableChildCount(doc)).toBe(doc.childCount);
    }
  });
});

describe('content-equality gating', () => {
  test('a content match refines the landing inline at exact confidence', () => {
    const source = '# A\n\nthe target paragraph';
    const { doc } = snap(source);
    const jumpOpts: CaptureOptions = { refine: true };
    const anchor = present(resolver.captureFromSource(source, source.indexOf('target'), jumpOpts));
    const resolved: ResolvedPosition = present(resolver.resolveInSource(anchor, { source, doc }));
    expect(resolved.confidence).toBe('exact');
    expect(resolved.point).toBeGreaterThan(resolved.blockStart);
    expect(resolved.point).toBe(source.indexOf('target'));
  });

  test('a content mismatch lands at block start rather than an inline position', () => {
    const source = '# A\n\nthe source paragraph';
    const { doc } = snap(source);
    const anchor: BlockAnchor = {
      blockIndex: 1,
      kind: 'paragraph',
      content: 'a stale captured paragraph',
      selectionInBlock: 8,
    };
    const resolved = present(resolver.resolveInSource(anchor, { source, doc }));
    expect(resolved.confidence).not.toBe('exact');
    expect(resolved.point).toBe(resolved.blockStart);
  });
});

describe('offset normalization', () => {
  test('source offsets crossing the boundary include the frontmatter region', () => {
    const source = '---\ntitle: Doc\n---\n\n# Heading\n\nBody paragraph\n';
    const { doc } = snap(source);
    const anchor = present(resolver.captureFromSource(source, source.indexOf('Body paragraph')));
    const resolved = present(resolver.resolveInSource(anchor, { source, doc }));
    expect(resolved.blockStart).toBe(source.indexOf('Body paragraph'));
    expect(resolved.blockStart).toBeGreaterThan(source.indexOf('---'));
  });

  test('an offset inside the frontmatter maps to the top of the body', () => {
    const source = '---\ntitle: Doc\n---\n\n# Heading\n\nBody\n';
    const anchor = resolver.captureFromSource(source, source.indexOf('title'));
    expect(anchor?.blockIndex).toBe(0);
  });

  test('a WYSIWYG landing returns ProseMirror positions', () => {
    const source = '# Heading\n\nBody paragraph';
    const { doc } = snap(source);
    const anchor = present(resolver.captureFromSource(source, source.indexOf('Body')));
    const resolved = present(resolver.resolveInWysiwyg(anchor, { source, doc }));
    const expected = present(blockRangeToPositions(doc, 1, 2));
    expect(resolved.blockStart).toBe(expected.from);
  });
});

describe('no-anchor and purity', () => {
  test('capturing from an empty source yields no anchor', () => {
    expect(resolver.captureFromSource('', 0)).toBeNull();
  });

  test('resolving into a body-empty document yields no anchor', () => {
    const { doc } = snap('');
    const anchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: 'x' };
    expect(resolver.resolveInWysiwyg(anchor, { source: '', doc })).toBeNull();
  });

  test('resolving does not mutate the document snapshot', () => {
    const source = '# A\n\nbody';
    const { doc } = snap(source);
    const before = { count: doc.childCount, text: doc.textContent, size: doc.content.size };
    const anchor = present(resolver.captureFromWysiwyg(doc, pmPosOfBlock(doc, 1)));
    resolver.resolveInSource(anchor, { source, doc });
    resolver.resolveInWysiwyg(anchor, { source, doc });
    expect({ count: doc.childCount, text: doc.textContent, size: doc.content.size }).toEqual(
      before,
    );
  });
});

describe('per-source parse reuse', () => {
  function countingResolver() {
    let parses = 0;
    const counting = Object.create(md) as MarkdownManager;
    counting.parseToEditorMdast = (input: string) => {
      parses += 1;
      return md.parseToEditorMdast(input);
    };
    return { resolver: createApproxResolver(counting), parses: () => parses };
  }

  test('one mode switch over one source parses it once', () => {
    const source = '# A\n\nfirst\n\n## B\n\nsecond';
    const { doc } = snap(source);
    const counted = countingResolver();

    const anchor = present(counted.resolver.captureFromSource(source, 0));
    counted.resolver.resolveInSource(anchor, { source, doc });
    const reAnchored = present(counted.resolver.captureFromSource(source, 0));
    counted.resolver.resolveInWysiwyg(reAnchored, { source, doc });

    expect(counted.parses()).toBe(1);
  });

  test('a changed source is re-parsed, never served from the previous one', () => {
    const before = '# A\n\nfirst';
    const after = '# A\n\nfirst\n\n## B\n\nsecond';
    const counted = countingResolver();

    counted.resolver.captureFromSource(before, 0);
    expect(counted.parses()).toBe(1);

    const anchor = present(counted.resolver.captureFromSource(after, after.indexOf('second')));
    expect(anchor.content).toBe('second');
    expect(counted.parses()).toBe(2);

    counted.resolver.captureFromSource(before, 0);
    expect(counted.parses()).toBe(3);
  });
});

describe('cross-mode consistency', () => {
  const docs = [
    '# A\n\nfirst\n\n## B\n\nsecond',
    '- one\n- two\n\nafter list',
    'intro\n\n```js\ncode()\n```\n\noutro',
  ];

  test.each(docs)('every block round-trips WYSIWYG to source and back (%#)', (source) => {
    const { doc } = snap(source);
    const blockCount = computeSourceBlocks(source, md).blocks.length;
    for (let b = 0; b < blockCount; b++) {
      const fromWysiwyg = present(resolver.captureFromWysiwyg(doc, pmPosOfBlock(doc, b)));
      const inSource = present(resolver.resolveInSource(fromWysiwyg, { source, doc }));
      expect(inSource.confidence).toBe('exact');
      expect(resolver.captureFromSource(source, inSource.blockStart)?.blockIndex).toBe(b);

      const fromSource = present(resolver.captureFromSource(source, inSource.blockStart));
      const inWysiwyg = present(resolver.resolveInWysiwyg(fromSource, { source, doc }));
      expect(inWysiwyg.confidence).toBe('exact');
      expect(resolver.captureFromWysiwyg(doc, inWysiwyg.point + 1)?.blockIndex).toBe(b);
    }
  });
});

function alignedCorpus(): string[] {
  const examples: string[] = [];
  for (const ex of commonmark) {
    try {
      const { blocks } = computeSourceBlocks(ex.markdown, md);
      if (blocks.length === 0) continue;
      if (comparableChildCount(snap(ex.markdown).doc) === blocks.length) examples.push(ex.markdown);
    } catch {}
  }
  return examples;
}

describe('fidelity corpus', () => {
  test('resolving a derived source anchor returns its originating block', () => {
    const examples = alignedCorpus();
    expect(examples.length).toBeGreaterThan(50);
    fc.assert(
      fc.property(fc.constantFrom(...examples), fc.nat(), (markdown, n) => {
        const { doc } = snap(markdown);
        const offset = n % (markdown.length + 1);
        const derived = resolver.captureFromSource(markdown, offset);
        if (derived === null) return true;
        const resolved = resolver.resolveInSource(derived, { source: markdown, doc });
        if (resolved === null) return false;
        const reCaptured = resolver.captureFromSource(markdown, resolved.blockStart);
        return (
          reCaptured !== null &&
          reCaptured.blockIndex === derived.blockIndex &&
          resolved.confidence === 'exact'
        );
      }),
      { numRuns: 300, seed: 4242 },
    );
  });

  test('parse-time block counts align across the whole corpus', () => {
    let aligned = 0;
    const breakers: string[] = [];
    for (const ex of commonmark) {
      let pm: number;
      let mdast: number;
      try {
        pm = comparableChildCount(snap(ex.markdown).doc);
        mdast = computeSourceBlocks(ex.markdown, md).blocks.length;
      } catch {
        continue;
      }
      if (pm === mdast) aligned++;
      else breakers.push(`${ex.section}: pm=${pm} mdast=${mdast}`);
    }
    expect(aligned).toBeGreaterThan(200);
    expect(breakers).toEqual([]);
  });

  const alignedConstructs = [
    { name: 'headings and paragraphs', src: '# A\n\npara\n\n## B\n\nmore' },
    { name: 'bullet list', src: '- one\n- two\n- three' },
    { name: 'ordered list', src: '1. one\n2. two' },
    { name: 'fenced code', src: '```js\ncode\n```' },
    { name: 'blockquote', src: '> quote' },
    { name: 'thematic break', src: 'a\n\n---\n\nb' },
  ];

  test.each(alignedConstructs)('block counts align for $name', ({ src }) => {
    expect(comparableChildCount(snap(src).doc)).toBe(computeSourceBlocks(src, md).blocks.length);
  });
});
