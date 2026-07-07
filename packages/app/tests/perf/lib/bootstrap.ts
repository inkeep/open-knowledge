/**
 * BCa (bias-corrected and accelerated) bootstrap confidence intervals.
 *
 * The sweep runner pins per-cell uncertainty so reviewers can compare cells
 * against each other instead of reading point estimates as if they were exact.
 * Mozilla Talos uses BCa for cross-run regression detection — the published
 * 2000-resample default is what this module ships.
 *
 * Algorithm reference: Efron 1987, "Better Bootstrap Confidence Intervals"
 * (https://www.jstor.org/stable/2289144). The bias-correction term z0 corrects
 * the median-zero assumption of the basic percentile bootstrap; the
 * acceleration term a (from the jackknife) corrects for non-constant variance
 * along the parameter axis. The two corrections together let the CI track
 * skewed distributions — common for p95 latency samples where the upper tail
 * is the load-bearing observation.
 *
 * Edge cases that matter for the sweep harness:
 *
 *   - **Empty sample** → returns an all-zeros CI rather than NaN. A cell with
 *     no measurements isn't a math error, it's a missing observation. The
 *     caller decides whether absence is fatal.
 *
 *   - **Single-value samples** (every measurement identical) → CI collapses
 *     to [v, v] and bias / acceleration terms degenerate to zero. The
 *     algorithm falls back to a trivial percentile CI when variance is zero.
 *
 *   - **`alpha` outside (0, 0.5)** → caller bug; throws. The caller passes
 *     the per-tail alpha (0.025 for a 95% CI), not the confidence level
 *     (which would be 0.95).
 *
 * Determinism: the default RNG is `Math.random`. Tests inject a seeded RNG
 * via `options.rng` so resample sequences are reproducible.
 */

/**
 * One-sided percentile bounds + the point estimate for a single statistic.
 * `lo` and `hi` bracket a (1 - 2*alpha) confidence interval. `estimate` is
 * the statistic on the ORIGINAL samples, not the bootstrap mean — the
 * bootstrap distribution corrects the interval, not the central tendency.
 */
export interface BootstrapConfidenceInterval {
  readonly lo: number;
  readonly hi: number;
  readonly estimate: number;
}

export interface BcaOptions {
  /**
   * Number of bootstrap resamples. Talos uses 2000-10000; 2000 is the
   * accuracy-vs-cost sweet spot for sweep cells (per-cell BCa adds ~10-50ms
   * at this count, dwarfed by the cell measurement itself).
   */
  readonly bootstrapCount?: number;

  /**
   * RNG returning a number in [0, 1). Defaults to `Math.random`. Tests inject
   * a seeded RNG so resample sequences are reproducible across runs.
   */
  readonly rng?: () => number;

  /**
   * Statistic to compute. Defaults to arithmetic mean. The sweep harness uses
   * mean for the BCa entrypoint and computes p95 per-axis separately — BCa
   * on p95 samples directly would need a different jackknife (order statistic
   * influence is non-smooth) and isn't what Talos's pattern provides.
   */
  readonly statistic?: (samples: ReadonlyArray<number>) => number;
}

const DEFAULT_BOOTSTRAP_COUNT = 2000;
const ZERO_VARIANCE_EPSILON = 1e-12;

/**
 * Bias-corrected and accelerated bootstrap CI for `statistic(samples)` at
 * confidence (1 - 2*alpha). Pass `alpha = 0.025` for a 95% CI.
 *
 * Returns an all-zeros CI for empty samples; collapses to [v, v] for
 * zero-variance samples; otherwise computes the BCa-corrected percentile
 * bounds from `bootstrapCount` resamples.
 */
export function bcaConfidenceInterval(
  samples: ReadonlyArray<number>,
  alpha: number,
  options: BcaOptions = {},
): BootstrapConfidenceInterval {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 0.5) {
    throw new Error(
      `bcaConfidenceInterval: alpha must be in (0, 0.5); got ${alpha}. ` +
        `For a 95% CI pass 0.025 (per-tail), NOT 0.95 (confidence level).`,
    );
  }

  if (samples.length === 0) {
    return { lo: 0, hi: 0, estimate: 0 };
  }

  const statistic = options.statistic ?? arithmeticMean;
  const rng = options.rng ?? Math.random;
  const bootstrapCount = options.bootstrapCount ?? DEFAULT_BOOTSTRAP_COUNT;

  const estimate = statistic(samples);

  if (samples.length === 1) {
    return { lo: estimate, hi: estimate, estimate };
  }

  // Zero-variance short-circuit: avoids NaN from sum-of-cubes / sum-of-squares.
  const allEqual = samples.every(
    (v) => Math.abs(v - (samples[0] as number)) < ZERO_VARIANCE_EPSILON,
  );
  if (allEqual) {
    return { lo: estimate, hi: estimate, estimate };
  }

  const replicates = generateBootstrapReplicates(samples, bootstrapCount, statistic, rng);
  replicates.sort((a, b) => a - b);

  // Bias correction z0 = Phi^-1(P(theta* < theta_hat)).
  const belowEstimate = countBelow(replicates, estimate);
  const z0 = normalInvCdf(clampForInvCdf(belowEstimate / replicates.length));

  // Acceleration via jackknife: a = sum((mean - i)^3) / (6 * (sum((mean - i)^2))^1.5).
  const acceleration = computeJackknifeAcceleration(samples, statistic);

  const zAlphaLo = normalInvCdf(alpha);
  const zAlphaHi = normalInvCdf(1 - alpha);

  const alphaLoCorrected = normalCdf(z0 + (z0 + zAlphaLo) / (1 - acceleration * (z0 + zAlphaLo)));
  const alphaHiCorrected = normalCdf(z0 + (z0 + zAlphaHi) / (1 - acceleration * (z0 + zAlphaHi)));

  const lo = pickPercentile(replicates, alphaLoCorrected);
  const hi = pickPercentile(replicates, alphaHiCorrected);

  return { lo, hi, estimate };
}

// ──────────────────────────── Helpers ─────────────────────────────

function arithmeticMean(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

function generateBootstrapReplicates(
  samples: ReadonlyArray<number>,
  count: number,
  statistic: (s: ReadonlyArray<number>) => number,
  rng: () => number,
): number[] {
  const n = samples.length;
  const replicate: number[] = new Array(n);
  const results: number[] = new Array(count);
  for (let b = 0; b < count; b++) {
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      replicate[i] = samples[idx] as number;
    }
    results[b] = statistic(replicate);
  }
  return results;
}

function countBelow(sortedReplicates: ReadonlyArray<number>, target: number): number {
  // Binary search for the count of values strictly less than `target`.
  let lo = 0;
  let hi = sortedReplicates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sortedReplicates[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function computeJackknifeAcceleration(
  samples: ReadonlyArray<number>,
  statistic: (s: ReadonlyArray<number>) => number,
): number {
  const n = samples.length;
  const jackknifeEstimates: number[] = new Array(n);
  const oneOut: number[] = new Array(n - 1);

  for (let i = 0; i < n; i++) {
    for (let j = 0, k = 0; j < n; j++) {
      if (j === i) continue;
      oneOut[k++] = samples[j] as number;
    }
    jackknifeEstimates[i] = statistic(oneOut);
  }

  const jackknifeMean = arithmeticMean(jackknifeEstimates);

  let numerator = 0;
  let denominator = 0;
  for (const j of jackknifeEstimates) {
    const diff = jackknifeMean - j;
    numerator += diff * diff * diff;
    denominator += diff * diff;
  }

  if (denominator < ZERO_VARIANCE_EPSILON) return 0;
  return numerator / (6 * denominator ** 1.5);
}

function clampForInvCdf(p: number): number {
  // normalInvCdf domain is (0, 1). Clamp boundary observations to the
  // smallest representable interior point so the CI doesn't collapse to
  // ±Infinity when every replicate falls on one side of the estimate.
  if (p <= 0) return 1e-9;
  if (p >= 1) return 1 - 1e-9;
  return p;
}

function pickPercentile(sortedSamples: ReadonlyArray<number>, p: number): number {
  if (sortedSamples.length === 0) return 0;
  if (!Number.isFinite(p)) return sortedSamples[0] as number;
  if (p <= 0) return sortedSamples[0] as number;
  if (p >= 1) return sortedSamples[sortedSamples.length - 1] as number;
  const idx = p * (sortedSamples.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedSamples[lo] as number;
  const weight = idx - lo;
  return (sortedSamples[lo] as number) * (1 - weight) + (sortedSamples[hi] as number) * weight;
}

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26 (erf approximation).
 * Max abs error ≈ 1.5e-7 — sufficient for BCa where the result feeds into
 * a percentile lookup over discrete bootstrap replicates.
 */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

/**
 * Inverse normal CDF via Beasley-Springer-Moro (1995). Max abs error ≈
 * 4.5e-9 in the central region; tail accuracy ≈ 1.5e-7. The BCa terms only
 * need this on (epsilon, 1 - epsilon), so the central rational approximation
 * dominates the cost.
 */
function normalInvCdf(p: number): number {
  // Coefficients per Wichura's AS 241 / Beasley-Springer-Moro.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
        (c[3] as number)) *
        q +
        (c[4] as number)) *
        q +
        (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
        1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r +
        (a[3] as number)) *
        r +
        (a[4] as number)) *
        r +
        (a[5] as number)) *
        q) /
      ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r +
        (b[3] as number)) *
        r +
        (b[4] as number)) *
        r +
        1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) *
      q +
      (c[4] as number)) *
      q +
      (c[5] as number)) /
    (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
      q +
      1)
  );
}
