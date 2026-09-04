import { describe, expect, test } from 'vitest';
import {
  deriveReleaseStamp,
  formatOutputLines,
  parseReleaseTag,
  previousStableTag,
} from './derive-release-stamp.mjs';

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
    for (const tag of ['v0.46.0-beta.1', 'v0.46.0-beta.2', 'v0.46.0-beta.3']) {
      expect(parseReleaseTag(tag).version).not.toBe('0.46.0');
    }
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
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.5' })).toBe('v0.45.4');
  });

  test('orders numerically, not lexicographically', () => {
    const tags = ['v0.9.0', 'v0.10.0', 'v0.11.0'];
    expect(previousStableTag({ tags, tag: 'v0.11.0' })).toBe('v0.10.0');
    expect(previousStableTag({ tags, tag: 'v0.10.0' })).toBe('v0.9.0');
  });

  test('reaches the previous stable across a whole beta cycle', () => {
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
  test.each([
    ['v0.42.0-beta.1', '0.42.0-beta.1', 'v0.41.4'],
    ['v0.43.0-beta.2', '0.43.0-beta.2', 'v0.43.0-beta.1'],
    ['v0.45.5-beta.1', '0.45.5-beta.1', 'v0.45.4'],
  ])('%s stamps its own tag, not the predicted stable', (tag, expected, previous) => {
    const stamp = deriveReleaseStamp({
      tag,
      tags: TAGS,
      describePreviousTag: () => previous,
    });
    expect(stamp).toEqual({
      channel: 'beta',
      version: expected,
      name: tag,
      baseRef: previous,
    });
  });

  test('a point release bounds on its immediate stable predecessor', () => {
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.4' })).toBe('v0.45.3');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.3' })).toBe('v0.45.2');
    expect(previousStableTag({ tags: TAGS, tag: 'v0.45.1' })).toBe('v0.45.0');
  });
});
