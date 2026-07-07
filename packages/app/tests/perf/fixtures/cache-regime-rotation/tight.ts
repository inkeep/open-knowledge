/**
 * Tight fixture — 8-doc hot-pocket rotation, 20-minute total envelope.
 *
 * Tests the small-working-set regime where every doc in the rotation
 * should plausibly stay cache-resident across the cycle. Sub-cycle
 * intent is "visit each over ~4 min, cycle ~5×" so
 * the sweep harness sees warm-reopen hit rates dominate.
 *
 * Size mix: 2 small / 4 medium / 2 large = 8 docs.
 */

import { buildCorpus } from './generator';
import type { SizeMix, WorkloadFixture } from './types';
import { vault } from './vault';

const TIGHT_MIX = {
  small: 2,
  medium: 4,
  large: 2,
} as const satisfies SizeMix;

const TIGHT_SEED = 1001;
const TIGHT_NAME_PREFIX = 'tight';
const FOUR_MINUTES_MS = 4 * 60 * 1000;
const FIVE_CYCLES = 5;

/**
 * 20 min total envelope: ~4 min visit-each pass × 5 sub-cycles.
 * The cycle-count semantics live with the sweep runner; the fixture
 * declares the total time window only.
 */
export const TIGHT_CYCLE_DURATION_MS = FOUR_MINUTES_MS * FIVE_CYCLES;

export const tightFixture: WorkloadFixture = Object.freeze({
  ref: 'tight',
  rotationDocs: Object.freeze(
    buildCorpus({ seed: TIGHT_SEED, namePrefix: TIGHT_NAME_PREFIX, mix: TIGHT_MIX }),
  ),
  rotationPattern: 'hot-pocket',
  cycleDurationMs: TIGHT_CYCLE_DURATION_MS,
  vault,
  seed: TIGHT_SEED,
});
