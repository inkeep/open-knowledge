
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
