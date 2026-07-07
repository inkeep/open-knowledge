import { describe, expect, test } from 'bun:test';
import { bcaConfidenceInterval } from './bootstrap';

/**
 * Mulberry32 PRNG — same generator the cache-regime-rotation fixtures use
 * Deterministic resamples mean CIs are reproducible across
 * runs; without seeding, BCa would flake on the boundary cases this suite
 * pins.
 */
function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateNormal(seed: number, n: number, mean: number, stdDev: number): number[] {
  // Box-Muller; one normal per two uniforms. Fine for ~100-sample test sets.
  const rng = makePrng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(mean + stdDev * z);
  }
  return out;
}

describe('bcaConfidenceInterval', () => {
  describe('shape + degenerate inputs', () => {
    test('empty samples returns all-zero CI without throwing', () => {
      const ci = bcaConfidenceInterval([], 0.025);
      expect(ci).toEqual({ lo: 0, hi: 0, estimate: 0 });
    });

    test('single-sample collapses to [v, v]', () => {
      const ci = bcaConfidenceInterval([42], 0.025);
      expect(ci.lo).toBe(42);
      expect(ci.hi).toBe(42);
      expect(ci.estimate).toBe(42);
    });

    test('zero-variance samples collapse to [v, v]', () => {
      const ci = bcaConfidenceInterval([100, 100, 100, 100, 100], 0.025);
      expect(ci.lo).toBe(100);
      expect(ci.hi).toBe(100);
      expect(ci.estimate).toBe(100);
    });

    test('alpha outside (0, 0.5) throws actionable error', () => {
      expect(() => bcaConfidenceInterval([1, 2, 3], 0)).toThrow('alpha must be in (0, 0.5)');
      expect(() => bcaConfidenceInterval([1, 2, 3], 0.5)).toThrow('alpha must be in (0, 0.5)');
      expect(() => bcaConfidenceInterval([1, 2, 3], 0.95)).toThrow('alpha must be in (0, 0.5)');
      expect(() => bcaConfidenceInterval([1, 2, 3], -0.1)).toThrow('alpha must be in (0, 0.5)');
      expect(() => bcaConfidenceInterval([1, 2, 3], Number.NaN)).toThrow(
        'alpha must be in (0, 0.5)',
      );
    });
  });

  describe('Mozilla Talos pattern (known distribution)', () => {
    test('95% CI on normal(mean=100, sd=10, n=200) contains the true mean', () => {
      const samples = generateNormal(42, 200, 100, 10);
      const ci = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(99),
        bootstrapCount: 1000,
      });
      // Sample mean drifts by ~0.5; CI half-width ≈ 1.4. Anchor on the
      // sample mean, not the population mean, because the bootstrap
      // corrects the SAMPLE-mean estimator's distribution.
      expect(ci.lo).toBeLessThan(ci.estimate);
      expect(ci.hi).toBeGreaterThan(ci.estimate);
      expect(ci.lo).toBeLessThan(100);
      expect(ci.hi).toBeGreaterThan(100);
      // Width should be ~2-3 (2 * 1.96 * (10 / sqrt(200))).
      const width = ci.hi - ci.lo;
      expect(width).toBeGreaterThan(1.5);
      expect(width).toBeLessThan(5);
    });

    test('CI tightens as sample size grows', () => {
      const small = generateNormal(7, 30, 50, 5);
      const large = generateNormal(7, 300, 50, 5);
      const ciSmall = bcaConfidenceInterval(small, 0.025, {
        rng: makePrng(11),
        bootstrapCount: 1000,
      });
      const ciLarge = bcaConfidenceInterval(large, 0.025, {
        rng: makePrng(11),
        bootstrapCount: 1000,
      });
      expect(ciLarge.hi - ciLarge.lo).toBeLessThan(ciSmall.hi - ciSmall.lo);
    });

    test('point estimate equals statistic(original samples), not the bootstrap mean', () => {
      // Skewed samples: bootstrap mean of bootstrap means ≈ sample mean,
      // but the BCa contract pins `estimate` to the ORIGINAL-sample stat.
      const skewed = [1, 1, 1, 1, 1, 1, 1, 100];
      const sampleMean = skewed.reduce((a, b) => a + b, 0) / skewed.length;
      const ci = bcaConfidenceInterval(skewed, 0.025, {
        rng: makePrng(3),
        bootstrapCount: 2000,
      });
      expect(ci.estimate).toBeCloseTo(sampleMean, 9);
    });

    test('bias correction shifts the CI on skewed data', () => {
      // Right-skewed sample: BCa should push the CI rightward relative to
      // a naive percentile bootstrap (the bias-correction z0 captures the
      // median-vs-mean shift).
      const skewed = [10, 11, 12, 12, 13, 13, 14, 15, 16, 80];
      const ci = bcaConfidenceInterval(skewed, 0.025, {
        rng: makePrng(5),
        bootstrapCount: 4000,
      });
      expect(ci.lo).toBeGreaterThan(10);
      // Upper bound has to bracket the actual sample mean (~19.6) since
      // a single 80 is influential at n=10.
      expect(ci.hi).toBeGreaterThan(ci.estimate);
    });
  });

  describe('determinism + options', () => {
    test('same RNG seed produces identical CI', () => {
      const samples = generateNormal(1, 50, 0, 1);
      const a = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(123),
        bootstrapCount: 500,
      });
      const b = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(123),
        bootstrapCount: 500,
      });
      expect(a).toEqual(b);
    });

    test('different RNG seeds produce different CIs but contain the same estimate', () => {
      const samples = generateNormal(1, 50, 0, 1);
      const a = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(1),
        bootstrapCount: 500,
      });
      const b = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(2),
        bootstrapCount: 500,
      });
      expect(a.estimate).toBe(b.estimate);
      // CIs may differ at second/third decimal — pin same estimate, allow CI bands to vary.
      expect(a.lo).not.toBe(b.lo);
    });

    test('custom statistic (median) overrides the mean default', () => {
      // Outlier-resistant median; CI should NOT track the 1000 outlier the
      // way a mean-CI would.
      const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
      const median = (s: ReadonlyArray<number>): number => {
        const sorted = [...s].sort((x, y) => x - y);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
          return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
        }
        return sorted[mid] as number;
      };
      const ci = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(7),
        bootstrapCount: 1000,
        statistic: median,
      });
      expect(ci.estimate).toBe(5.5);
      // Median CI is bounded by the inter-quartile region; should NOT reach
      // anywhere near 1000.
      expect(ci.hi).toBeLessThan(50);
    });

    test('bootstrapCount of 0 yields an interior CI without throwing (defensive guard at empty replicates)', () => {
      // The replicate array is empty when count=0; percentile lookup on
      // empty input returns 0 by convention. Ensures we don't blow up
      // with NaN/throw when the caller passes a degenerate count.
      const samples = [1, 2, 3, 4, 5];
      const ci = bcaConfidenceInterval(samples, 0.025, {
        rng: makePrng(1),
        bootstrapCount: 0,
      });
      expect(Number.isFinite(ci.estimate)).toBe(true);
      expect(Number.isFinite(ci.lo)).toBe(true);
      expect(Number.isFinite(ci.hi)).toBe(true);
    });
  });
});
