/**
 * Knee detection on a 1-D monotonic curve via the Kneedle algorithm
 * (Satopaa et al., 2011, "Finding a Kneedle in a Haystack"), with optional
 * Pool-Adjacent-Violators (PAV) isotonic smoothing as a pre-step.
 *
 * The sweep runner asks "at what cap value does adding more cap stop
 * improving the UX axis?" — the Pareto knee. Past the knee, more cap is
 * pure cost (memory + server amplification) with zero observable benefit.
 * The knee is the verdict target, the ceiling is the search-space upper
 * bound — and so a correct knee finder is load-bearing for the campaign's
 * core decision.
 *
 * Algorithm overview:
 *
 *   1. (Optional) Smooth via PAV so the curve is monotonic in the
 *      configured direction. Sweep cells have replication noise; raw
 *      curves can dip-then-recover and a pure local-max diff scan would
 *      latch onto the wrong inflection.
 *
 *   2. Normalize x and y to [0, 1]. Lets the algorithm compare curves at
 *      different scales (latency in ms vs hit-rate as a fraction) without
 *      retuning the sensitivity.
 *
 *   3. Compute the diff curve. For a decreasing curve, invert y first so
 *      the "good direction" is up — the knee then sits at the max of the
 *      diff curve (the point farthest above the diagonal). For an
 *      increasing curve, the same diff applies directly.
 *
 *   4. Return the original (x, y) at the argmax of the diff curve,
 *      tagged with a confidence drawn from the knee's prominence (how
 *      far above the diff-curve mean it stands, in standard deviations).
 *
 * Edge cases:
 *
 *   - Fewer than 3 points → no knee meaningful; return the first point
 *     with LOW confidence (caller's responsibility to treat as a
 *     "knee unavailable" signal).
 *
 *   - Flat curve (all y identical) → no inflection; return midpoint with
 *     LOW confidence.
 *
 *   - Multiple candidate maxima with similar prominence → returns the
 *     FIRST max (lowest x), confidence reflects the ambiguity via the
 *     prominence threshold.
 *
 * The sensitivity parameter `S` follows the Satopaa et al. convention:
 * higher `S` requires a more prominent knee before declaring HIGH
 * confidence. Default 1.0 matches the published baseline.
 */

export interface KneePoint {
  readonly x: number;
  readonly y: number;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export type CurveDirection = 'increasing' | 'decreasing';

export interface KneedleOptions {
  /**
   * Sensitivity threshold for the HIGH confidence band, in units of
   * standard deviations above the diff-curve mean. Default 1.0 (Satopaa
   * et al. published baseline).
   */
  readonly S?: number;

  /**
   * Direction along x. Default: auto-detect from y[0] vs y[n-1].
   * Latency-vs-cap and time-vs-iter curves are typically decreasing.
   */
  readonly direction?: CurveDirection;

  /**
   * Apply PAV monotonic smoothing first. Default `true` (noisy
   * sweep cells would otherwise dip-and-recover into false knees).
   */
  readonly smooth?: boolean;
}

const DEFAULT_S = 1.0;
const VARIANCE_EPSILON = 1e-12;

/**
 * Find the knee on a sorted-or-unsorted (x, y) curve. Returns the
 * original (x, y) at the inflection, plus a confidence drawn from how
 * far above the diff-curve mean the knee stands.
 */
export function findKnee(
  curve: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  options: KneedleOptions = {},
): KneePoint {
  if (curve.length === 0) {
    return { x: 0, y: 0, confidence: 'LOW' };
  }
  if (curve.length === 1) {
    return { x: curve[0]?.x, y: curve[0]?.y, confidence: 'LOW' };
  }
  if (curve.length === 2) {
    return { x: curve[0]?.x, y: curve[0]?.y, confidence: 'LOW' };
  }

  const sorted = [...curve].sort((a, b) => a.x - b.x);
  const direction: CurveDirection = options.direction ?? autoDetectDirection(sorted);

  const prepared = options.smooth === false ? sorted : isotonicSmooth(sorted, direction);

  const xMin = prepared[0]?.x;
  const xMax = prepared[prepared.length - 1]?.x;
  let yMin = prepared[0]?.y;
  let yMax = prepared[0]?.y;
  for (const p of prepared) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }

  if (xMax - xMin < VARIANCE_EPSILON || yMax - yMin < VARIANCE_EPSILON) {
    const mid = Math.floor(prepared.length / 2);
    const midOriginalIdx = findOriginalIndex(sorted, prepared[mid]?.x);
    return {
      x: sorted[midOriginalIdx]?.x,
      y: sorted[midOriginalIdx]?.y,
      confidence: 'LOW',
    };
  }

  const diffs = computeDiffs(prepared, direction, xMin, xMax, yMin, yMax);
  const maxIdx = argmax(diffs);

  const meanDiff = mean(diffs);
  const stdDiff = stdDev(diffs, meanDiff);
  const prominence =
    stdDiff < VARIANCE_EPSILON ? 0 : ((diffs[maxIdx] as number) - meanDiff) / stdDiff;
  const S = options.S ?? DEFAULT_S;

  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (prominence >= 1.5 * S) confidence = 'HIGH';
  else if (prominence >= 0.7 * S) confidence = 'MEDIUM';
  else confidence = 'LOW';

  // Reconstruct from the ORIGINAL (unsmoothed) curve so callers see the
  // observed (x, y) at the knee's x — PAV may have flattened y at that
  // index in the smoothed view, but the caller wants the raw measurement
  // to feed downstream verdict tagging.
  const kneeX = prepared[maxIdx]?.x;
  const origIdx = findOriginalIndex(sorted, kneeX);

  return {
    x: sorted[origIdx]?.x,
    y: sorted[origIdx]?.y,
    confidence,
  };
}

// ──────────────────────────── Helpers ─────────────────────────────

function autoDetectDirection(
  sorted: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): CurveDirection {
  const first = sorted[0]?.y;
  const last = sorted[sorted.length - 1]?.y;
  return last < first ? 'decreasing' : 'increasing';
}

function computeDiffs(
  curve: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  direction: CurveDirection,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
): number[] {
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const diffs: number[] = new Array(curve.length);
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i] as { readonly x: number; readonly y: number };
    const xNorm = (p.x - xMin) / xSpan;
    const yNorm = (p.y - yMin) / ySpan;
    const yOriented = direction === 'decreasing' ? 1 - yNorm : yNorm;
    diffs[i] = yOriented - xNorm;
  }
  return diffs;
}

/**
 * Pool-Adjacent-Violators monotonic smoothing. Enforces monotonicity in
 * the configured direction; preserves x-positions; replaces violating
 * adjacent runs with their length-weighted mean (the standard PAV update).
 */
export function isotonicSmooth(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  direction: CurveDirection,
): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];

  interface Block {
    start: number;
    end: number;
    sum: number;
    count: number;
  }

  const blocks: Block[] = points.map((p, i) => ({ start: i, end: i, sum: p.y, count: 1 }));

  const violates =
    direction === 'increasing'
      ? (a: Block, b: Block) => a.sum / a.count > b.sum / b.count
      : (a: Block, b: Block) => a.sum / a.count < b.sum / b.count;

  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i] as Block;
    const b = blocks[i + 1] as Block;
    if (violates(a, b)) {
      const merged: Block = {
        start: a.start,
        end: b.end,
        sum: a.sum + b.sum,
        count: a.count + b.count,
      };
      blocks.splice(i, 2, merged);
      if (i > 0) i--;
    } else {
      i++;
    }
  }

  const out: Array<{ x: number; y: number }> = new Array(points.length);
  for (const block of blocks) {
    const blockMean = block.sum / block.count;
    for (let j = block.start; j <= block.end; j++) {
      out[j] = { x: points[j]?.x, y: blockMean };
    }
  }
  return out;
}

function findOriginalIndex(
  sorted: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  targetX: number,
): number {
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]?.x === targetX) return i;
  }
  return 0;
}

function argmax(values: ReadonlyArray<number>): number {
  let bestIdx = 0;
  let best = values[0] as number;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) > best) {
      best = values[i] as number;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stdDev(values: ReadonlyArray<number>, mu: number): number {
  if (values.length === 0) return 0;
  let acc = 0;
  for (const v of values) acc += (v - mu) ** 2;
  return Math.sqrt(acc / values.length);
}
