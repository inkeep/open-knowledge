import { describe, expect, test } from 'bun:test';
import { type EvalSet, loadEvalSet } from './semantic-eval.ts';

/**
 * Structural validation of the eval set (CI-safe — no model). Enforces the
 * anti-circularity properties the design challenge requires, so the
 * gated real-model eval can't silently pass on a degenerate set.
 */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'how',
  'get',
  'out',
  'can',
  'use',
]);

describe('FR2 eval set structure', () => {
  const set: EvalSet = loadEvalSet();
  const byPath = new Map(set.corpus.map((d) => [d.path, d]));

  test('every pair targets a real corpus doc', () => {
    for (const p of set.pairs) {
      expect(byPath.has(p.target), `unknown target ${p.target}`).toBe(true);
    }
  });

  test('both splits are non-trivial', () => {
    const tune = set.pairs.filter((p) => p.split === 'tune');
    const held = set.pairs.filter((p) => p.split === 'held');
    expect(tune.length).toBeGreaterThanOrEqual(8);
    expect(held.length).toBeGreaterThanOrEqual(8);
  });

  test('held-out includes zero-overlap, long-doc, and lexical-strong categories', () => {
    const heldCats = new Set(set.pairs.filter((p) => p.split === 'held').map((p) => p.category));
    for (const cat of ['zero-overlap', 'long-doc', 'lexical-strong'] as const) {
      expect(heldCats.has(cat), `held-out missing category ${cat}`).toBe(true);
    }
  });

  test('zero-overlap pairs genuinely share ~no content tokens with their target (C2b)', () => {
    const zero = set.pairs.filter((p) => p.category === 'zero-overlap');
    expect(zero.length).toBeGreaterThanOrEqual(3);
    for (const p of zero) {
      const doc = byPath.get(p.target);
      const qt = [...tokens(p.query)].filter((t) => !STOP.has(t));
      const dt = tokens(`${doc?.title} ${doc?.path} ${doc?.content}`);
      const shared = qt.filter((t) => dt.has(t));
      // "≈zero shared tokens" — at most one incidental overlap allowed.
      expect(
        shared.length,
        `zero-overlap "${p.query}" shares ${JSON.stringify(shared)} with ${p.target}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('long-doc pairs target a genuinely long document (C3)', () => {
    const long = set.pairs.filter((p) => p.category === 'long-doc');
    expect(long.length).toBeGreaterThanOrEqual(1);
    for (const p of long) {
      expect(byPath.get(p.target)?.content.length ?? 0).toBeGreaterThan(900);
    }
  });

  test('corpus paths are unique', () => {
    expect(new Set(set.corpus.map((d) => d.path)).size).toBe(set.corpus.length);
  });
});
