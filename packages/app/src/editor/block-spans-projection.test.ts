import { buildProjection, MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { loadLargeRealistic } from '../../../core/src/markdown/fixtures/index.ts';
import { computeSourceBlockSpans, projectionBlockSpans } from './block-spans';

const lintMd = new MarkdownManager({ extensions: sharedExtensions });
const projectionMd = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

const HAZARDS = [
  '---',
  'title: Doc',
  '---',
  '',
  '# Heading',
  '',
  'A paragraph with [**Desktop**](x), `code` and a [[Wiki Link]].',
  'A lazy continuation line.',
  '',
  'Setext heading',
  '--------------',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '> quoted',
  '',
  '```ts',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
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
  '',
  '',
  'After a blank run.',
  '',
  '---',
  '',
  'Trailing paragraph.',
  '',
].join('\n');

const INSERTS = ['x', '\n', '\n\n', '- ', '# ', '```', '> ', '|', '---', '<Callout>', '$$'];

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function expectParity(source: string, label: string): boolean {
  const got = projectionBlockSpans(buildProjection(source, projectionMd));
  if (got === null) return false;
  expect(got, label).toEqual(computeSourceBlockSpans(source, lintMd));
  return true;
}

describe('projectionBlockSpans — the projection names the blocks a parse does', () => {
  it('agrees with computeSourceBlockSpans on a hazard document', () => {
    expect(expectParity(HAZARDS, 'hazards')).toBe(true);
  });

  it('agrees with computeSourceBlockSpans on a large realistic document', () => {
    expect(expectParity(loadLargeRealistic(), 'large')).toBe(true);
  });

  it('agrees with computeSourceBlockSpans wherever it answers, across 300 random edits', () => {
    const random = prng(0xfeed);
    let answered = 0;
    for (let i = 0; i < 300; i++) {
      const at = Math.floor(random() * (HAZARDS.length + 1));
      const token = INSERTS[Math.floor(random() * INSERTS.length)] as string;
      const next =
        random() < 0.6
          ? HAZARDS.slice(0, at) + token + HAZARDS.slice(at)
          : HAZARDS.slice(0, at) + HAZARDS.slice(at + 1 + Math.floor(random() * 10));
      if (expectParity(next, `edit ${i}: ${JSON.stringify(next)}`)) answered++;
    }
    expect(answered).toBeGreaterThan(200);
  });

  it('declines a source whose strict parse fails, as the parse does', () => {
    const broken = HAZARDS.replace('A lazy continuation', 'A lazy <Callout>continuation');
    expect(projectionBlockSpans(buildProjection(broken, projectionMd))).toBeNull();
    expect(computeSourceBlockSpans(broken, lintMd).spans).toEqual([]);
  });
});
