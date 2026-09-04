export interface BootstrapConfidenceInterval {
  readonly lo: number;
  readonly hi: number;
  readonly estimate: number;
}

export interface BcaOptions {
  readonly bootstrapCount?: number;

  readonly rng?: () => number;

  readonly statistic?: (samples: ReadonlyArray<number>) => number;
}

const DEFAULT_BOOTSTRAP_COUNT = 2000;
const ZERO_VARIANCE_EPSILON = 1e-12;

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

  const allEqual = samples.every(
    (v) => Math.abs(v - (samples[0] as number)) < ZERO_VARIANCE_EPSILON,
  );
  if (allEqual) {
    return { lo: estimate, hi: estimate, estimate };
  }

  const replicates = generateBootstrapReplicates(samples, bootstrapCount, statistic, rng);
  replicates.sort((a, b) => a - b);

  const belowEstimate = countBelow(replicates, estimate);
  const z0 = normalInvCdf(clampForInvCdf(belowEstimate / replicates.length));

  const acceleration = computeJackknifeAcceleration(samples, statistic);

  const zAlphaLo = normalInvCdf(alpha);
  const zAlphaHi = normalInvCdf(1 - alpha);

  const alphaLoCorrected = normalCdf(z0 + (z0 + zAlphaLo) / (1 - acceleration * (z0 + zAlphaLo)));
  const alphaHiCorrected = normalCdf(z0 + (z0 + zAlphaHi) / (1 - acceleration * (z0 + zAlphaHi)));

  const lo = pickPercentile(replicates, alphaLoCorrected);
  const hi = pickPercentile(replicates, alphaHiCorrected);

  return { lo, hi, estimate };
}

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

function normalInvCdf(p: number): number {
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
