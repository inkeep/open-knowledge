/**
 * Hand-rolled HDR-style fixed-bucket histogram.
 *
 * Design rationale: the `hdr-histogram-js` npm package is 683 KB
 * unpacked with no tree-shaking metadata (UMD-only), which would
 * dominate the production bundle for a primitive used only in DEV /
 * scenario harness paths. The implementation below is ~150 LOC, sized
 * for the [1, 1e9] millisecond range at default 3 significant-figure
 * precision (~0.1% bucket-width error), covering single-sample to
 * ~11-day operations.
 *
 * Tree-shaking: every reference to this class is gated through
 * `getCollector()`, which Vite constant-folds out of production builds.
 * When the class itself isn't reachable from any prod path, the entire
 * module is DCE'd. The unique sentinel below is grepped by the
 * bundle-check assertion to detect tree-shake regressions.
 *
 * Bucket layout (HDR-inspired):
 * - `unitMagnitude` = 0 (sample range starts at 1 ms).
 * - `subBucketCount = 2 * 10^precision` covers one power-of-two stripe.
 * - `bucketCount = ceil(log2(maxValue / subBucketCount)) + 1` stripes
 *   together cover the entire [1, MAX_VALUE] range.
 * - Total buckets ≈ subBucketCount × bucketCount.
 *
 * Percentiles (`p50`, `p95`, `p99`, `p999`) are computed lazily on
 * `snapshot()` by walking the count array and stopping at the first
 * cumulative count crossing the target rank. Each bucket contributes
 * its midpoint value (round-to-nearest semantics).
 *
 * The brute-force PBT in `hdr-histogram.test.ts` validates within
 * ±0.5% against a sorted-array oracle for uniform / exponential /
 * log-normal / bimodal distributions at sample counts ∈ {100, 1000,
 * 10000}.
 */

import { readNumericOverride } from './env-override';

/**
 * Sentinel string — bundle-check greps prod chunks for this and fails
 * the build if it appears, proving the class tree-shook from prod.
 * Update when changing the histogram backing format so old prod chunks
 * remain detectable as regressions.
 */
export const HDR_HISTOGRAM_SENTINEL = 'ok-hdr-histogram-v1' as const;

const MAX_VALUE = 1_000_000_000; // 1e9 ms ~= 11 days.

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

// One-shot guard so the high-precision memory-cost warning fires once per
// session regardless of how many Histograms are constructed at p>3.
let highPrecisionWarned = false;

export class Histogram {
  private readonly subBucketCount: number;
  private readonly subBucketHalfCount: number;
  private readonly subBucketMask: number;
  private readonly bucketCount: number;
  private readonly counts: Uint32Array;
  private totalCount = 0;
  private sumValues = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = 0;

  constructor(precision?: number) {
    const p = precision ?? readNumericOverride('MAX_HISTOGRAM_PRECISION', 3);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      throw new RangeError(`Histogram precision must be an integer in [1,5] (got ${p})`);
    }
    // Sub-bucket count is the next power of two ≥ 2 × 10^precision so the
    // bit-shifting bucket-resolve uses cheap integer math.
    const minSub = 2 * 10 ** p;
    let sub = 1;
    while (sub < minSub) sub *= 2;
    this.subBucketCount = sub;
    this.subBucketHalfCount = sub / 2;
    this.subBucketMask = sub - 1;
    // Number of power-of-two stripes needed to cover MAX_VALUE.
    let bc = 1;
    let topValue = sub;
    while (topValue < MAX_VALUE) {
      topValue *= 2;
      bc += 1;
    }
    this.bucketCount = bc;
    const totalBuckets = (this.bucketCount + 1) * this.subBucketHalfCount;
    this.counts = new Uint32Array(totalBuckets);
    // Memory-cost UX guidance: at the validated upper bound (p=5) each
    // instance allocates ~6.5 MB; a DEV session with several histogram
    // names compounds. Warn once per session so a developer who set the
    // override sees the per-instance cost. DEV-only path (the whole
    // collector tree-shakes from prod via the !PROD gate at call sites);
    // p≤3 is the documented default and never warns.
    if (p > 3 && !highPrecisionWarned) {
      highPrecisionWarned = true;
      const mb = ((totalBuckets * 4) / 1024 / 1024).toFixed(1);
      console.warn(
        `[perf] Histogram precision ${p} allocates ~${mb} MB per instance — set MAX_HISTOGRAM_PRECISION=3 (default) to reduce memory cost.`,
      );
    }
  }

  /** Test-only: reset the warn-once guard between test runs. */
  static __resetHighPrecisionWarning(): void {
    highPrecisionWarned = false;
  }

  /** Resolve `value` to a flat array index. */
  private indexFor(value: number): number {
    // Bucket index: number of leading-zero-stripes from below.
    const bucketIndex = Math.max(0, this.bucketIndex(value));
    const subBucketIndex = this.subBucketIndex(value, bucketIndex);
    // Each bucket beyond index 0 contributes only the upper half (subBucketCount/2)
    // because the lower half overlaps the previous bucket's upper half.
    const bucketBaseIndex = (bucketIndex + 1) * this.subBucketHalfCount;
    const offset = subBucketIndex - this.subBucketHalfCount;
    if (bucketIndex === 0) return subBucketIndex;
    return bucketBaseIndex + offset;
  }

  private bucketIndex(value: number): number {
    // log2(value / subBucketCount) but never negative.
    if (value < this.subBucketCount) return 0;
    return Math.floor(Math.log2(value)) - Math.floor(Math.log2(this.subBucketCount)) + 1;
  }

  private subBucketIndex(value: number, bucketIndex: number): number {
    // Unified: sub = floor(value / 2^bucketIndex) & subBucketMask. For
    // bucket=0 the divisor is 1 and the mask is a no-op since value < F.
    return Math.floor(value / 2 ** bucketIndex) & this.subBucketMask;
  }

  /** Reverse: given a flat index, the representative sample value. */
  private valueFor(index: number): number {
    if (index < this.subBucketCount) {
      // First bucket (bucketIndex=0): integer values 0..subBucketCount-1.
      return index;
    }
    // Above bucket 0 the layout is: F + (b-1)*H + (sub - H), with
    // offset = index - F. Recover (b, sub) from offset.
    const offset = index - this.subBucketCount;
    const bucketIndex = Math.floor(offset / this.subBucketHalfCount) + 1;
    const subBucketIndex = (offset % this.subBucketHalfCount) + this.subBucketHalfCount;
    return subBucketIndex * 2 ** bucketIndex;
  }

  push(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const v = Math.max(1, Math.round(durationMs));
    const clamped = Math.min(v, MAX_VALUE);
    const idx = this.indexFor(clamped);
    if (idx < 0 || idx >= this.counts.length) return;
    this.counts[idx] = (this.counts[idx] ?? 0) + 1;
    this.totalCount += 1;
    this.sumValues += clamped;
    if (clamped < this.minValue) this.minValue = clamped;
    if (clamped > this.maxValue) this.maxValue = clamped;
  }

  private percentile(rank: number): number {
    if (this.totalCount === 0) return 0;
    const target = Math.max(1, Math.ceil((rank / 100) * this.totalCount));
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      cumulative += this.counts[i] ?? 0;
      if (cumulative >= target) {
        return this.valueFor(i);
      }
    }
    return this.maxValue;
  }

  snapshot(): HistogramSnapshot {
    return {
      count: this.totalCount,
      sum: this.sumValues,
      min: this.totalCount === 0 ? 0 : this.minValue,
      max: this.maxValue,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      p999: this.percentile(99.9),
    };
  }
}
