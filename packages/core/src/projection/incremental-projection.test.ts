import { describe, expect, it } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { loadLargeRealistic } from '../markdown/fixtures/index.ts';
import { MarkdownManager } from '../markdown/index.ts';
import type { PmSourceSpan } from '../markdown/pm-source-map.ts';
import { buildProjection, type Projection } from './block-splice.ts';
import { reprojectChanged } from './incremental-projection.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });

const HAZARDS = [
  '# Heading',
  '',
  'A paragraph with [**Desktop**](x), `code`, *emphasis* and a [[Wiki Link]].',
  'A lazy continuation line.',
  '',
  'Setext heading',
  '--------------',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '- loose',
  '',
  '- list',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] task',
  '- [x] done',
  '',
  '> quoted',
  '> > nested quote',
  '',
  '```ts',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
  '',
  '    indented code',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '<Callout type="info">',
  '',
  'Inside a component.',
  '',
  '</Callout>',
  '',
  '<div>',
  'html block',
  '</div>',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '---',
  '',
  '',
  '',
  'After a blank run.  ',
  'Hard break above.',
  '',
  '***',
  '',
  'Trailing paragraph.',
  '',
].join('\n');

const WITH_FRONTMATTER = `---\ntitle: Doc\n---\n\n${HAZARDS}`;

const INSERTS = [
  'x',
  ' ',
  '\n',
  '\n\n',
  '- ',
  '# ',
  '```',
  '> ',
  '|',
  '---',
  '===',
  '*',
  '**',
  '`',
  '<Callout>',
  '</Callout>',
  '1. ',
  '    ',
  '$$',
  '<div>',
  '[',
  ']',
  '[[',
  '\\',
  '  \n',
] as const;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdit(source: string, random: () => number): string {
  const at = Math.floor(random() * (source.length + 1));
  const roll = random();
  if (roll < 0.55) {
    const token = INSERTS[Math.floor(random() * INSERTS.length)] as string;
    return source.slice(0, at) + token + source.slice(at);
  }
  if (roll < 0.9) {
    const length = 1 + Math.floor(random() * 12);
    return source.slice(0, at) + source.slice(at + length);
  }
  const length = 1 + Math.floor(random() * 6);
  const token = INSERTS[Math.floor(random() * INSERTS.length)] as string;
  return source.slice(0, at) + token + source.slice(at + length);
}

function plainSpans(spans: readonly PmSourceSpan[]) {
  return spans.map(({ from, to, sourceStart, sourceEnd, type, depth, mapped }) => ({
    from,
    to,
    sourceStart,
    sourceEnd,
    type,
    depth,
    mapped,
  }));
}

function fullOrNull(source: string): Projection | null {
  try {
    return buildProjection(source, md);
  } catch {
    return null;
  }
}

function expectMatchesFullParse(base: Projection, source: string, label: string): Projection {
  const update = reprojectChanged(base, source, md);
  const full = buildProjection(source, md);
  if (update === null) return full;
  const got = update.projection;
  expect(got.source, label).toBe(source);
  expect(got.bodyOffset, label).toBe(full.bodyOffset);
  expect(got.map.precision, label).toBe('full');
  expect(got.doc.toJSON(), label).toEqual(full.doc.toJSON());
  expect(got.doc.eq(full.doc), label).toBe(true);
  expect(plainSpans(got.map.spans), label).toEqual(plainSpans(full.map.spans));
  expect(got.map.sourceLength, label).toBe(full.map.sourceLength);
  expect(got.map.docSize, label).toBe(full.map.docSize);
  return got;
}

describe('reprojectChanged — a window reparse equals a full parse', () => {
  for (const [name, fixture] of [
    ['hazards', HAZARDS],
    ['frontmatter', WITH_FRONTMATTER],
  ] as const) {
    it(`agrees with buildProjection on 600 single random edits to ${name}`, () => {
      const random = prng(0xc0ffee);
      const base = buildProjection(fixture, md);
      for (let i = 0; i < 600; i++) {
        const next = randomEdit(fixture, random);
        if (fullOrNull(next) === null) continue;
        expectMatchesFullParse(base, next, `${name} edit ${i}: ${JSON.stringify(next)}`);
      }
    });

    it(`agrees with buildProjection across a chain of 400 edits to ${name}`, () => {
      const random = prng(0xbadf00d);
      let source: string = fixture;
      let base = buildProjection(source, md);
      for (let i = 0; i < 400; i++) {
        const next = randomEdit(source, random);
        if (fullOrNull(next) === null) continue;
        base = expectMatchesFullParse(base, next, `${name} chain ${i}: ${JSON.stringify(next)}`);
        source = next;
      }
    });
  }

  it('agrees with buildProjection on edits across a large realistic document', () => {
    const random = prng(0x5eed);
    const source = loadLargeRealistic();
    const base = buildProjection(source, md);
    for (let i = 0; i < 60; i++) {
      const next = randomEdit(source, random);
      if (fullOrNull(next) === null) continue;
      expectMatchesFullParse(base, next, `large edit ${i}`);
    }
  });
});

describe('reprojectChanged — it reparses a window, not the document', () => {
  it('handles typing inside a paragraph of a large document without a full parse', () => {
    const source = loadLargeRealistic();
    const base = buildProjection(source, md);
    const paragraphs = base.map.blocks.filter((span) => span.type === 'paragraph');
    let windowed = 0;
    for (let i = 0; i < 40; i++) {
      const span = paragraphs[Math.floor((i / 40) * paragraphs.length)] as PmSourceSpan;
      const at = base.bodyOffset + span.sourceEnd;
      const update = reprojectChanged(base, `${source.slice(0, at)}x${source.slice(at)}`, md);
      if (update === null) continue;
      windowed++;
      expect(update.after.to - update.after.from).toBeLessThanOrEqual(5);
    }
    expect(windowed).toBeGreaterThanOrEqual(36);
  });

  it('keeps every untouched block node by identity', () => {
    const base = buildProjection(HAZARDS, md);
    const at = HAZARDS.indexOf('Trailing paragraph.');
    const update = reprojectChanged(base, `${HAZARDS.slice(0, at)}More. ${HAZARDS.slice(at)}`, md);
    expect(update).not.toBeNull();
    if (update === null) return;
    for (let i = 0; i < update.before.from; i++) {
      expect(update.projection.doc.child(i)).toBe(base.doc.child(i));
    }
  });
});

describe('reprojectChanged — it declines what a window cannot prove', () => {
  it('declines a change to the frontmatter', () => {
    const base = buildProjection(WITH_FRONTMATTER, md);
    expect(reprojectChanged(base, WITH_FRONTMATTER.replace('Doc', 'Docs'), md)).toBeNull();
  });

  it('declines when a link reference definition exists or appears', () => {
    const base = buildProjection(HAZARDS, md);
    expect(reprojectChanged(base, `${HAZARDS}\n[x]: https://example.com\n`, md)).toBeNull();
    const withDefinition = buildProjection(`[x]: https://example.com\n\n${HAZARDS}`, md);
    const source = withDefinition.source.replace('Trailing', 'Trailing [x]');
    expect(reprojectChanged(withDefinition, source, md)).toBeNull();
  });

  it('declines a block-precision base', () => {
    const base = buildProjection(HAZARDS, md);
    const blockOnly = { ...base, map: { ...base.map, precision: 'block' as const } };
    expect(reprojectChanged(blockOnly, `${HAZARDS}x`, md)).toBeNull();
  });
});
