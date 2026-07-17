import { describe, expect, test } from 'bun:test';
import {
  buildCorpus,
  buildDocSpec,
  formatDocName,
  makePrng,
  pickContentBytes,
  pickFrontmatterDensity,
  pickImageCount,
  sampleIntInRange,
} from './generator.ts';
import type { SizeMix } from './types.ts';
import { SIZE_ENVELOPES, totalDocsInMix } from './types.ts';

describe('makePrng', () => {
  test('same seed produces same sequence', () => {
    const a = makePrng(42);
    const b = makePrng(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  test('different seeds diverge after the first draw', () => {
    const a = makePrng(42);
    const b = makePrng(43);
    let same = 0;
    let total = 0;
    for (let i = 0; i < 50; i++) {
      if (a() === b()) same++;
      total++;
    }
    expect(same).toBeLessThan(total / 10);
  });

  test('output stays in unit interval', () => {
    const rng = makePrng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('sampleIntInRange', () => {
  test('produces integers within [lo, hi)', () => {
    const rng = makePrng(11);
    for (let i = 0; i < 500; i++) {
      const v = sampleIntInRange(rng, 5, 15);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(15);
    }
  });

  test('throws when lo >= hi (rather than saturating silently)', () => {
    const rng = makePrng(11);
    expect(() => sampleIntInRange(rng, 5, 5)).toThrow();
    expect(() => sampleIntInRange(rng, 10, 5)).toThrow();
  });
});

describe('pickContentBytes', () => {
  test('respects envelope range for each size class', () => {
    const rng = makePrng(13);
    for (let i = 0; i < 200; i++) {
      const small = pickContentBytes(rng, 'small');
      expect(small).toBeGreaterThanOrEqual(SIZE_ENVELOPES.small.minBytes);
      expect(small).toBeLessThanOrEqual(SIZE_ENVELOPES.small.maxBytes);
      const medium = pickContentBytes(rng, 'medium');
      expect(medium).toBeGreaterThanOrEqual(SIZE_ENVELOPES.medium.minBytes);
      expect(medium).toBeLessThanOrEqual(SIZE_ENVELOPES.medium.maxBytes);
      const large = pickContentBytes(rng, 'large');
      expect(large).toBeGreaterThanOrEqual(SIZE_ENVELOPES.large.minBytes);
      expect(large).toBeLessThanOrEqual(SIZE_ENVELOPES.large.maxBytes);
    }
  });

  test('large envelope reaches the LARGE_DOC_CHAR_THRESHOLD anchor', () => {
    expect(SIZE_ENVELOPES.large.maxBytes).toBe(500_000);
  });
});

describe('pickFrontmatterDensity + pickImageCount', () => {
  test('frontmatter density is one of {none, minimal, heavy}', () => {
    const rng = makePrng(17);
    for (let i = 0; i < 100; i++) {
      const d = pickFrontmatterDensity(rng, 'large');
      expect(['none', 'minimal', 'heavy']).toContain(d);
    }
  });

  test('image count is non-negative and bounded by size class', () => {
    const rng = makePrng(19);
    for (let i = 0; i < 100; i++) {
      expect(pickImageCount(rng, 'small')).toBeGreaterThanOrEqual(0);
      expect(pickImageCount(rng, 'small')).toBeLessThanOrEqual(1);
      expect(pickImageCount(rng, 'medium')).toBeLessThanOrEqual(3);
      expect(pickImageCount(rng, 'large')).toBeLessThanOrEqual(5);
    }
  });
});

describe('formatDocName', () => {
  test('zero-pads to 3 digits for stable lexical sort', () => {
    expect(formatDocName('vault', 1)).toBe('vault-001');
    expect(formatDocName('vault', 42)).toBe('vault-042');
    expect(formatDocName('broad', 100)).toBe('broad-100');
  });
});

describe('buildDocSpec', () => {
  test('produces DocSpec with declared name + sizeClass', () => {
    const rng = makePrng(23);
    const spec = buildDocSpec({ rng, namePrefix: 'tight', index: 5, sizeClass: 'medium' });
    expect(spec.name).toBe('tight-005');
    expect(spec.sizeClass).toBe('medium');
    expect(spec.contentBytes).toBeGreaterThanOrEqual(SIZE_ENVELOPES.medium.minBytes);
    expect(spec.imageCount).toBeGreaterThanOrEqual(0);
  });

  test('consumes PRNG in fixed order across runs', () => {
    const specA = buildDocSpec({
      rng: makePrng(99),
      namePrefix: 'x',
      index: 1,
      sizeClass: 'small',
    });
    const specB = buildDocSpec({
      rng: makePrng(99),
      namePrefix: 'x',
      index: 1,
      sizeClass: 'small',
    });
    expect(specA).toEqual(specB);
  });
});

describe('buildCorpus', () => {
  const mix: SizeMix = { small: 2, medium: 3, large: 1 };

  test('emits docs in small → medium → large order with stable ordinals', () => {
    const docs = buildCorpus({ seed: 1, namePrefix: 'corpus', mix });
    expect(docs.length).toBe(totalDocsInMix(mix));
    expect(docs.slice(0, 2).every((d) => d.sizeClass === 'small')).toBe(true);
    expect(docs.slice(2, 5).every((d) => d.sizeClass === 'medium')).toBe(true);
    expect(docs.slice(5, 6).every((d) => d.sizeClass === 'large')).toBe(true);
    expect(docs.map((d) => d.name)).toEqual([
      'corpus-001',
      'corpus-002',
      'corpus-003',
      'corpus-004',
      'corpus-005',
      'corpus-006',
    ]);
  });

  test('same seed produces deeply equal corpora', () => {
    const a = buildCorpus({ seed: 7, namePrefix: 'c', mix });
    const b = buildCorpus({ seed: 7, namePrefix: 'c', mix });
    expect(a).toEqual(b);
  });

  test('different seeds produce different corpora', () => {
    const a = buildCorpus({ seed: 1, namePrefix: 'c', mix });
    const b = buildCorpus({ seed: 2, namePrefix: 'c', mix });
    expect(a).not.toEqual(b);
  });

  test('handles a zero-medium mix (asymmetric shape)', () => {
    const docs = buildCorpus({
      seed: 11,
      namePrefix: 'asy',
      mix: { small: 5, medium: 0, large: 1 },
    });
    expect(docs.length).toBe(6);
    expect(docs.filter((d) => d.sizeClass === 'medium')).toHaveLength(0);
    expect(docs.filter((d) => d.sizeClass === 'small')).toHaveLength(5);
    expect(docs.filter((d) => d.sizeClass === 'large')).toHaveLength(1);
  });
});
