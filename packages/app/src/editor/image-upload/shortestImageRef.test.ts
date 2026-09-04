import { describe, expect, test } from 'vitest';
import { shortestImageRef } from './index.ts';

describe('shortestImageRef — F8 4-case rewrite', () => {
  test('case 1: same directory returns bare basename', () => {
    expect(shortestImageRef('docs/screenshot.png', 'docs/guide.md')).toBe('screenshot.png');
  });

  test('case 1b: root-level doc and root-level asset', () => {
    expect(shortestImageRef('logo.png', 'readme.md')).toBe('logo.png');
  });

  test('case 2: asset in parent dir → ../<name>', () => {
    expect(shortestImageRef('shared/photo.png', 'shared/docs/guide.md')).toBe('../photo.png');
  });

  test('case 2b: asset two dirs up', () => {
    expect(shortestImageRef('photo.png', 'docs/sub/guide.md')).toBe('../../photo.png');
  });

  test('case 3: asset in subtree of doc dir → ./<sub>/<name>', () => {
    expect(shortestImageRef('docs/archive/photo.png', 'docs/guide.md')).toBe('./archive/photo.png');
  });

  test('case 3b: deeper subtree', () => {
    expect(shortestImageRef('docs/a/b/c/photo.png', 'docs/guide.md')).toBe('./a/b/c/photo.png');
  });

  test('case 4: cross-tree → ../.../<name>', () => {
    expect(shortestImageRef('images/photo.png', 'docs/guide.md')).toBe('../images/photo.png');
  });

  test('case 4b: disjoint deep trees', () => {
    expect(shortestImageRef('a/b/c/img.png', 'x/y/z/doc.md')).toBe('../../../a/b/c/img.png');
  });

  test('partial overlap — shared ancestor only', () => {
    expect(shortestImageRef('shared/images/photo.png', 'shared/docs/guide.md')).toBe(
      '../images/photo.png',
    );
  });
});
