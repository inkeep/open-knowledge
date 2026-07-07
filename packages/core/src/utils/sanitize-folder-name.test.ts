import { describe, expect, test } from 'bun:test';
import { sanitizeFolderName } from './sanitize-folder-name.ts';

describe('sanitizeFolderName', () => {
  test('strips path separators and reserved chars', () => {
    expect(sanitizeFolderName('My/Notes')).toBe('My-Notes');
    expect(sanitizeFolderName('a:b*c?')).toBe('a-b-c');
    expect(sanitizeFolderName('foo<bar>')).toBe('foo-bar');
    expect(sanitizeFolderName('a\\b')).toBe('a-b');
    expect(sanitizeFolderName('a"b|c')).toBe('a-b-c');
  });

  test('strips null bytes (defense-in-depth pattern parity with validateSpawnPath)', () => {
    expect(sanitizeFolderName('foo\0bar')).toBe('foo-bar');
    expect(sanitizeFolderName('\0name')).toBe('name');
    expect(sanitizeFolderName('name\0')).toBe('name');
  });

  test('trims leading and trailing dashes / dots / whitespace', () => {
    expect(sanitizeFolderName('  My Notes  ')).toBe('My Notes');
    expect(sanitizeFolderName('---name---')).toBe('name');
    expect(sanitizeFolderName('...name...')).toBe('name');
  });

  test('returns empty for nothing-but-separators', () => {
    expect(sanitizeFolderName('////')).toBe('');
    expect(sanitizeFolderName('   ')).toBe('');
    expect(sanitizeFolderName('')).toBe('');
  });

  test('preserves normal names unchanged', () => {
    expect(sanitizeFolderName('My Notes')).toBe('My Notes');
    expect(sanitizeFolderName('project-2026')).toBe('project-2026');
  });

  test('collapses runs of whitespace and dashes', () => {
    expect(sanitizeFolderName('foo   bar')).toBe('foo bar');
    expect(sanitizeFolderName('foo---bar')).toBe('foo-bar');
  });

  // First barrier against directory traversal. `path.resolve(parent, sanitized)`
  // in the IPC handler is the second barrier; these tests pin the first so a
  // future regex narrowing (e.g. dropping `\` replacement for Windows compat)
  // cannot reintroduce a traversal regression silently.
  describe('path traversal defense', () => {
    test('bare .. sanitizes to empty', () => {
      expect(sanitizeFolderName('..')).toBe('');
    });

    test('bare ... sanitizes to empty', () => {
      expect(sanitizeFolderName('...')).toBe('');
    });

    test('../escape collapses separator + strips leading dots → "escape"', () => {
      expect(sanitizeFolderName('../escape')).toBe('escape');
    });

    test('foo/../bar neutralizes the embedded traversal to a literal basename', () => {
      // Separator replacement turns the path-traversal segment into a literal
      // basename character sequence — the resulting `foo-..-bar` is a single
      // filename component, not a traversal vector when joined via path.resolve.
      expect(sanitizeFolderName('foo/../bar')).toBe('foo-..-bar');
    });
  });
});
