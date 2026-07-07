/**
 * Deterministic synthetic-corpus generator for the cache-regime fixtures.
 *
 * Same seed → byte-identical corpus across runs (verified by sha256 in
 * vault.test.ts). The generator is intentionally synthetic + parameterized
 * rather than scraping real OK content: OK is fully self-hostable
 * with no production-telemetry channel, so transferability of the verdict
 * rests on consistency across three engineered working-set shapes,
 * not on matching aggregated empirical traces.
 *
 * `calibrate.ts` is the local affordance for the engineer to check that
 * the engineered shapes plausibly mirror their own dogfood usage before
 * committing to a multi-hour campaign.
 */

import type { DocSpec, SizeMix } from './types';
import { SIZE_ENVELOPES, totalDocsInMix } from './types';

/**
 * `mulberry32` — a 32-bit PRNG with full 2^32 period. Tiny, deterministic,
 * uniform enough for picking byte counts within an envelope. Cited
 * everywhere from Stack Overflow to JSFiddle since 2017; the contract
 * here is determinism, not cryptographic randomness.
 */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Inclusive-low / exclusive-high integer sample from a unit-uniform `rng`.
 * Rejects `lo >= hi` rather than silently saturating — generator-misconfig
 * surfaces as a thrown error at corpus-build time, not as a malformed cell.
 */
export function sampleIntInRange(
  rng: () => number,
  loInclusive: number,
  hiExclusive: number,
): number {
  if (loInclusive >= hiExclusive) {
    throw new Error(
      `[cache-regime-rotation] sampleIntInRange requires loInclusive < hiExclusive (got ${loInclusive}, ${hiExclusive})`,
    );
  }
  const span = hiExclusive - loInclusive;
  return loInclusive + Math.floor(rng() * span);
}

/**
 * Pick a `contentBytes` value within the envelope for the given size class.
 *
 * Distribution is uniform within the envelope. The sweep harness does NOT
 * care about the precise distribution shape — only that cells span the
 * envelope so cache cost surfaces across the doc-size range. Uniform is
 * the simplest defensible choice and produces a corpus with visible spread.
 */
export function pickContentBytes(rng: () => number, sizeClass: DocSpec['sizeClass']): number {
  const env = SIZE_ENVELOPES[sizeClass];
  return sampleIntInRange(rng, env.minBytes, env.maxBytes + 1);
}

/**
 * Frontmatter density is correlated with doc size: small docs rarely
 * carry rich frontmatter; large PROJECT-class docs almost always do.
 * The probabilities are calibrated against staff-reviewed OK fixture
 * intuition — not a tunable axis, just a generator default.
 */
export function pickFrontmatterDensity(
  rng: () => number,
  sizeClass: DocSpec['sizeClass'],
): DocSpec['frontmatterDensity'] {
  const draw = rng();
  switch (sizeClass) {
    case 'small':
      // 70% none / 25% minimal / 5% heavy
      if (draw < 0.7) return 'none';
      if (draw < 0.95) return 'minimal';
      return 'heavy';
    case 'medium':
      // 20% none / 55% minimal / 25% heavy
      if (draw < 0.2) return 'none';
      if (draw < 0.75) return 'minimal';
      return 'heavy';
    case 'large':
      // 5% none / 35% minimal / 60% heavy
      if (draw < 0.05) return 'none';
      if (draw < 0.4) return 'minimal';
      return 'heavy';
  }
}

/** Image-count caps per size class; sampled inclusively. */
const IMAGE_COUNT_CAPS = {
  small: { min: 0, max: 1 },
  medium: { min: 0, max: 3 },
  large: { min: 0, max: 5 },
} as const satisfies Record<DocSpec['sizeClass'], { min: number; max: number }>;

export function pickImageCount(rng: () => number, sizeClass: DocSpec['sizeClass']): number {
  const cap = IMAGE_COUNT_CAPS[sizeClass];
  return sampleIntInRange(rng, cap.min, cap.max + 1);
}

interface BuildDocSpecOpts {
  readonly rng: () => number;
  readonly namePrefix: string;
  /** 1-based ordinal so generated names sort intuitively. */
  readonly index: number;
  readonly sizeClass: DocSpec['sizeClass'];
}

/**
 * Build one DocSpec deterministically from `rng`. The order of PRNG calls
 * is fixed (contentBytes → frontmatterDensity → imageCount) so a corpus
 * generated with the same seed and the same prefix sequence produces
 * byte-identical DocSpec records across runs.
 */
export function buildDocSpec(opts: BuildDocSpecOpts): DocSpec {
  const { rng, namePrefix, index, sizeClass } = opts;
  const contentBytes = pickContentBytes(rng, sizeClass);
  const frontmatterDensity = pickFrontmatterDensity(rng, sizeClass);
  const imageCount = pickImageCount(rng, sizeClass);
  return {
    name: formatDocName(namePrefix, index),
    sizeClass,
    frontmatterDensity,
    imageCount,
    contentBytes,
  };
}

/**
 * `vault-001`, `vault-002`, … — width sized to the largest expected
 * corpus (3 digits covers up to 999 docs). Stable across builds so the
 * sweep harness's per-cell staging keys are stable too.
 */
export function formatDocName(prefix: string, oneBasedIndex: number): string {
  const padded = String(oneBasedIndex).padStart(3, '0');
  return `${prefix}-${padded}`;
}

interface BuildCorpusOpts {
  readonly seed: number;
  readonly namePrefix: string;
  readonly mix: SizeMix;
}

/**
 * Build a corpus matching `mix` deterministically from `seed`.
 *
 * Layout is small → medium → large within `namePrefix` ordinals so the
 * caller can reason about the corpus by index range (e.g. `vault[0..14]`
 * are small). Tests rely on this ordering when computing the size mix
 * from the produced array.
 */
export function buildCorpus(opts: BuildCorpusOpts): DocSpec[] {
  const { seed, namePrefix, mix } = opts;
  const rng = makePrng(seed);
  const docs: DocSpec[] = [];
  let ordinal = 1;
  const emit = (count: number, sizeClass: DocSpec['sizeClass']): void => {
    for (let i = 0; i < count; i++) {
      docs.push(buildDocSpec({ rng, namePrefix, index: ordinal, sizeClass }));
      ordinal++;
    }
  };
  emit(mix.small, 'small');
  emit(mix.medium, 'medium');
  emit(mix.large, 'large');
  if (docs.length !== totalDocsInMix(mix)) {
    throw new Error(
      `[cache-regime-rotation] corpus build produced ${docs.length} docs, expected ${totalDocsInMix(mix)}`,
    );
  }
  return docs;
}
