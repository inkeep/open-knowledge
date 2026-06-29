import { buildCorpus } from './generator';
import type { SizeMix, WorkloadFixture } from './types';
import { vault } from './vault';

const BROAD_MIX = {
  small: 10,
  medium: 30,
  large: 20,
} as const satisfies SizeMix;

const BROAD_SEED = 2002;
const BROAD_NAME_PREFIX = 'broad';
const THIRTY_SECONDS_MS = 30 * 1000;
const BROAD_DOC_COUNT = 60;

export const BROAD_CYCLE_DURATION_MS = THIRTY_SECONDS_MS * BROAD_DOC_COUNT;

export const broadFixture: WorkloadFixture = Object.freeze({
  ref: 'broad',
  rotationDocs: Object.freeze(
    buildCorpus({ seed: BROAD_SEED, namePrefix: BROAD_NAME_PREFIX, mix: BROAD_MIX }),
  ),
  rotationPattern: 'random-eviction',
  cycleDurationMs: BROAD_CYCLE_DURATION_MS,
  vault,
  seed: BROAD_SEED,
});
