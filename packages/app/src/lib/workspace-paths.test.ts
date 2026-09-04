import { describe, expect, test } from 'vitest';
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

  test('preserves extension-qualified markdown paths', () => {
    expect(docNameToRelativePath('specs/foo/SPEC.md')).toBe('specs/foo/SPEC.md');
    expect(docNameToRelativePath('specs/foo/SPEC.mdx')).toBe('specs/foo/SPEC.mdx');
  });
});
