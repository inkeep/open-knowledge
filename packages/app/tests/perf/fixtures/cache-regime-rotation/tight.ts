
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
