/**
 * Re-export surface for the cache-regime-rotation fixtures.
 *
 * Sweep harness consumers import { tightFixture, broadFixture,
 * asymmetricFixture, vault, WorkloadFixture, DocSpec } from this index
 * rather than reaching into the per-file modules directly.
 */

export { ASYMMETRIC_CYCLE_DURATION_MS, asymmetricFixture } from './asymmetric.ts';
export { BROAD_CYCLE_DURATION_MS, broadFixture } from './broad.ts';
export {
  buildCorpus,
  buildDocSpec,
  formatDocName,
  makePrng,
  pickContentBytes,
  pickFrontmatterDensity,
  pickImageCount,
  sampleIntInRange,
} from './generator.ts';
export { TIGHT_CYCLE_DURATION_MS, tightFixture } from './tight.ts';
export type {
  DocSpec,
  RotationPattern,
  SizeMix,
  WorkloadFixture,
  WorkloadFixtureRef,
} from './types.ts';
export { SIZE_ENVELOPES, totalDocsInMix } from './types.ts';
export { VAULT_MIX, VAULT_NAME_PREFIX, VAULT_SEED, vault } from './vault.ts';
