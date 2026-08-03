import { describe, expect, test } from 'vitest';
import {
  deriveReleaseStamp,
  formatOutputLines,
  parseReleaseTag,
  previousStableTag,
} from './derive-release-stamp.mjs';

// The real tag sequence around the measured mis-stamps, read off the mirror.
// Note that v0.36.0 was cut BEFORE the v0.35.2-v0.35.6 point releases; version
// order and cut order genuinely disagree here, which is what made the predicted
// identity unsafe in the first place.
const TAGS = [
  'v0.35.0',
  'v0.35.1',
  'v0.35.2',
  'v0.35.3',
  'v0.35.4',
  'v0.35.5',
  'v0.35.6',
  'v0.36.0',
  'v0.42.0',
  'v0.43.0',
  'v0.43.1',
  'v0.44.0',
  'v0.45.0',
  'v0.45.1',
  'v0.45.2',
  'v0.45.3',
  'v0.45.4',
  'v0.45.5',
  'v0.46.0',
  // Betas share the namespace and must never be mistaken for a stable boundary.
  'v0.45.4-beta.1',
  'v0.46.0-beta.1',
  'v0.46.0-beta.2',
  'v0.46.0-beta.3',
];

const noPreviousTag = () => null;

describe('parseReleaseTag', () => {
  test('a beta keeps its prerelease suffix in the release identity', () => {
    expect(parseReleaseTag('v0.46.0-beta.3')).toEqual({
      channel: 'beta',
      version: '0.46.0-beta.3',
      name: 'v0.46.0-beta.3',
    });
  });

  test('a stable yields the bare version', () => {
    expect(parseReleaseTag('v0.46.1')).toEqual({
      channel: 'stable',
      version: '0.46.1',
      name: 'v0.46.1',
    });
  });

  test('a beta identity is never the bare base version', () => {
    // The defect being fixed: `${TAG#v}` then `${V%%-beta.*}` collapsed every
    // beta of a cycle onto a predicted stable that had not been computed yet.
    for (const tag of ['v0.46.0-beta.1', 'v0.46.0-beta.2', 'v0.46.0-beta.3']) {
      expect(parseReleaseTag(tag).version).not.toBe('0.46.0');
    }
    // ...and distinct betas stay distinct rather than collapsing together.
    const versions = ['v0.46.0-beta.1', 'v0.46.0-beta.2', 'v0.46.0-beta.3'].map(
      (t) => parseReleaseTag(t).version,
    );
    expect(new Set(versions).size).toBe(3);
  });

  test('double-digit prerelease counters parse', () => {
    expect(parseReleaseTag('v0.46.0-beta.12').version).toBe('0.46.0-beta.12');
  });

  test.each([
    ['nonsense'],
    [''],
    ['0.46.0'],
    ['v0.46'],
    ['v0.46.0-rc.1'],
    ['v0.46.0-beta'],
    ['v0.46.0-beta.x'],
  ])('refuses %j rather than guessing an identity', (bad) => {
    expect(() => parseReleaseTag(bad)).toThrow();
  });
});

describe('previousStableTag', () => {
  test('skips betas to find the previous production boundary', () => {
    // v0.45.4-beta.1 sits between them and must not be chosen.
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.5' })).toBe('v0.45.4');
  });

  test('orders numerically, not lexicographically', () => {
    const tags = ['v0.9.0', 'v0.10.0', 'v0.11.0'];
    // A string sort would put v0.9.0 above v0.10.0 and pick the wrong bound.
    expect(previousStableTag({ tags, tag: 'v0.11.0' })).toBe('v0.10.0');
    expect(previousStableTag({ tags, tag: 'v0.10.0' })).toBe('v0.9.0');
  });

  test('reaches the previous stable across a whole beta cycle', () => {
    // The range a stable promotion must scan: everything since the last stable,
    // not merely since the most recent beta.
    expect(previousStableTag({ tags: TAGS, tag: 'v0.46.0' })).toBe('v0.45.5');
  });

  test('returns null for the first stable ever', () => {
    expect(previousStableTag({ tags: ['v0.1.0'], tag: 'v0.1.0' })).toBeNull();
    expect(previousStableTag({ tags: [], tag: 'v0.1.0' })).toBeNull();
  });

  test('ignores non-release refs sharing the v* namespace', () => {
    const tags = ['v0.45.4', 'vendor-snapshot', 'v0.45.4-beta.9', 'v0.45.5'];
    expect(previousStableTag({ tags, tag: 'v0.45.5' })).toBe('v0.45.4');
  });

  test('refuses to answer for a beta tag', () => {
    // Betas take the describe-based bound; asking here would silently return a
    // production boundary for a non-production cut.
    expect(() => previousStableTag({ tags: TAGS, tag: 'v0.46.0-beta.1' })).toThrow();
  });
});

describe('deriveReleaseStamp', () => {
  test('a beta scans only its own new commits', () => {
    expect(
      deriveReleaseStamp({
        tag: 'v0.46.0-beta.3',
        tags: TAGS,
        describePreviousTag: () => 'v0.46.0-beta.2',
      }),
    ).toEqual({
      channel: 'beta',
      version: '0.46.0-beta.3',
      name: 'v0.46.0-beta.3',
      baseRef: 'v0.46.0-beta.2',
    });
  });

  test('a stable scans back to the previous stable, ignoring describe', () => {
    const stamp = deriveReleaseStamp({
      tag: 'v0.46.0',
      tags: TAGS,
      // `git describe` would answer with the nearest beta; the stable path must
      // not consult it, or the promotion would miss earlier betas' tickets.
      describePreviousTag: () => 'v0.46.0-beta.3',
    });
    expect(stamp.baseRef).toBe('v0.45.5');
    expect(stamp.channel).toBe('stable');
  });

  test('the first tag ever yields an empty bound rather than a wrong one', () => {
    expect(
      deriveReleaseStamp({
        tag: 'v0.1.0-beta.1',
        tags: [],
        describePreviousTag: noPreviousTag,
      }).baseRef,
    ).toBeNull();
  });

  test('a malformed tag fails loud before any git work', () => {
    expect(() =>
      deriveReleaseStamp({
        tag: 'not-a-tag',
        tags: TAGS,
        describePreviousTag: () => {
          throw new Error('describe must not run for an unparseable tag');
        },
      }),
    ).toThrow(/unrecognized release tag/);
  });
});

describe('formatOutputLines', () => {
  test('an absent lower bound emits an EMPTY base_ref, not a placeholder', () => {
    // The sync action reads empty as "use your own default". A placeholder such
    // as HEAD would narrow a first-ever scan to nothing.
    const lines = formatOutputLines({
      channel: 'beta',
      version: '0.1.0-beta.1',
      name: 'v0.1.0-beta.1',
      baseRef: null,
    });
    expect(lines).toContain('base_ref=');
    expect(lines.some((l) => l.startsWith('base_ref=') && l.length > 'base_ref='.length)).toBe(
      false,
    );
  });

  test('emits every key the workflow steps read', () => {
    expect(
      formatOutputLines({
        channel: 'stable',
        version: '0.46.1',
        name: 'v0.46.1',
        baseRef: 'v0.45.5',
      }),
    ).toEqual(['channel=stable', 'version=0.46.1', 'name=v0.46.1', 'base_ref=v0.45.5']);
  });
});

describe('regressions from the measured mis-stamps', () => {
  // Each case is a real attachment that landed on the wrong release because the
  // identity came from a predicted stable version instead of the cut tag.
  test.each([
    // A beta cut that predicted 0.42.0; the fix actually shipped in v0.43.0.
    ['v0.42.0-beta.1', '0.42.0-beta.1', 'v0.41.4'],
    // Predicted 0.43.0; actually shipped in v0.45.0.
    ['v0.43.0-beta.2', '0.43.0-beta.2', 'v0.43.0-beta.1'],
    // Predicted 0.45.5; actually shipped in v0.46.0.
    ['v0.45.5-beta.1', '0.45.5-beta.1', 'v0.45.4'],
    // Each `expected` is deliberately NOT the stripped stable base that the old
    // `${V%%-beta.*}` expansion produced, which is what mis-attributed these.
  ])('%s stamps its own tag, not the predicted stable', (tag, expected, previous) => {
    const stamp = deriveReleaseStamp({
      tag,
      tags: TAGS,
      describePreviousTag: () => previous,
    });
    // Pin the whole shape: the fix is both the identity AND the scan boundary,
    // and asserting only the version would let a broken bound through.
    expect(stamp).toEqual({
      channel: 'beta',
      version: expected,
      name: tag,
      baseRef: previous,
    });
  });

  test('a point release bounds on its immediate stable predecessor', () => {
    // The 0.45.x point releases form a chain. Each must bound on the one before
    // it, so its scan covers only what it actually adds — not the whole 0.45
    // line back to the minor.
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.4' })).toBe('v0.45.3');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.3' })).toBe('v0.45.2');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.1' })).toBe('v0.45.0');
  });
});
