/**
 * Behavioral coverage for the two pure path helpers.
 */
import { describe, expect, test } from 'bun:test';
import { isContentDirSafe, relativeToProject } from './project-paths';

describe('isContentDirSafe', () => {
  test.each([
    ['', true],
    ['.', true],
    ['docs', true],
    ['docs/api', true],
    ['a/b/c/d', true],
    ['./docs', true],
  ])('safe: %s → %s', (input, expected) => {
    expect(isContentDirSafe(input)).toBe(expected);
  });

  test.each([
    ['..', false],
    ['../escape', false],
    ['docs/../..', false],
    ['../sibling', false],
    ['/abs/path', false],
    ['C:/win', false],
  ])('rejected: %s → %s', (input, expected) => {
    expect(isContentDirSafe(input)).toBe(expected);
  });

  test('depth-0 with dotdot rejected', () => {
    expect(isContentDirSafe('docs/../docs/../..')).toBe(false);
  });

  test('balanced traversal stays safe', () => {
    expect(isContentDirSafe('docs/../api')).toBe(true);
  });
});

describe('relativeToProject', () => {
  test('picked === projectDir resolves to "."', () => {
    expect(relativeToProject('/users/me/proj', '/users/me/proj')).toBe('.');
  });

  test('picked inside projectDir returns the relative tail', () => {
    expect(relativeToProject('/users/me/proj', '/users/me/proj/docs')).toBe('docs');
    expect(relativeToProject('/users/me/proj', '/users/me/proj/docs/api')).toBe('docs/api');
  });

  test('trailing slashes on either side are tolerated', () => {
    expect(relativeToProject('/users/me/proj/', '/users/me/proj/docs')).toBe('docs');
    expect(relativeToProject('/users/me/proj', '/users/me/proj/docs/')).toBe('docs');
  });

  test('escape returns null', () => {
    expect(relativeToProject('/users/me/proj', '/users/me/other')).toBe(null);
    expect(relativeToProject('/users/me/proj', '/etc')).toBe(null);
  });

  test('prefix-matching is segment-aware (no /proj-other false-positive)', () => {
    expect(relativeToProject('/users/me/proj', '/users/me/proj-other/docs')).toBe(null);
  });

  test('windows backslash paths normalize for cross-platform comparison', () => {
    expect(relativeToProject('C:\\users\\me\\proj', 'C:\\users\\me\\proj\\docs')).toBe('docs');
  });
});
