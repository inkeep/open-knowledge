import { describe, expect, test } from 'bun:test';
import { isWithinDir, toPosix } from './path-utils.ts';

describe('toPosix', () => {
  test('rewrites Windows backslashes to forward slashes', () => {
    expect(toPosix('C:\\Users\\mike\\Documents\\kb\\asdf')).toBe('C:/Users/mike/Documents/kb/asdf');
    expect(toPosix('research\\notes.md')).toBe('research/notes.md');
  });

  test('is a no-op on already-POSIX paths', () => {
    expect(toPosix('research/notes.md')).toBe('research/notes.md');
    expect(toPosix('/Users/mike/kb')).toBe('/Users/mike/kb');
    expect(toPosix('')).toBe('');
  });

  test('normalizes mixed separators', () => {
    expect(toPosix('C:\\Users\\mike\\kb/asdf')).toBe('C:/Users/mike/kb/asdf');
  });
});

describe('isWithinDir', () => {
  test('a child under a Windows parent is contained (the PRD-7140 regression)', () => {
    const contentDir = 'C:\\Users\\mike\\Documents\\kb';
    expect(isWithinDir('C:\\Users\\mike\\Documents\\kb\\asdf', contentDir)).toBe(true);
    expect(isWithinDir('C:\\Users\\mike\\Documents\\kb/asdf', contentDir)).toBe(true);
    expect(isWithinDir('C:\\Users\\mike\\Documents\\kb\\research\\a.md', contentDir)).toBe(true);
  });

  test('the directory itself is within itself', () => {
    expect(isWithinDir('C:\\Users\\mike\\kb', 'C:\\Users\\mike\\kb')).toBe(true);
    expect(isWithinDir('/Users/mike/kb', '/Users/mike/kb')).toBe(true);
  });

  test('a sibling or escaping path is rejected on both platforms', () => {
    expect(
      isWithinDir('C:\\Users\\mike\\Documents\\kb-other\\x', 'C:\\Users\\mike\\Documents\\kb'),
    ).toBe(false);
    expect(isWithinDir('C:\\Users\\mike\\Other\\x', 'C:\\Users\\mike\\Documents\\kb')).toBe(false);
    expect(isWithinDir('/Users/mike/other/x', '/Users/mike/kb')).toBe(false);
    expect(isWithinDir('/Users/mike/kbase/x', '/Users/mike/kb')).toBe(false);
  });

  test('POSIX containment is unchanged', () => {
    expect(isWithinDir('/Users/mike/kb/research/a.md', '/Users/mike/kb')).toBe(true);
  });
});
