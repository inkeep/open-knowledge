export interface KneePoint {
  readonly x: number;
  readonly y: number;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export type CurveDirection = 'increasing' | 'decreasing';

export interface KneedleOptions {
  readonly S?: number;

  readonly direction?: CurveDirection;

  readonly smooth?: boolean;
}

const DEFAULT_S = 1.0;
const VARIANCE_EPSILON = 1e-12;

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

  const kneeX = prepared[maxIdx]?.x;
  const origIdx = findOriginalIndex(sorted, kneeX);

  return {
    x: sorted[origIdx]?.x,
    y: sorted[origIdx]?.y,
    confidence,
  };
}

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
