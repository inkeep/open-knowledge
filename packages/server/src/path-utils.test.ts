import { posix, win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import { escapesRoot, isWithinDir, toPosix } from './path-utils.ts';

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

describe('escapesRoot', () => {
  test('a path on another Windows drive escapes, because win32 relative returns it absolute', () => {
    const rel = win32.relative(
      'C:\\Users\\mike\\AppData\\Local\\Temp\\ok-ephemeral-abc',
      'E:\\Users\\mike\\Downloads',
    );
    expect(rel).toBe('E:\\Users\\mike\\Downloads');
    expect(escapesRoot(rel, win32)).toBe(true);
    expect(escapesRoot(toPosix(rel), win32)).toBe(true);
  });

  test('a child on the same Windows drive is contained', () => {
    const rel = win32.relative('C:\\Users\\mike\\kb', 'C:\\Users\\mike\\kb\\hwi_828');
    expect(escapesRoot(rel, win32)).toBe(false);
    expect(escapesRoot('', win32)).toBe(false);
  });

  test('a parent-relative path escapes on either platform', () => {
    expect(escapesRoot(win32.relative('C:\\Temp\\ok', 'C:\\Users\\mike\\Downloads'), win32)).toBe(
      true,
    );
    expect(escapesRoot(posix.relative('/tmp/ok', '/Users/mike/Downloads'), posix)).toBe(true);
    expect(escapesRoot('..', posix)).toBe(true);
  });

  test('a name that merely starts with two dots is contained', () => {
    expect(escapesRoot('..notes/a.md', posix)).toBe(false);
    expect(escapesRoot('..notes\\a.md', win32)).toBe(false);
  });

  test('a network share relative to a local drive escapes', () => {
    const rel = win32.relative('C:\\Users\\mike\\Temp\\ok', '\\\\server\\share\\Vault');
    expect(rel).toBe('\\\\server\\share\\Vault');
    expect(escapesRoot(toPosix(rel), win32)).toBe(true);
  });

  test('a drive-letter name is only absolute under win32 semantics', () => {
    expect(escapesRoot('E:/Users/mike', win32)).toBe(true);
    expect(escapesRoot('E:/Users/mike', posix)).toBe(false);
  });
});
