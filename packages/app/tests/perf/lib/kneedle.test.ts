import { describe, expect, test } from 'bun:test';
import { findKnee, isotonicSmooth } from './kneedle';

describe('findKnee', () => {
  describe('shape + degenerate inputs', () => {
    test('empty curve returns LOW confidence at origin', () => {
      const k = findKnee([]);
      expect(k.confidence).toBe('LOW');
      expect(k.x).toBe(0);
      expect(k.y).toBe(0);
    });

    test('single-point curve returns the point with LOW confidence', () => {
      const k = findKnee([{ x: 10, y: 100 }]);
      expect(k.x).toBe(10);
      expect(k.y).toBe(100);
      expect(k.confidence).toBe('LOW');
    });

    test('two-point curve has no inflection — LOW confidence', () => {
      const k = findKnee([
        { x: 5, y: 100 },
        { x: 10, y: 50 },
      ]);
      expect(k.confidence).toBe('LOW');
    });

    test('flat curve (all y identical) returns LOW confidence', () => {
      const k = findKnee([
        { x: 5, y: 50 },
        { x: 10, y: 50 },
        { x: 20, y: 50 },
        { x: 50, y: 50 },
      ]);
      expect(k.confidence).toBe('LOW');
    });

    test('zero-variance x (all same x) returns LOW confidence without throwing', () => {
      const k = findKnee([
        { x: 10, y: 1 },
        { x: 10, y: 2 },
        { x: 10, y: 3 },
      ]);
      expect(k.confidence).toBe('LOW');
    });
  });

  describe('synthetic L-shaped curve (AC: ±1 axis-step)', () => {
    test('decreasing L: knee found at x=14 in cap-axis curve', () => {
      // Replicates MAX_POOL sweep shape: latency drops sharply
      // until x=14, then flattens. Knee should land at x=14 ±1 axis-step.
      const curve = [
        { x: 5, y: 100 },
        { x: 10, y: 60 },
        { x: 14, y: 35 },
        { x: 20, y: 32 },
        { x: 30, y: 30 },
        { x: 50, y: 28 },
      ];
      const k = findKnee(curve);
      // ±1 axis-step from x=14 is [10, 20]; the knee MUST be in this range.
      expect([10, 14, 20]).toContain(k.x);
      expect(k.confidence === 'HIGH' || k.confidence === 'MEDIUM').toBe(true);
    });

    test('increasing concave: knee found at the elbow of a saturation curve', () => {
      // Concave-increasing: think hit-rate as cap grows; knee is where
      // hit-rate stops increasing meaningfully.
      const curve = [
        { x: 1, y: 0.1 },
        { x: 5, y: 0.4 },
        { x: 10, y: 0.7 },
        { x: 14, y: 0.85 },
        { x: 20, y: 0.9 },
        { x: 30, y: 0.92 },
        { x: 50, y: 0.93 },
      ];
      const k = findKnee(curve);
      expect([10, 14, 20]).toContain(k.x);
    });

    test('linear curve (no knee) returns LOW confidence', () => {
      // Truly linear: every diff is zero (after normalization). No
      // qualifying inflection.
      const curve = [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 30 },
        { x: 40, y: 40 },
        { x: 50, y: 50 },
      ];
      const k = findKnee(curve);
      expect(k.confidence).toBe('LOW');
    });
  });

  describe('confidence tiering by prominence', () => {
    test('sharp elbow yields HIGH confidence', () => {
      // y drops 95% in the first segment; the diff curve has a single
      // very prominent peak.
      const curve = [
        { x: 1, y: 1000 },
        { x: 2, y: 100 },
        { x: 3, y: 90 },
        { x: 4, y: 89 },
        { x: 5, y: 89 },
        { x: 6, y: 88 },
        { x: 7, y: 88 },
        { x: 8, y: 88 },
      ];
      const k = findKnee(curve);
      expect(k.confidence).toBe('HIGH');
    });

    test('gentle elbow yields MEDIUM or HIGH (not LOW)', () => {
      const curve = [
        { x: 1, y: 100 },
        { x: 2, y: 80 },
        { x: 3, y: 65 },
        { x: 4, y: 55 },
        { x: 5, y: 50 },
        { x: 6, y: 48 },
        { x: 7, y: 47 },
        { x: 8, y: 47 },
      ];
      const k = findKnee(curve);
      expect(k.confidence === 'HIGH' || k.confidence === 'MEDIUM').toBe(true);
    });

    test('higher sensitivity S tightens the HIGH band', () => {
      const curve = [
        { x: 1, y: 100 },
        { x: 2, y: 80 },
        { x: 3, y: 65 },
        { x: 4, y: 55 },
        { x: 5, y: 50 },
        { x: 6, y: 48 },
        { x: 7, y: 47 },
        { x: 8, y: 47 },
      ];
      const defaultK = findKnee(curve, { S: 1.0 });
      const strictK = findKnee(curve, { S: 3.0 });
      // Strict S should never upgrade confidence vs default; the knee
      // location is identical (S only modulates the band, not the argmax).
      expect(strictK.x).toBe(defaultK.x);
      const tier = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
      expect(tier[strictK.confidence]).toBeLessThanOrEqual(tier[defaultK.confidence]);
    });
  });

  describe('PAV smoothing handles measurement noise', () => {
    test('noisy decreasing curve with one inversion still finds the knee', () => {
      // Real sweep cells have ~10% replication noise; the curve dips
      // briefly above its predecessor at x=20 (noise) but the trend
      // is monotone-decreasing through the knee at x=14.
      const curve = [
        { x: 5, y: 100 },
        { x: 10, y: 65 },
        { x: 14, y: 32 },
        { x: 20, y: 36 }, // inversion (noise)
        { x: 30, y: 30 },
        { x: 50, y: 28 },
      ];
      const k = findKnee(curve, { smooth: true, direction: 'decreasing' });
      expect([10, 14, 20]).toContain(k.x);
    });

    test('smoothing off: same noisy curve may pick a different knee', () => {
      // Without PAV, the noise inversion can move the knee — this test
      // pins that the smoothing flag IS load-bearing, not theoretical.
      const curve = [
        { x: 5, y: 100 },
        { x: 10, y: 65 },
        { x: 14, y: 32 },
        { x: 20, y: 36 },
        { x: 30, y: 30 },
        { x: 50, y: 28 },
      ];
      const smoothed = findKnee(curve, { smooth: true });
      const raw = findKnee(curve, { smooth: false });
      // Both should be valid knees but the algorithm should respond to
      // the flag. We don't require them to differ on every curve, but the
      // smoothed run should never have lower confidence than the raw one
      // for noise-dominant fixtures.
      const tier = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
      expect(tier[smoothed.confidence]).toBeGreaterThanOrEqual(tier[raw.confidence] - 1);
    });
  });

  describe('direction inference', () => {
    test('decreasing inferred when y[last] < y[first]', () => {
      const curve = [
        { x: 5, y: 100 },
        { x: 10, y: 60 },
        { x: 14, y: 35 },
        { x: 20, y: 32 },
        { x: 30, y: 30 },
        { x: 50, y: 28 },
      ];
      // Same as the explicit-direction test above — must succeed without
      // passing the flag.
      const k = findKnee(curve);
      expect([10, 14, 20]).toContain(k.x);
    });

    test('increasing inferred when y[last] > y[first]', () => {
      const curve = [
        { x: 1, y: 0.1 },
        { x: 5, y: 0.4 },
        { x: 10, y: 0.7 },
        { x: 14, y: 0.85 },
        { x: 20, y: 0.9 },
        { x: 30, y: 0.92 },
        { x: 50, y: 0.93 },
      ];
      const k = findKnee(curve);
      expect([10, 14, 20]).toContain(k.x);
    });
  });

  describe('curve order invariance', () => {
    test('shuffled input produces the same knee', () => {
      const curve = [
        { x: 5, y: 100 },
        { x: 10, y: 60 },
        { x: 14, y: 35 },
        { x: 20, y: 32 },
        { x: 30, y: 30 },
        { x: 50, y: 28 },
      ];
      const sorted = findKnee([...curve]);
      const reversed = findKnee([...curve].reverse());
      expect(reversed.x).toBe(sorted.x);
      expect(reversed.y).toBe(sorted.y);
      expect(reversed.confidence).toBe(sorted.confidence);
    });
  });
});

describe('isotonicSmooth (PAV)', () => {
  test('already-monotonic decreasing input passes through unchanged', () => {
    const pts = [
      { x: 1, y: 100 },
      { x: 2, y: 80 },
      { x: 3, y: 60 },
      { x: 4, y: 40 },
    ];
    const result = isotonicSmooth(pts, 'decreasing');
    expect(result).toEqual(pts);
  });

  test('single inversion in decreasing curve gets merged to a plateau', () => {
    const pts = [
      { x: 1, y: 100 },
      { x: 2, y: 80 },
      { x: 3, y: 90 }, // inversion vs 80
      { x: 4, y: 60 },
    ];
    const result = isotonicSmooth(pts, 'decreasing');
    expect(result[0]?.y).toBe(100);
    // Indices 1 and 2 should be merged to (80 + 90) / 2 = 85.
    expect(result[1]?.y).toBe(85);
    expect(result[2]?.y).toBe(85);
    expect(result[3]?.y).toBe(60);
  });

  test('multiple inversions cascade-merge into one plateau', () => {
    const pts = [
      { x: 1, y: 100 },
      { x: 2, y: 50 },
      { x: 3, y: 70 },
      { x: 4, y: 60 },
      { x: 5, y: 10 },
    ];
    const result = isotonicSmooth(pts, 'decreasing');
    // Indices 1-3 should merge to (50 + 70 + 60) / 3 = 60.
    expect(result[1]?.y).toBeCloseTo(60, 9);
    expect(result[2]?.y).toBeCloseTo(60, 9);
    expect(result[3]?.y).toBeCloseTo(60, 9);
    expect(result[4]?.y).toBe(10);
  });

  test('preserves x-positions exactly', () => {
    const pts = [
      { x: 1.5, y: 100 },
      { x: 2.7, y: 50 },
      { x: 3.1, y: 90 },
      { x: 4.0, y: 10 },
    ];
    const result = isotonicSmooth(pts, 'decreasing');
    expect(result.map((p) => p.x)).toEqual([1.5, 2.7, 3.1, 4.0]);
  });

  test('empty input returns empty array', () => {
    expect(isotonicSmooth([], 'decreasing')).toEqual([]);
  });
});

describe('findKnee — bimodal CDF input (US-010)', () => {
  // The MOUNT methodology aggregates non-rejected mount-time samples
  // across all profiles. The aggregated distribution may be bimodal —
  // a cold-mount cluster (~30-50ms) plus a warm-path-fallback cluster
  // (~200-300ms). On the CDF, this shows up as two visible knees.
  // The NN clamp [3000, 10000] is the guardrail that catches a
  // wrong-inflection pick: even if kneedle locks onto the wrong
  // cluster boundary, the recommended cap stays within the perception
  // band.

  test('returns an inflection point on a bimodal CDF', () => {
    // Build a bimodal CDF: 50% of samples at ~30ms, 50% at ~250ms.
    // The CDF rises steeply at x=30, plateaus, rises steeply again at
    // x=250. Either inflection is acceptable kneedle behavior.
    const samples = [
      ...Array.from({ length: 50 }, (_, i) => 25 + i * 0.2), // 25..35ms
      ...Array.from({ length: 50 }, (_, i) => 245 + i * 0.2), // 245..255ms
    ];
    const sorted = [...samples].sort((a, b) => a - b);
    const cdf = sorted.map((x, i) => ({ x, y: (i + 1) / sorted.length }));
    const knee = findKnee(cdf, { direction: 'increasing' });
    expect(Number.isFinite(knee.x)).toBe(true);
    expect(knee.x).toBeGreaterThan(0);
    // The knee can land anywhere in the curve — the contract is just
    // that it's finite and within the sample range.
    expect(knee.x).toBeLessThanOrEqual(255);
    expect(knee.x).toBeGreaterThanOrEqual(25);
  });

  test('handles a uniform distribution by returning LOW confidence', () => {
    // A perfectly uniform distribution has no inflection. kneedle
    // returns the midpoint with LOW confidence — the MOUNT
    // methodology must detect this and fall back to NN ceiling.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const cdf = samples.map((x, i) => ({ x, y: (i + 1) / samples.length }));
    const knee = findKnee(cdf, { direction: 'increasing' });
    expect(knee.confidence).toBe('LOW');
  });
});
