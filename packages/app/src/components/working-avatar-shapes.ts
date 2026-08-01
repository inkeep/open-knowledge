/**
 * Shape library + morph maths for {@link WorkingAvatar}.
 *
 * Every shape is resampled to exactly {@link POINTS} points and emitted as one
 * closed cubic-Bezier path with identical command structure. That is the whole
 * trick: because all paths share structure, morphing between any two of them is
 * a straight numeric lerp over the path-data numbers — no path-diffing library
 * needed. Do not drop the resample step when adding a shape.
 *
 * Building the library needs `SVGPathElement.getTotalLength`/`getPointAtLength`,
 * which jsdom does not implement, so it happens lazily on first use behind
 * {@link getShapeLibrary} and falls back to a single static pose.
 */

/** Points per shape. Also the number of cubic segments in every emitted path. */
const POINTS = 40;

/** Shape centre in viewBox units (all shapes share `viewBox="0 0 30 30"`). */
const CX = 15;
const CY = 15;

/** Nominal shape radius the sequence entries are expressed relative to. */
const R = 12.4;

import { MASCOT_OUTLINE_PATH } from './mascot-outline';

type Point = [number, number];

/** Named indices into {@link ShapeLibrary.paths}. Sequences reference these. */
export const SHAPE = {
  blobby: 0,
  triangle: 1,
  square: 2,
  sparkle: 3,
  pentagon: 4,
  hexagon: 5,
  /** The beat between poses — everything breathes down to this and back out. */
  dot: 6,
  star5: 7,
  clover: 8,
  star6: 9,
  scallop: 10,
  comma: 11,
  diamond: 12,
  cloud: 13,
} as const;

export interface ShapeLibrary {
  /** One path string per {@link SHAPE} index, all structurally identical. */
  paths: string[];
  /** Traced marker weight at 30x30, used as the default `stroke-width`. */
  strokeWidth: number;
}

/**
 * The blobby pose, precomputed. Used when path measurement is unavailable
 * (jsdom) and as the first-paint value before the library builds. Regenerating
 * it means running {@link buildShapeLibrary} in a browser and taking `paths[0]`.
 */
export const FALLBACK_SKIN_PATH =
  'M15.34 2.91C15.96 2.77 16.69 2.65 17.33 2.63C17.97 2.62 18.72 2.71 19.36 2.84C20.00 2.97 20.79 3.10 21.33 3.44C21.88 3.79 22.38 4.46 22.75 5.01C23.12 5.56 23.42 6.30 23.66 6.89C23.90 7.49 24.06 8.18 24.26 8.73C24.45 9.28 24.66 9.84 24.89 10.34C25.12 10.84 25.39 11.36 25.68 11.85C25.97 12.34 26.46 12.87 26.71 13.41C26.96 13.94 27.12 14.61 27.26 15.21C27.39 15.80 27.54 16.52 27.55 17.14C27.56 17.76 27.43 18.47 27.30 19.09C27.16 19.71 26.99 20.43 26.72 21.01C26.46 21.58 26.05 22.20 25.64 22.69C25.22 23.17 24.65 23.63 24.15 24.02C23.66 24.41 23.09 24.82 22.55 25.14C22.02 25.45 21.39 25.74 20.84 25.99C20.28 26.25 19.65 26.52 19.08 26.70C18.50 26.89 17.83 27.05 17.23 27.15C16.63 27.26 15.95 27.34 15.34 27.37C14.73 27.39 14.03 27.40 13.42 27.33C12.81 27.26 12.12 27.10 11.54 26.92C10.95 26.73 10.30 26.47 9.75 26.18C9.20 25.90 8.62 25.51 8.11 25.15C7.61 24.80 7.06 24.37 6.60 23.94C6.15 23.52 5.68 23.00 5.28 22.52C4.89 22.03 4.47 21.45 4.13 20.92C3.79 20.38 3.41 19.75 3.16 19.16C2.91 18.57 2.68 17.86 2.56 17.23C2.45 16.60 2.42 15.85 2.45 15.21C2.48 14.56 2.60 13.83 2.76 13.22C2.93 12.60 3.18 11.91 3.47 11.35C3.77 10.80 4.24 10.23 4.63 9.75C5.01 9.27 5.45 8.74 5.89 8.34C6.34 7.95 6.93 7.61 7.40 7.27C7.88 6.94 8.38 6.57 8.83 6.25C9.29 5.93 9.79 5.56 10.27 5.25C10.75 4.95 11.29 4.61 11.81 4.33C12.32 4.05 12.92 3.74 13.49 3.52C14.05 3.29 14.73 3.05 15.34 2.91Z';

/** Marker weight the fallback pose was traced at, matching {@link FALLBACK_SKIN_PATH}. */
export const FALLBACK_STROKE_WIDTH = 2.26;

/** A comma glyph outline. `fit` samples it into the shared point structure. */
const COMMA_OUTLINE =
  'M76.4805 11.041C99.1124 7.04848 118.186 8.33731 134.31 14.4102C150.369 20.4588 164.177 31.5065 175.929 48.1846L176.446 48.9199C187.179 64.5695 195.653 90.2797 191.323 112.539C186.344 138.13 169.219 160.474 150.105 178.107C131.113 195.629 111.037 207.691 101.728 212.842C98.3779 214.693 93.3915 217.316 88.0508 217.316C85.74 217.316 83.6583 216.814 81.7607 215.855L81.3838 215.658C75.1451 212.251 73.9381 205.91 73.376 198.68L73.2705 197.222C72.953 192.5 72.5095 188.039 71.1416 184.247C69.5395 179.806 66.852 176.673 63.1406 174.227L63.1377 174.225C41.2846 159.832 21.8495 144.226 13.3828 121.439L13.3818 121.438L13.0146 120.427C5.46004 99.1404 7.95139 74.5467 20.4404 52.7568L20.4414 52.7549C33.2945 30.3176 54.4303 14.925 76.4785 11.041H76.4805Z';

/** Build one smooth closed curve through `p`. Identical command structure for
    every input, which is the precondition for numeric morphing. */
function smoothPath(p: Point[]): string {
  const tangent = (i: number): Point => {
    const a = p[(i - 1 + POINTS) % POINTS];
    const b = p[(i + 1) % POINTS];
    return [(b[0] - a[0]) * 0.16, (b[1] - a[1]) * 0.16];
  };
  let out = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`;
  for (let i = 0; i < POINTS; i++) {
    const a = p[i];
    const b = p[(i + 1) % POINTS];
    const ta = tangent(i);
    const tb = tangent((i + 1) % POINTS);
    out += `C${(a[0] + ta[0]).toFixed(2)} ${(a[1] + ta[1]).toFixed(2)} ${(b[0] - tb[0]).toFixed(2)} ${(b[1] - tb[1]).toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
  }
  return `${out}Z`;
}

/** Recentre + rescale a point cloud so its longest axis spans `target * 2`. */
function normalize(p: Point[], target: number): Point[] {
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const scale = (target * 2) / Math.max(x1 - x0, y1 - y0);
  return p.map((q) => [CX + (q[0] - (x0 + x1) / 2) * scale, CY + (q[1] - (y0 + y1) / 2) * scale]);
}

/** Pull each point toward the midpoint of its neighbours — softens inner
    corners without losing the silhouette. */
function relax(p: Point[], passes: number, strength: number): Point[] {
  let out = p;
  for (let s = 0; s < passes; s++) {
    const prev = out;
    out = prev.map((q, i): Point => {
      const a = prev[(i - 1 + POINTS) % POINTS];
      const b = prev[(i + 1) % POINTS];
      return [
        q[0] * (1 - strength) + ((a[0] + b[0]) / 2) * strength,
        q[1] * (1 - strength) + ((a[1] + b[1]) / 2) * strength,
      ];
    });
  }
  return out;
}

/** A measuring `<path>` detached from layout. Null when the platform can't
    measure paths (jsdom), which is the signal to use the static fallback. */
function createProbe(): SVGPathElement | null {
  if (typeof document === 'undefined') return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.visibility = 'hidden';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.appendChild(path);
  document.body.appendChild(svg);
  if (typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function') {
    svg.remove();
    return null;
  }
  try {
    path.setAttribute('d', 'M0 0L1 0');
    path.getPointAtLength(0);
  } catch {
    svg.remove();
    return null;
  }
  return path;
}

/** Everything below takes the probe explicitly so the library builds in one
    pass and the probe can be torn down straight after. */
function makeBuilders(probe: SVGPathElement) {
  /** Walk an arbitrary path at even arc-length intervals. */
  function sample(d: string, count: number): Point[] {
    probe.setAttribute('d', d);
    const length = probe.getTotalLength();
    const out: Point[] = [];
    for (let i = 0; i < count; i++) {
      const q = probe.getPointAtLength((length * i) / count);
      out.push([q.x, q.y]);
    }
    return out;
  }

  /** Bucket a dense sample by ray angle from the centroid. Returns the max and
      min radius seen in each of {@link POINTS} angular buckets. */
  function radialProfile(points: Point[]): { cx: number; cy: number; hi: number[]; lo: number[] } {
    let cx = 0;
    let cy = 0;
    for (const q of points) {
      cx += q[0];
      cy += q[1];
    }
    cx /= points.length;
    cy /= points.length;
    const hi = new Array<number>(POINTS).fill(0);
    const lo = new Array<number>(POINTS).fill(Number.POSITIVE_INFINITY);
    for (const q of points) {
      const angle = Math.atan2(q[1] - cy, q[0] - cx);
      const radius = Math.hypot(q[0] - cx, q[1] - cy);
      let bucket = Math.round(((angle + Math.PI / 2) / (2 * Math.PI)) * POINTS);
      bucket = ((bucket % POINTS) + POINTS) % POINTS;
      if (radius > hi[bucket]) hi[bucket] = radius;
      if (radius < lo[bucket]) lo[bucket] = radius;
    }
    return { cx, cy, hi, lo };
  }

  function polar(radii: number[], cx: number, cy: number): Point[] {
    return radii.map((r, i): Point => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / POINTS;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });
  }

  /** Reduce a marker-drawn filled outline to its centreline, and report the
      average outline thickness — that thickness is the pen weight to stroke at. */
  function silhouette(d: string, target: number): { path: string; strokeWidth: number } {
    const { cx, cy, hi, lo } = radialProfile(sample(d, 1080));
    const mid = hi.map((v, i) => (v + lo[i]) / 2);
    const thickness = hi.reduce((sum, v, i) => sum + (v - lo[i]), 0) / POINTS;
    const p = polar(mid, cx, cy);
    // `normalize` rescales the centreline, so the pen weight scales with it.
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    const scale =
      (target * 2) / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return { path: smoothPath(normalize(p, target)), strokeWidth: thickness * scale };
  }

  /** Outer hull of a multi-circle blob, lightly smoothed — turns overlapping
      circles into a cloud/teardrop rather than a lumpy union. */
  function hull(d: string, target: number): string {
    const { cx, cy, hi } = radialProfile(sample(d, 1400));
    const smoothed = hi.map(
      (_, i) => hi[i] * 0.86 + (hi[(i - 1 + POINTS) % POINTS] + hi[(i + 1) % POINTS]) * 0.07,
    );
    return smoothPath(normalize(polar(smoothed, cx, cy), target));
  }

  /** Resample an arbitrary closed path, keeping its concavities. */
  function fit(d: string, target: number): string {
    return smoothPath(normalize(sample(d, POINTS), target));
  }

  function soften(d: string, passes: number, strength: number): string {
    return smoothPath(relax(sample(d, POINTS), passes, strength));
  }

  function squeeze(d: string, sx: number, sy: number): string {
    const p = sample(d, POINTS).map((q): Point => [CX + (q[0] - CX) * sx, CY + (q[1] - CY) * sy]);
    return smoothPath(p);
  }

  /** Radial ripple applied to an existing shape so no two poses read as
      machine-drawn. `seed` picks the phase, `amp` scales the wobble. */
  function wobble(d: string, seed: number, amp = 1): string {
    const p = sample(d, POINTS).map((q, i): Point => {
      const a = (i * 2 * Math.PI) / POINTS;
      const w =
        1 +
        amp *
          (0.035 * Math.sin(a * 3 + seed) +
            0.025 * Math.sin(a * 5 + seed * 2) +
            0.018 * Math.sin(a * 2 - seed));
      return [CX + (q[0] - CX) * w, CY + (q[1] - CY) * w];
    });
    return smoothPath(p);
  }

  /** Regular polygon with rounded corners, clockwise from the top. Returns raw
      path data — callers resample it (every caller pipes it through `wobble`
      or `squeeze`, both of which sample). */
  function poly(sides: number, radius: number, round: number, rot = 0): string {
    const v: Point[] = [];
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides + rot;
      v.push([CX + Math.cos(a) * radius, CY + Math.sin(a) * radius]);
    }
    const unit = (p: Point, q: Point): Point => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy);
      return [dx / l, dy / l];
    };
    let d = '';
    for (let i = 0; i < sides; i++) {
      const cur = v[i];
      const d1 = unit(cur, v[(i - 1 + sides) % sides]);
      const d2 = unit(cur, v[(i + 1) % sides]);
      const a: Point = [cur[0] + d1[0] * round, cur[1] + d1[1] * round];
      const b: Point = [cur[0] + d2[0] * round, cur[1] + d2[1] * round];
      d += `${i ? 'L' : 'M'}${a[0].toFixed(2)} ${a[1].toFixed(2)}A${round} ${round} 0 0 1 ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
    }
    return `${d}Z`;
  }

  /** Straight-sided star, relaxed so the tips carry a marker radius. */
  function star(points: number, outer: number, inner: number, passes: number): string {
    let d = '';
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 ? inner : outer;
      d += `${i ? 'L' : 'M'}${(CX + Math.cos(a) * r).toFixed(2)} ${(CY + Math.sin(a) * r).toFixed(2)}`;
    }
    return smoothPath(normalize(relax(sample(`${d}Z`, POINTS), passes, 0.3), outer));
  }

  /** Four-point sparkle: sharp tips joined by concave curves, then relaxed. */
  function sparkle(outer: number, waist: number, passes: number): string {
    const tip = (i: number): Point => {
      const a = -Math.PI / 2 + (i * Math.PI) / 2;
      return [CX + Math.cos(a) * outer, CY + Math.sin(a) * outer];
    };
    let d = `M${tip(0)[0].toFixed(2)} ${tip(0)[1].toFixed(2)}`;
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + ((i + 0.5) * Math.PI) / 2;
      const c: Point = [CX + Math.cos(a) * waist, CY + Math.sin(a) * waist];
      const n = tip((i + 1) % 4);
      d += `Q${c[0].toFixed(2)} ${c[1].toFixed(2)} ${n[0].toFixed(2)} ${n[1].toFixed(2)}`;
    }
    return smoothPath(normalize(relax(sample(`${d}Z`, POINTS), passes, 0.34), outer));
  }

  /** Polar lobed shape. `exponent` shapes how pointy vs round the arms read. */
  function lobed(lobes: number, outer: number, inner: number, exponent: number): string {
    const p: Point[] = [];
    for (let i = 0; i < POINTS; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / POINTS;
      const f = (1 + Math.cos(lobes * (a + Math.PI / 2))) / 2;
      const r = inner + (outer - inner) * f ** exponent;
      p.push([CX + Math.cos(a) * r, CY + Math.sin(a) * r]);
    }
    return smoothPath(p);
  }

  function dot(radius: number): string {
    const p: Point[] = [];
    for (let i = 0; i < POINTS; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / POINTS;
      p.push([CX + Math.cos(a) * radius, CY + Math.sin(a) * radius]);
    }
    return smoothPath(p);
  }

  const circle = (x: number, y: number, r: number) =>
    `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

  return {
    silhouette,
    hull,
    fit,
    soften,
    squeeze,
    wobble,
    poly,
    star,
    sparkle,
    lobed,
    dot,
    circle,
  };
}

/** Build the full shape library. Needs a DOM with SVG path measurement;
    returns null where that isn't available. Exported for the generator that
    refreshes {@link FALLBACK_SKIN_PATH}. */
export function buildShapeLibrary(): ShapeLibrary | null {
  const probe = createProbe();
  if (probe === null) return null;
  try {
    const b = makeBuilders(probe);
    const blobby = b.silhouette(MASCOT_OUTLINE_PATH, 12.55);
    // Index order must match SHAPE.
    const paths = [
      blobby.path,
      b.wobble(b.poly(3, R * 1.16, R * 0.5, 0.1), 1.1),
      b.wobble(b.poly(4, R * 1.02, R * 0.44), 2.3),
      b.wobble(b.sparkle(R * 1.24, R * 0.1, 3), 3.7),
      b.wobble(b.poly(5, R * 1.0, R * 0.38), 4.9),
      b.wobble(b.poly(6, R * 0.98, R * 0.34), 6.2),
      b.wobble(b.dot(R * 0.34), 2.8),
      b.wobble(b.star(5, R * 1.14, R * 0.68, 6), 7.4),
      b.wobble(b.soften(b.lobed(4, R * 1.16, R * 0.46, 0.5), 3, 0.3), 8.1),
      b.wobble(b.star(6, R * 1.2, R * 0.42, 4), 9.3),
      b.wobble(b.lobed(8, R * 1.06, R * 0.74, 0.6), 10.5),
      b.wobble(b.soften(b.fit(COMMA_OUTLINE, R * 1.12), 3, 0.22), 11.7, 0.3),
      b.wobble(b.squeeze(b.poly(4, R * 1.3, R * 0.2), 0.84, 1), 12.9),
      b.wobble(
        b.hull(
          b.circle(10.2, 16, 4.3) +
            b.circle(15, 12, 5.5) +
            b.circle(20, 15.4, 4.4) +
            b.circle(15, 17.4, 5.2),
          12.4,
        ),
        13.6,
      ),
    ];
    return { paths, strokeWidth: blobby.strokeWidth };
  } finally {
    probe.ownerSVGElement?.remove();
  }
}

let cachedLibrary: ShapeLibrary | null | undefined;

/** Build-once accessor. Null means path measurement is unavailable and callers
    should render {@link FALLBACK_SKIN_PATH} statically. */
export function getShapeLibrary(): ShapeLibrary | null {
  if (cachedLibrary === undefined) cachedLibrary = buildShapeLibrary();
  return cachedLibrary;
}

/* -------------------------------------------------------------------------- */
/*  Morphing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Split every path into its literal command fragments plus a flat number list.
 * The fragments are identical across shapes (same command structure), so
 * rebuilding a morphed path is `fragments[i] + lerped[i]` all the way down.
 */
export interface MorphSource {
  fragments: string[];
  numbers: number[][];
}

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

export function toMorphSource(paths: string[]): MorphSource {
  return {
    fragments: paths[0].split(NUMBER_RE),
    numbers: paths.map((d) => (d.match(NUMBER_RE) ?? []).map(Number)),
  };
}

export function buildMorphedPath(fragments: string[], values: number[]): string {
  let out = '';
  for (let i = 0; i < values.length; i++) out += fragments[i] + values[i].toFixed(2);
  return out + fragments[values.length];
}

/** Symmetric ease used for every segment. */
export function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
}

/** Fraction of a segment the morph occupies when `hold` is on. The remainder
    is dead still — that pause is what gives each pose a beat. */
const HOLD_MORPH_FRACTION = 0.58;

export interface MorphFrame {
  /** Index into the sequence of the pose being morphed away from. */
  from: number;
  /** Index into the sequence of the pose being morphed toward. */
  to: number;
  /** Eased 0..1 progress between them. */
  t: number;
}

/**
 * Where in the sequence we are at `elapsedSeconds`. Pure — the rAF loop and the
 * tests both go through this.
 */
export function morphFrameAt(
  elapsedSeconds: number,
  sequenceLength: number,
  durationSeconds: number,
  hold: boolean,
): MorphFrame {
  const segments = sequenceLength - 1;
  const segmentDuration = durationSeconds / segments;
  const t = elapsedSeconds % durationSeconds;
  const index = Math.max(0, Math.min(segments - 1, Math.floor(t / segmentDuration)));
  const local = (t % segmentDuration) / segmentDuration;
  return {
    from: index,
    to: index + 1,
    t: ease(hold ? Math.min(1, local / HOLD_MORPH_FRACTION) : local),
  };
}

/* -------------------------------------------------------------------------- */
/*  Sequence                                                                   */
/* -------------------------------------------------------------------------- */

const S = SHAPE;

/**
 * The poses the mascot cycles through, starting and ending at home so the loop
 * closes seamlessly. Retunable from the full {@link SHAPE} palette — the
 * library builds every entry, not just the ones used here, so swapping a pose
 * costs one edit.
 */
export const POSE_SEQUENCE = [
  S.blobby,
  S.triangle,
  S.square,
  S.sparkle,
  S.comma,
  S.pentagon,
  S.hexagon,
  S.blobby,
];

/**
 * Per-shape eye offset in viewBox units, lerped along with the morph. The
 * comma's body sits high, so without this the face floats off the body.
 */
export const EYE_OFFSET_Y: Record<number, number> = { [S.comma]: -2.9 };

/** Resting eye geometry, in viewBox units. */
export const EYE = { leftCx: 10.9, rightCx: 18.1, cy: 16, rx: 1.25, ry: 1.9 } as const;
