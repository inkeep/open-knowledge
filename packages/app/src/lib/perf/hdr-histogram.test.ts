import { describe, expect, test } from 'bun:test';
import { HDR_HISTOGRAM_SENTINEL, Histogram } from './hdr-histogram';

/**
 * Brute-force percentile oracle: sort samples ascending, index the
 * percentile rank. Uses the ceil-rank rule so the result aligns with
 * the histogram's "first bucket whose cumulative count crosses the
 * target rank" semantics.
 */
function brutePercentile(samples: number[], rank: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Pseudo-random with a seeded LCG so PBT runs are deterministic. Using
 * Math.random() would drift a flaky test under the ±0.5% bound.
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xff_ff_ff_ff;
  };
}

type DistroFn = (rng: () => number) => number;

const distributions: Record<string, DistroFn> = {
  uniform: (rng) => 1 + Math.floor(rng() * 1_000_000),
  exponential: (rng) => Math.max(1, Math.round(-Math.log(1 - rng()) * 200)),
  // Approx log-normal via Box-Muller on two uniforms.
  logNormal: (rng) => {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(1, Math.round(Math.exp(2 + z * 0.8) * 50));
  },
  bimodal: (rng) => {
    return rng() < 0.7 ? 1 + Math.floor(rng() * 50) : 5_000 + Math.floor(rng() * 5_000);
  },
};

describe('Histogram', () => {
  test('exposes the ok-hdr-histogram-v1 sentinel', () => {
    expect(HDR_HISTOGRAM_SENTINEL).toBe('ok-hdr-histogram-v1');
  });

  test('rejects out-of-range precision', () => {
    expect(() => new Histogram(0)).toThrow();
    expect(() => new Histogram(6)).toThrow();
    expect(() => new Histogram(1.5)).toThrow();
  });

  test('empty snapshot returns zeros', () => {
    const h = new Histogram(3);
    const snap = h.snapshot();
    expect(snap.count).toBe(0);
    expect(snap.min).toBe(0);
    expect(snap.max).toBe(0);
    expect(snap.p50).toBe(0);
    expect(snap.p95).toBe(0);
    expect(snap.p99).toBe(0);
    expect(snap.p999).toBe(0);
  });

  test('single-sample percentiles all equal the sample', () => {
    const h = new Histogram(3);
    h.push(42);
    const snap = h.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.min).toBe(42);
    expect(snap.max).toBe(42);
    // Allow ±1 for first-bucket rounding (precision 3 → first bucket integer).
    for (const p of [snap.p50, snap.p95, snap.p99, snap.p999]) {
      expect(p).toBe(42);
    }
  });

  test('clamps zero / sub-millisecond values to 1', () => {
    const h = new Histogram(3);
    h.push(0);
    h.push(0.4);
    h.push(0.5);
    const snap = h.snapshot();
    expect(snap.count).toBe(3);
    expect(snap.min).toBe(1);
  });

  test('monotonicity holds for arbitrary samples', () => {
    const rng = seededRng(0xdeadbeef);
    const h = new Histogram(3);
    for (let i = 0; i < 1000; i += 1) h.push(distributions.exponential(rng));
    const snap = h.snapshot();
    expect(snap.p50).toBeLessThanOrEqual(snap.p95);
    expect(snap.p95).toBeLessThanOrEqual(snap.p99);
    expect(snap.p99).toBeLessThanOrEqual(snap.p999);
    expect(snap.min).toBeLessThanOrEqual(snap.p50);
    expect(snap.p999).toBeLessThanOrEqual(snap.max);
  });

  test('matches brute-force oracle within ±0.5% across distributions × sample counts', () => {
    // Tolerance accounts for bucket-midpoint quantization at 3-sig-fig
    // precision; the histogram bucket width is ~0.1% of value at the
    // tail, but the oracle reports the nearest-sample value, so we
    // allow 0.5% to absorb both the bucketization and oracle offsets.
    const tolerance = 0.005; // 0.5%
    const ranks: Array<
      keyof Pick<ReturnType<Histogram['snapshot']>, 'p50' | 'p95' | 'p99' | 'p999'>
    > = ['p50', 'p95', 'p99', 'p999'];
    for (const [distroName, distroFn] of Object.entries(distributions)) {
      for (const n of [100, 1000, 10000]) {
        const rng = seededRng(0xabcd_0000 + n);
        const h = new Histogram(3);
        const samples: number[] = [];
        for (let i = 0; i < n; i += 1) {
          const v = distroFn(rng);
          samples.push(v);
          h.push(v);
        }
        const snap = h.snapshot();
        for (const r of ranks) {
          const rankNum = r === 'p50' ? 50 : r === 'p95' ? 95 : r === 'p99' ? 99 : 99.9;
          const oracle = brutePercentile(samples, rankNum);
          const got = snap[r];
          // For tiny percentiles the absolute error matters more than
          // relative; allow a 1-bucket absolute slack at the low end.
          const allowed = Math.max(1, oracle * tolerance);
          const error = Math.abs(got - oracle);
          if (error > allowed) {
            throw new Error(
              `${distroName} n=${n} ${r}: got=${got}, oracle=${oracle}, error=${error}, allowed=${allowed.toFixed(2)}`,
            );
          }
        }
      }
    }
  });

  test('preserves monotonic count for repeated identical values', () => {
    const h = new Histogram(3);
    for (let i = 0; i < 50; i += 1) h.push(7);
    const snap = h.snapshot();
    expect(snap.count).toBe(50);
    expect(snap.min).toBe(7);
    expect(snap.max).toBe(7);
    expect(snap.p50).toBe(7);
    expect(snap.p999).toBe(7);
  });

  test('warns once per session when precision > 3 (memory-cost UX guidance)', () => {
    Histogram.__resetHighPrecisionWarning();
    const orig = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      // p=3 (default) does NOT warn — quiet on the documented happy path.
      new Histogram(3);
      expect(warnings.length).toBe(0);
      // p=4 warns once with a memory-cost figure (~MB).
      new Histogram(4);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Histogram precision 4');
      expect(warnings[0]).toMatch(/~\d+(\.\d+)? MB per instance/);
      expect(warnings[0]).toContain('MAX_HISTOGRAM_PRECISION=3');
      // Subsequent high-precision constructions are silent (warn-once gate).
      new Histogram(5);
      new Histogram(4);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = orig;
      Histogram.__resetHighPrecisionWarning();
    }
  });
});
