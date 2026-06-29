
import { readNumericOverride } from './env-override';

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
    const minSub = 2 * 10 ** p;
    let sub = 1;
    while (sub < minSub) sub *= 2;
    this.subBucketCount = sub;
    this.subBucketHalfCount = sub / 2;
    this.subBucketMask = sub - 1;
    let bc = 1;
    let topValue = sub;
    while (topValue < MAX_VALUE) {
      topValue *= 2;
      bc += 1;
    }
    this.bucketCount = bc;
    const totalBuckets = (this.bucketCount + 1) * this.subBucketHalfCount;
    this.counts = new Uint32Array(totalBuckets);
    if (p > 3 && !highPrecisionWarned) {
      highPrecisionWarned = true;
      const mb = ((totalBuckets * 4) / 1024 / 1024).toFixed(1);
      console.warn(
        `[perf] Histogram precision ${p} allocates ~${mb} MB per instance — set MAX_HISTOGRAM_PRECISION=3 (default) to reduce memory cost.`,
      );
    }
  }

  static __resetHighPrecisionWarning(): void {
    highPrecisionWarned = false;
  }

  private indexFor(value: number): number {
    const bucketIndex = Math.max(0, this.bucketIndex(value));
    const subBucketIndex = this.subBucketIndex(value, bucketIndex);
    const bucketBaseIndex = (bucketIndex + 1) * this.subBucketHalfCount;
    const offset = subBucketIndex - this.subBucketHalfCount;
    if (bucketIndex === 0) return subBucketIndex;
    return bucketBaseIndex + offset;
  }

  private bucketIndex(value: number): number {
    if (value < this.subBucketCount) return 0;
    return Math.floor(Math.log2(value)) - Math.floor(Math.log2(this.subBucketCount)) + 1;
  }

  private subBucketIndex(value: number, bucketIndex: number): number {
    return Math.floor(value / 2 ** bucketIndex) & this.subBucketMask;
  }

  private valueFor(index: number): number {
    if (index < this.subBucketCount) {
      return index;
    }
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
