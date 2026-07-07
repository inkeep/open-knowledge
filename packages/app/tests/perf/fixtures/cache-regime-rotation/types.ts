/**
 * Workload-fixture types for the cap-graduation cache-regime sweep harness.
 *
 * Three fixtures (tight / broad / asymmetric) plus a shared 100-doc vault
 * back the parallel-design verdict-robustness check — the
 * sweep harness considers the winning cap-vector defensible only if its
 * verdict is consistent across all three working-set shapes.
 *
 * `WorkloadFixture` carries the descriptive metadata the sweep runner
 * needs to schedule visits + the corpus the rotation touches. The visit
 * schedule itself (how the runner orders + revisits docs over the cycle
 * window) is the runner's responsibility, not the fixture's.
 */

/** Discriminator tag for the three parallel-design fixtures. */
export type WorkloadFixtureRef = 'tight' | 'broad' | 'asymmetric';

/**
 * Three-cap regime under test: MAX_POOL (ProviderPool warm-back size),
 * MAX_CACHE (V2 editor cache size), ACTIVITY_MOUNT_LIMIT (concurrent
 * Activity-mounted editors). The three caps are coupled per the
 * editor-cache architectural invariant — the sweep harness sweeps them
 * jointly with the cap-ordering constraint (per-cap with prior-stage
 * winner pinned).
 *
 * Canonical home for this shape — both the sweep runner (orchestration)
 * and cell-measurement library (instrumentation) import it from here so
 * adding a fourth coupled cap is a one-file edit.
 */
export interface CapRegime {
  readonly maxPool: number;
  readonly maxCache: number;
  readonly activityMountLimit: number;
}

/**
 * Rotation pattern the sweep runner applies over `rotationDocs`.
 *
 * - `hot-pocket` — high reuse rate on a bounded working set (cycle the
 *   rotation set with revisits). Tight + asymmetric both use this; the
 *   asymmetric working set is just heavily skewed toward one entry.
 * - `random-eviction` — sampling without intentional reuse, sized to
 *   guarantee eviction at every cap value the sweep covers (broad).
 */
export type RotationPattern = 'hot-pocket' | 'random-eviction';

/**
 * Per-doc envelope. `contentBytes` is the synthetic body size (UTF-8
 * bytes) the sweep harness materializes when it stages this doc; the
 * actual on-disk byte count includes frontmatter + image-shortcode
 * overhead the harness adds at materialization time.
 *
 * `large` envelope anchors at the defer-mount threshold so PROJECT-class
 * cells exercise the lazy-mount code path (LARGE_DOC_CHAR_THRESHOLD =
 * 500_000 in EditorActivityPool.tsx).
 */
export interface DocSpec {
  readonly name: string;
  readonly sizeClass: 'small' | 'medium' | 'large';
  readonly frontmatterDensity: 'none' | 'minimal' | 'heavy';
  readonly imageCount: number;
  readonly contentBytes: number;
}

/**
 * The design-contract shape.
 *
 * `vault` is shared by reference across all three fixtures so the sweep
 * runner can stage the background corpus once per harness invocation
 * rather than re-materializing 100 docs per fixture.
 */
export interface WorkloadFixture {
  readonly ref: WorkloadFixtureRef;
  readonly rotationDocs: ReadonlyArray<DocSpec>;
  readonly rotationPattern: RotationPattern;
  readonly cycleDurationMs: number;
  readonly vault: ReadonlyArray<DocSpec>;
  readonly seed: number;
}

/** Size-class byte envelopes. Used by the generator + calibration script. */
export const SIZE_ENVELOPES = {
  small: { minBytes: 500, maxBytes: 5_000 },
  medium: { minBytes: 5_000, maxBytes: 50_000 },
  large: { minBytes: 50_000, maxBytes: 500_000 },
} as const satisfies Record<DocSpec['sizeClass'], { minBytes: number; maxBytes: number }>;

/** Convenience tuple for fixture/vault size-mix declarations. */
export interface SizeMix {
  readonly small: number;
  readonly medium: number;
  readonly large: number;
}

export function totalDocsInMix(mix: SizeMix): number {
  return mix.small + mix.medium + mix.large;
}
