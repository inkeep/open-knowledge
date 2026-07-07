/**
 * Asymmetric fixture — 6-doc skewed-working-set, 5-minute envelope.
 *
 * 1 large PROJECT-class doc visited many times + 5 small docs visited
 * once each. The constraint-varied shape that surfaces
 * cap-vector divergence the symmetric fixtures hide — the pganalyze
 * TPROC-C/H smoking gun: same architecture, same knob, opposite-shaped
 * curves on different workload skew. If the verdict picks a different
 * cap-vector for asymmetric than for tight+broad, the sweep runner
 * flags it for per-cap-shipping consideration.
 *
 * rotationDocs is built with buildCorpus's small→large ordering
 * (small-001..small-005, large-001). The sweep runner finds the hot
 * doc by `sizeClass === 'large'`, not by index — so the layout here
 * follows the corpus convention rather than a fixture-specific override.
 *
 * Size mix: 5 small / 0 medium / 1 large = 6 docs.
 */

import { buildCorpus } from './generator';
import type { SizeMix, WorkloadFixture } from './types';
import { vault } from './vault';

const ASYMMETRIC_MIX = {
  small: 5,
  medium: 0,
  large: 1,
} as const satisfies SizeMix;

const ASYMMETRIC_SEED = 3003;
const ASYMMETRIC_NAME_PREFIX = 'asymmetric';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** 5 min envelope dominated by repeated visits to the single large doc. */
export const ASYMMETRIC_CYCLE_DURATION_MS = FIVE_MINUTES_MS;

export const asymmetricFixture: WorkloadFixture = Object.freeze({
  ref: 'asymmetric',
  rotationDocs: Object.freeze(
    buildCorpus({ seed: ASYMMETRIC_SEED, namePrefix: ASYMMETRIC_NAME_PREFIX, mix: ASYMMETRIC_MIX }),
  ),
  rotationPattern: 'hot-pocket',
  cycleDurationMs: ASYMMETRIC_CYCLE_DURATION_MS,
  vault,
  seed: ASYMMETRIC_SEED,
});
