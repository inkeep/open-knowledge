import { buildCorpus } from './generator';
import type { DocSpec, SizeMix } from './types';

export const VAULT_MIX = {
  small: 15,
  medium: 60,
  large: 25,
} as const satisfies SizeMix;

export const VAULT_SEED = 42;

export const VAULT_NAME_PREFIX = 'vault';

export const vault: ReadonlyArray<DocSpec> = Object.freeze(
  buildCorpus({ seed: VAULT_SEED, namePrefix: VAULT_NAME_PREFIX, mix: VAULT_MIX }),
);
