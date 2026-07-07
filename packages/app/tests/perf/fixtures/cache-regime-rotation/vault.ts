/**
 * Shared 100-doc background corpus.
 *
 * Every cache-regime fixture (tight / broad / asymmetric) imports
 * `vault` by reference — the sweep harness can stage the 100-doc
 * background once per cell rather than re-materializing per fixture.
 * Referential identity is asserted in fixtures.test.ts.
 *
 * 15/60/25 mix — modest small/large tails with a thick
 * medium body so the sidebar + index workload exerts realistic pressure
 * on the rotation cap-vector under test.
 */

import { buildCorpus } from './generator';
import type { DocSpec, SizeMix } from './types';

/** Vault size-mix (15 small + 60 medium + 25 large = 100 docs). */
export const VAULT_MIX = {
  small: 15,
  medium: 60,
  large: 25,
} as const satisfies SizeMix;

/** Fixed seed so vault doc-specs are stable across runs. */
export const VAULT_SEED = 42;

/** Stable per-vault name prefix. */
export const VAULT_NAME_PREFIX = 'vault';

/**
 * Eagerly-generated background corpus, sealed to its readonly contract.
 *
 * The eager-at-module-load shape is intentional: the sweep harness imports
 * `vault` from multiple fixture files and the referential-identity
 * invariant in fixtures.test.ts depends on the module being a singleton.
 */
export const vault: ReadonlyArray<DocSpec> = Object.freeze(
  buildCorpus({ seed: VAULT_SEED, namePrefix: VAULT_NAME_PREFIX, mix: VAULT_MIX }),
);
