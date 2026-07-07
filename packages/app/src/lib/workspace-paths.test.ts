import { describe, expect, test } from 'bun:test';
import { docNameToRelativePath, joinWorkspacePath } from './workspace-paths';

describe('joinWorkspacePath', () => {
  test('POSIX: joins with forward slash', () => {
    expect(joinWorkspacePath('/Users/andrew/repo', 'specs/foo/SPEC.md', '/')).toBe(
      '/Users/andrew/repo/specs/foo/SPEC.md',
    );
  });

  test('POSIX: trims trailing slash on contentDir', () => {
    expect(joinWorkspacePath('/Users/andrew/repo/', 'specs/foo.md', '/')).toBe(
      '/Users/andrew/repo/specs/foo.md',
    );
  });

  test('Windows: rewrites POSIX-form relative path to backslashes', () => {
    expect(joinWorkspacePath('C:\\repo', 'specs/foo/SPEC.md', '\\')).toBe(
      'C:\\repo\\specs\\foo\\SPEC.md',
    );
  });

  test('Windows: trims trailing backslash on contentDir', () => {
    expect(joinWorkspacePath('C:\\repo\\', 'specs/foo.md', '\\')).toBe('C:\\repo\\specs\\foo.md');
  });

  test('POSIX: preserves literal backslash inside a relative path segment', () => {
    // Relative path is assumed POSIX-form in transit; only the join uses the
    // server-advertised separator. A literal backslash inside a POSIX segment
    // on a POSIX host is a valid filename character and must survive.
    expect(joinWorkspacePath('/home/a', 'weird\\name.md', '/')).toBe('/home/a/weird\\name.md');
  });
});

describe('docNameToRelativePath', () => {
  test('appends .md extension', () => {
    expect(docNameToRelativePath('specs/foo/SPEC')).toBe('specs/foo/SPEC.md');
  });

  test('handles root-level docName', () => {
    expect(docNameToRelativePath('README')).toBe('README.md');
  });

  test('preserves nested forward slashes', () => {
    expect(docNameToRelativePath('a/b/c/d')).toBe('a/b/c/d.md');
  });
});
