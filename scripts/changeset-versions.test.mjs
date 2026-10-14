import { describe, expect, test } from 'vitest';
import { bumpSemver, maxBumpType, maxReleaseType } from './changeset-versions.mjs';

describe('bumpSemver', () => {
  test('bumps each level', () => {
    expect(bumpSemver('0.5.0', 'patch')).toBe('0.5.1');
    expect(bumpSemver('0.5.0', 'minor')).toBe('0.6.0');
    expect(bumpSemver('0.4.7', 'major')).toBe('1.0.0');
  });

  test('minor/major zero out lower components', () => {
    expect(bumpSemver('0.5.3', 'minor')).toBe('0.6.0');
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0');
  });

  test('throws on a non X.Y.Z version', () => {
    expect(() => bumpSemver('0.5', 'patch')).toThrow(/Invalid version/);
    expect(() => bumpSemver('0.5.0-beta.1', 'patch')).toThrow(/Invalid version/);
  });

  test('throws on an unknown bump type', () => {
    expect(() => bumpSemver('0.5.0', 'mega')).toThrow(/Invalid bump type/);
  });
});

describe('maxBumpType', () => {
  test('floors to patch on empty / null-only input', () => {
    expect(maxBumpType([])).toBe('patch');
    expect(maxBumpType([null, null])).toBe('patch');
  });

  test('returns the highest declared bump', () => {
    expect(maxBumpType(['patch', 'patch'])).toBe('patch');
    expect(maxBumpType(['patch', 'minor'])).toBe('minor');
    expect(maxBumpType(['minor', 'major', 'patch'])).toBe('major');
    expect(maxBumpType([null, 'minor', null])).toBe('minor');
  });
});

describe('maxReleaseType', () => {
  test('returns the max bump across the releases Changesets read from one changeset', () => {
    const releases = [
      { name: '@inkeep/open-knowledge', type: 'minor' },
      { name: '@inkeep/open-knowledge-app', type: 'patch' },
    ];
    expect(maxReleaseType(releases)).toBe('minor');
  });

  test('returns major when any release is major', () => {
    expect(maxReleaseType([{ name: '@inkeep/open-knowledge', type: 'major' }])).toBe('major');
  });

  test('returns null for a changeset that declares no release', () => {
    expect(maxReleaseType([])).toBeNull();
  });

  test('ignores a none release, which bumps nothing', () => {
    expect(maxReleaseType([{ name: '@inkeep/open-knowledge', type: 'none' }])).toBeNull();
    expect(
      maxReleaseType([
        { name: '@inkeep/open-knowledge', type: 'none' },
        { name: '@inkeep/open-knowledge-app', type: 'patch' },
      ]),
    ).toBe('patch');
  });
});
