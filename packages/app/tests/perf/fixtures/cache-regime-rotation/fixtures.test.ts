import { describe, expect, test } from 'bun:test';
import { ASYMMETRIC_CYCLE_DURATION_MS, asymmetricFixture } from './asymmetric.ts';
import { BROAD_CYCLE_DURATION_MS, broadFixture } from './broad.ts';
import { TIGHT_CYCLE_DURATION_MS, tightFixture } from './tight.ts';
import type { WorkloadFixture } from './types.ts';
import { SIZE_ENVELOPES } from './types.ts';
import { vault } from './vault.ts';

const ALL_FIXTURES: ReadonlyArray<WorkloadFixture> = [
  tightFixture,
  broadFixture,
  asymmetricFixture,
];

describe('rotationDocs length matches documented count', () => {
  test('tight: 8 docs (2 small + 4 medium + 2 large)', () => {
    expect(tightFixture.rotationDocs.length).toBe(8);
    expect(tightFixture.rotationDocs.filter((d) => d.sizeClass === 'small')).toHaveLength(2);
    expect(tightFixture.rotationDocs.filter((d) => d.sizeClass === 'medium')).toHaveLength(4);
    expect(tightFixture.rotationDocs.filter((d) => d.sizeClass === 'large')).toHaveLength(2);
  });

  test('broad: 60 docs (10 small + 30 medium + 20 large)', () => {
    expect(broadFixture.rotationDocs.length).toBe(60);
    expect(broadFixture.rotationDocs.filter((d) => d.sizeClass === 'small')).toHaveLength(10);
    expect(broadFixture.rotationDocs.filter((d) => d.sizeClass === 'medium')).toHaveLength(30);
    expect(broadFixture.rotationDocs.filter((d) => d.sizeClass === 'large')).toHaveLength(20);
  });

  test('asymmetric: 6 docs (1 large + 5 small)', () => {
    expect(asymmetricFixture.rotationDocs.length).toBe(6);
    expect(asymmetricFixture.rotationDocs.filter((d) => d.sizeClass === 'small')).toHaveLength(5);
    expect(asymmetricFixture.rotationDocs.filter((d) => d.sizeClass === 'medium')).toHaveLength(0);
    expect(asymmetricFixture.rotationDocs.filter((d) => d.sizeClass === 'large')).toHaveLength(1);
  });
});

describe('shared vault — referential identity across fixtures', () => {
  test('all fixtures point at the same vault array instance', () => {
    expect(tightFixture.vault).toBe(vault);
    expect(broadFixture.vault).toBe(vault);
    expect(asymmetricFixture.vault).toBe(vault);
  });
});

describe('contentBytes envelope conformance', () => {
  test('every rotation doc across fixtures stays within its size envelope', () => {
    for (const fixture of ALL_FIXTURES) {
      for (const doc of fixture.rotationDocs) {
        const env = SIZE_ENVELOPES[doc.sizeClass];
        expect(doc.contentBytes).toBeGreaterThanOrEqual(env.minBytes);
        expect(doc.contentBytes).toBeLessThanOrEqual(env.maxBytes);
      }
    }
  });
});

describe('rotation pattern + ref pairing', () => {
  test('tight is hot-pocket', () => {
    expect(tightFixture.rotationPattern).toBe('hot-pocket');
    expect(tightFixture.ref).toBe('tight');
  });

  test('broad is random-eviction', () => {
    expect(broadFixture.rotationPattern).toBe('random-eviction');
    expect(broadFixture.ref).toBe('broad');
  });

  test('asymmetric is hot-pocket with skewed working set', () => {
    expect(asymmetricFixture.rotationPattern).toBe('hot-pocket');
    expect(asymmetricFixture.ref).toBe('asymmetric');
  });
});

describe('cycleDurationMs envelopes per D20 LOCKED', () => {
  test('tight envelope is 20 minutes (4 min × 5 cycles)', () => {
    const fourMinutes = 4 * 60 * 1000;
    const fiveCycles = 5;
    expect(TIGHT_CYCLE_DURATION_MS).toBe(fourMinutes * fiveCycles);
    expect(tightFixture.cycleDurationMs).toBe(TIGHT_CYCLE_DURATION_MS);
  });

  test('broad envelope is 20 minutes (30s × 60 docs)', () => {
    const thirtySeconds = 30 * 1000;
    const sixtyDocs = 60;
    expect(BROAD_CYCLE_DURATION_MS).toBe(thirtySeconds * sixtyDocs);
    expect(broadFixture.cycleDurationMs).toBe(BROAD_CYCLE_DURATION_MS);
  });

  test('asymmetric envelope is 5 minutes', () => {
    expect(ASYMMETRIC_CYCLE_DURATION_MS).toBe(5 * 60 * 1000);
    expect(asymmetricFixture.cycleDurationMs).toBe(ASYMMETRIC_CYCLE_DURATION_MS);
  });
});

describe('determinism — fixture seeds reproduce', () => {
  test('rotationDocs are deeply-equal across module re-imports (cached singletons)', async () => {
    const reimport = await import('./tight.ts');
    expect(reimport.tightFixture.rotationDocs).toEqual([...tightFixture.rotationDocs]);
  });
});

describe('cross-fixture distinct seeds', () => {
  test('each fixture has a unique seed so its rotationDocs are independent of the others', () => {
    const seeds = new Set(ALL_FIXTURES.map((f) => f.seed));
    expect(seeds.size).toBe(ALL_FIXTURES.length);
  });
});
