/**
 * Re-export surface for the cache-regime-rotation fixtures.
 *
 * Sweep harness consumers import { tightFixture, broadFixture,
 * asymmetricFixture, vault, WorkloadFixture, DocSpec } from this index
 * rather than reaching into the per-file modules directly.
 */

export { ASYMMETRIC_CYCLE_DURATION_MS, asymmetricFixture } from './asymmetric';
export { BROAD_CYCLE_DURATION_MS, broadFixture } from './broad';
export {
  buildCorpus,
  buildDocSpec,
  formatDocName,
  makePrng,
  pickContentBytes,
  pickFrontmatterDensity,
  pickImageCount,
  sampleIntInRange,
} from './generator';
export { TIGHT_CYCLE_DURATION_MS, tightFixture } from './tight';
export type {
  DocSpec,
  RotationPattern,
  SizeMix,
  WorkloadFixture,
  WorkloadFixtureRef,
} from './types';
export { SIZE_ENVELOPES, totalDocsInMix } from './types';
export { VAULT_MIX, VAULT_NAME_PREFIX, VAULT_SEED, vault } from './vault';
