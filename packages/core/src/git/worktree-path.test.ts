import { describe, expect, test } from 'vitest';
import { WORKTREES_PARENT_DIR, worktreeRelativeDir } from './worktree-path.ts';

describe('worktreeRelativeDir', () => {
  test('places a simple branch under .ok/worktrees/', () => {
    expect(worktreeRelativeDir('feature-x')).toBe(`${WORKTREES_PARENT_DIR}/feature-x`);
  });

  test('keeps slash-namespaced branches as nested dirs', () => {
    expect(worktreeRelativeDir('feat/foo')).toBe(`${WORKTREES_PARENT_DIR}/feat/foo`);
  });

  test('trims surrounding whitespace', () => {
    expect(worktreeRelativeDir('  dev  ')).toBe(`${WORKTREES_PARENT_DIR}/dev`);
  });

  test('rejects empty / whitespace-only', () => {
    expect(worktreeRelativeDir('')).toBeNull();
    expect(worktreeRelativeDir('   ')).toBeNull();
  });

  test('rejects path-escape attempts', () => {
    expect(worktreeRelativeDir('../evil')).toBeNull();
    expect(worktreeRelativeDir('a/../../b')).toBeNull();
    expect(worktreeRelativeDir('/abs')).toBeNull();
    expect(worktreeRelativeDir('trailing/')).toBeNull();
    expect(worktreeRelativeDir('a//b')).toBeNull();
    expect(worktreeRelativeDir('.')).toBeNull();
  });

  test('rejects backslash and NUL', () => {
    expect(worktreeRelativeDir('a\\b')).toBeNull();
    expect(worktreeRelativeDir('a\0b')).toBeNull();
  });
});
