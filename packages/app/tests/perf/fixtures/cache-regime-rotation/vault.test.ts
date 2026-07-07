import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildCorpus } from './generator';
import { SIZE_ENVELOPES, totalDocsInMix } from './types';
import { VAULT_MIX, VAULT_NAME_PREFIX, VAULT_SEED, vault } from './vault';

function sha256OfCorpus(docs: ReadonlyArray<unknown>): string {
  // Stable serialization: explicit key order so the digest doesn't drift
  // if a future TypeScript pass reorders object literals.
  const stable = docs.map((d) => {
    const spec = d as {
      name: string;
      sizeClass: string;
      frontmatterDensity: string;
      imageCount: number;
      contentBytes: number;
    };
    return [
      spec.name,
      spec.sizeClass,
      spec.frontmatterDensity,
      spec.imageCount,
      spec.contentBytes,
    ].join('|');
  });
  return createHash('sha256').update(stable.join('\n')).digest('hex');
}

describe('vault — shape', () => {
  test('contains 100 docs per VAULT_MIX', () => {
    expect(vault.length).toBe(totalDocsInMix(VAULT_MIX));
    expect(vault.length).toBe(100);
  });

  test('size mix matches the 15/60/25 declaration in D20 LOCKED', () => {
    const counts = { small: 0, medium: 0, large: 0 };
    for (const doc of vault) counts[doc.sizeClass] += 1;
    expect(counts.small).toBe(VAULT_MIX.small);
    expect(counts.medium).toBe(VAULT_MIX.medium);
    expect(counts.large).toBe(VAULT_MIX.large);
  });

  test('every doc has contentBytes within its size envelope', () => {
    for (const doc of vault) {
      const env = SIZE_ENVELOPES[doc.sizeClass];
      expect(doc.contentBytes).toBeGreaterThanOrEqual(env.minBytes);
      expect(doc.contentBytes).toBeLessThanOrEqual(env.maxBytes);
    }
  });

  test('every doc name uses the vault prefix and is unique', () => {
    const names = new Set<string>();
    for (const doc of vault) {
      expect(doc.name.startsWith(`${VAULT_NAME_PREFIX}-`)).toBe(true);
      expect(names.has(doc.name)).toBe(false);
      names.add(doc.name);
    }
    expect(names.size).toBe(vault.length);
  });

  test('exposed array is frozen', () => {
    expect(Object.isFrozen(vault)).toBe(true);
  });
});

describe('vault — determinism', () => {
  test('rebuild with same seed produces deeply-equal corpus', () => {
    const rebuilt = buildCorpus({
      seed: VAULT_SEED,
      namePrefix: VAULT_NAME_PREFIX,
      mix: VAULT_MIX,
    });
    expect(rebuilt).toEqual([...vault]);
  });

  test('sha256 of the corpus is stable across builds (byte-identical contract)', () => {
    const digestA = sha256OfCorpus(vault);
    const digestB = sha256OfCorpus(
      buildCorpus({ seed: VAULT_SEED, namePrefix: VAULT_NAME_PREFIX, mix: VAULT_MIX }),
    );
    expect(digestA).toBe(digestB);
  });

  test('different seeds produce different sha256 digests', () => {
    const digestVault = sha256OfCorpus(vault);
    const digestOther = sha256OfCorpus(
      buildCorpus({ seed: VAULT_SEED + 1, namePrefix: VAULT_NAME_PREFIX, mix: VAULT_MIX }),
    );
    expect(digestOther).not.toBe(digestVault);
  });
});
