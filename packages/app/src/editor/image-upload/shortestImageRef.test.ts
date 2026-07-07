import { describe, expect, test } from 'bun:test';
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
    // mdDir = docs, assetDir = images → ups=1, downs=[images]
    expect(shortestImageRef('images/photo.png', 'docs/guide.md')).toBe('../images/photo.png');
  });

  test('case 4b: disjoint deep trees', () => {
    // mdDir = x/y/z, assetDir = a/b/c → ups=3, downs=[a,b,c]
    expect(shortestImageRef('a/b/c/img.png', 'x/y/z/doc.md')).toBe('../../../a/b/c/img.png');
  });

  test('partial overlap — shared ancestor only', () => {
    // mdDir = shared/docs, assetDir = shared/images → ups=1, downs=[images]
    expect(shortestImageRef('shared/images/photo.png', 'shared/docs/guide.md')).toBe(
      '../images/photo.png',
    );
  });
});
