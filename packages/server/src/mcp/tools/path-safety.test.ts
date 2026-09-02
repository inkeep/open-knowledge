import { win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import { escapesRoot, resolveWithinRoot } from './path-safety.ts';

describe('resolveWithinRoot — accepts inputs contained in root', () => {
  test('plain relative path', () => {
    const result = resolveWithinRoot('/srv/project', 'articles/auth.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.abs).toBe('/srv/project/articles/auth.md');
      expect(result.rel).toBe('articles/auth.md');
    }
  });

  test('leading ./ is normalized away', () => {
    const result = resolveWithinRoot('/srv/project', './articles/auth.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel).toBe('articles/auth.md');
    }
  });

  test('leading / is treated as project-root-anchored when child of root', () => {
    const result = resolveWithinRoot('/srv/project', '/srv/project/articles/auth.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel).toBe('articles/auth.md');
    }
  });

  test('path equals root', () => {
    const result = resolveWithinRoot('/srv/project', '/srv/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel).toBe('');
      expect(result.abs).toBe('/srv/project');
    }
  });

  test('intra-root traversal collapses cleanly', () => {
    const result = resolveWithinRoot('/srv/project', 'articles/../README.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel).toBe('README.md');
    }
  });

  test('path with trailing slash', () => {
    const result = resolveWithinRoot('/srv/project', 'articles/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel).toBe('articles');
    }
  });

  test('filename literally starting with `..` (e.g. `..abc`) is contained, not rejected', () => {
    const result = resolveWithinRoot('/srv/project', '..abc');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.abs).toBe('/srv/project/..abc');
      expect(result.rel).toBe('..abc');
    }
  });
});

describe('resolveWithinRoot — rejects escapes', () => {
  test('relative `..` escape', () => {
    const result = resolveWithinRoot('/srv/project', '../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('escapes the configured root');
  });

  test('deeper `../..` escape', () => {
    const result = resolveWithinRoot('/srv/project', '../../../../etc/passwd');
    expect(result.ok).toBe(false);
  });

  test('absolute path outside root', () => {
    const result = resolveWithinRoot('/srv/project', '/etc/passwd');
    expect(result.ok).toBe(false);
  });

  test('intra-path `..` that lands outside root', () => {
    const result = resolveWithinRoot('/srv/project', 'foo/../../escape');
    expect(result.ok).toBe(false);
  });

  test('NUL byte rejected', () => {
    const result = resolveWithinRoot('/srv/project', 'articles\x00/../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('NUL byte');
  });

  test('refuses non-string candidate', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
    const result = resolveWithinRoot('/srv/project', 42 as any);
    expect(result.ok).toBe(false);
  });

  test('refuses relative root', () => {
    const result = resolveWithinRoot('relative-root', 'foo.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not absolute');
  });

  test('refuses sibling that prefix-matches root', () => {
    const result = resolveWithinRoot('/srv/project', '/srv/project-extra/foo.md');
    expect(result.ok).toBe(false);
  });
});

describe('escapesRoot — win32 separators (PRD-8341)', () => {
  const root = 'C:\\srv\\project';

  test.each([
    ['..\\etc\\passwd'],
    ['..\\..\\..\\Windows\\System32\\config\\SAM'],
    ['articles\\..\\..\\secrets.md'],
  ])('refuses win32 traversal %s', (candidate) => {
    expect(escapesRoot(win32.relative(root, win32.resolve(root, candidate)))).toBe(true);
  });

  test.each([
    ['C:\\Windows\\win.ini'],
    ['\\\\server\\share\\secrets.md'],
    ['D:\\other.md'],
  ])('refuses win32 absolute %s', (candidate) => {
    const rel = win32.relative(root, win32.resolve(root, candidate));
    expect(escapesRoot(rel) || win32.isAbsolute(rel)).toBe(true);
  });

  test.each([
    ['articles\\auth.md'],
    ['articles/auth.md'],
    ['..abc\\notes.md'],
    ['deep\\..\\ok.md'],
  ])('still accepts contained win32 path %s', (candidate) => {
    expect(escapesRoot(win32.relative(root, win32.resolve(root, candidate)))).toBe(false);
  });

  test('refuses a posix name that mimics a win32 escape', () => {
    expect(escapesRoot('..\\etc')).toBe(true);
  });
});
