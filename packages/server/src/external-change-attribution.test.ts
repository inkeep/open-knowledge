import { beforeEach, describe, expect, test } from 'vitest';
import {
  claimExternalChange,
  clearExternalChangeClaims,
  releaseExternalChangeClaim,
  takeExternalChangeAttribution,
} from './external-change-attribution.ts';

const ALICE = {
  writerId: 'principal-11111111-1111-1111-1111-111111111111',
  displayName: 'Alice',
  colorSeed: 'principal-11111111-1111-1111-1111-111111111111',
};
const BOB = {
  writerId: 'principal-22222222-2222-2222-2222-222222222222',
  displayName: 'Bob',
  colorSeed: 'principal-22222222-2222-2222-2222-222222222222',
};

const T0 = 1_000_000;

beforeEach(() => {
  clearExternalChangeClaims();
});

describe('external-change attribution claims', () => {
  test('a claimed doc attributes to the claiming writer', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 100)).toEqual(ALICE);
  });

  test('an unclaimed doc yields nothing, so the caller keeps file-system attribution', () => {
    expect(takeExternalChangeAttribution('notes/untouched', T0)).toBeUndefined();
  });

  test('a claim is single-use', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 100)).toEqual(ALICE);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 200)).toBeUndefined();
  });

  test('an expired claim yields nothing rather than a stale name', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 60_000)).toBeUndefined();
  });

  test('claims are per-doc', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    claimExternalChange('notes/pricing', BOB, T0);
    expect(takeExternalChangeAttribution('notes/pricing', T0 + 100)).toEqual(BOB);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 100)).toEqual(ALICE);
  });

  test('a re-claim on one doc takes the later actor', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    claimExternalChange('notes/roadmap', BOB, T0 + 10);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 100)).toEqual(BOB);
  });

  test('unconsumed claims cannot grow without bound', () => {
    for (let i = 0; i < 400; i += 1) {
      claimExternalChange(`notes/doc-${i}`, ALICE, T0);
    }
    expect(takeExternalChangeAttribution('notes/doc-399', T0 + 100)).toEqual(ALICE);
    expect(takeExternalChangeAttribution('notes/doc-0', T0 + 100)).toBeUndefined();
  });
});

describe('releasing a claim whose write never landed', () => {
  test('a released claim does not credit the next external change', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    releaseExternalChangeClaim('notes/roadmap');
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 100)).toBeUndefined();
  });

  test('releasing one doc leaves other claims standing', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    claimExternalChange('notes/pricing', BOB, T0);
    releaseExternalChangeClaim('notes/roadmap');
    expect(takeExternalChangeAttribution('notes/pricing', T0 + 100)).toEqual(BOB);
  });

  test('releasing an unclaimed doc is a no-op', () => {
    expect(() => releaseExternalChangeClaim('notes/never-claimed')).not.toThrow();
  });
});

describe('a claim window sized to its own write', () => {
  test('a caller-supplied window expires the claim ahead of the default', () => {
    claimExternalChange('notes/roadmap', ALICE, T0, 3_000);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 5_000)).toBeUndefined();
  });

  test('a write inside the window is still attributed', () => {
    claimExternalChange('notes/roadmap', ALICE, T0, 3_000);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 500)).toEqual(ALICE);
  });

  test('omitting the window keeps the default', () => {
    claimExternalChange('notes/roadmap', ALICE, T0);
    expect(takeExternalChangeAttribution('notes/roadmap', T0 + 5_000)).toEqual(ALICE);
  });
});
