import type { DocSpec, SizeMix } from './types';
import { SIZE_ENVELOPES, totalDocsInMix } from './types';

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

export function pickContentBytes(rng: () => number, sizeClass: DocSpec['sizeClass']): number {
  const env = SIZE_ENVELOPES[sizeClass];
  return sampleIntInRange(rng, env.minBytes, env.maxBytes + 1);
}

export function pickFrontmatterDensity(
  rng: () => number,
  sizeClass: DocSpec['sizeClass'],
): DocSpec['frontmatterDensity'] {
  const draw = rng();
  switch (sizeClass) {
    case 'small':
      if (draw < 0.7) return 'none';
      if (draw < 0.95) return 'minimal';
      return 'heavy';
    case 'medium':
      if (draw < 0.2) return 'none';
      if (draw < 0.75) return 'minimal';
      return 'heavy';
    case 'large':
      if (draw < 0.05) return 'none';
      if (draw < 0.4) return 'minimal';
      return 'heavy';
  }
}

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
  readonly index: number;
  readonly sizeClass: DocSpec['sizeClass'];
}

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

export function formatDocName(prefix: string, oneBasedIndex: number): string {
  const padded = String(oneBasedIndex).padStart(3, '0');
  return `${prefix}-${padded}`;
}

interface BuildCorpusOpts {
  readonly seed: number;
  readonly namePrefix: string;
  readonly mix: SizeMix;
}

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
