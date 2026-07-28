import { describe, expect, test } from 'vitest';
import { resolveInternalHref } from './resolve-internal-href.ts';

describe('resolveInternalHref', () => {
  test('resolves same-directory relative links', () => {
    expect(resolveInternalHref('./other', 'notes')).toEqual({ docName: 'other', anchor: null });
    expect(resolveInternalHref('./other.md', 'notes')).toEqual({ docName: 'other', anchor: null });
    expect(resolveInternalHref('sibling.md', 'notes')).toEqual({
      docName: 'sibling',
      anchor: null,
    });
  });

  test('resolves links relative to nested source docs', () => {
    expect(resolveInternalHref('../overview.md', 'folder/page')).toEqual({
      docName: 'overview',
      anchor: null,
    });
    expect(resolveInternalHref('../sibling/other.md', 'folder/page')).toEqual({
      docName: 'sibling/other',
      anchor: null,
    });
  });

  test('preserves anchors while stripping query strings and .md extensions', () => {
    expect(resolveInternalHref('./page.md#section', 'notes')).toEqual({
      docName: 'page',
      anchor: 'section',
    });
    expect(resolveInternalHref('./page.md?q=1#frag', 'notes')).toEqual({
      docName: 'page',
      anchor: 'frag',
    });
  });

  test('resolves links with .mdx extension stripped', () => {
    expect(resolveInternalHref('./other.mdx', 'notes')).toEqual({
      docName: 'other',
      anchor: null,
    });
    expect(resolveInternalHref('../sibling/component.mdx', 'folder/page')).toEqual({
      docName: 'sibling/component',
      anchor: null,
    });
    expect(resolveInternalHref('./page.mdx#section', 'notes')).toEqual({
      docName: 'page',
      anchor: 'section',
    });
  });

  test('returns null for external and anchor-only hrefs', () => {
    expect(resolveInternalHref('https://example.com', 'notes')).toBeNull();
    expect(resolveInternalHref('mailto:foo@bar.com', 'notes')).toBeNull();
    expect(resolveInternalHref('//example.com/page', 'notes')).toBeNull();
    expect(resolveInternalHref('#section', 'notes')).toBeNull();
  });

  test('resolves root-absolute hrefs from the content root', () => {
    expect(resolveInternalHref('/absolute/path.md', 'notes')).toEqual({
      docName: 'absolute/path',
      anchor: null,
    });
    expect(resolveInternalHref('/absolute/path#intro', 'notes')).toEqual({
      docName: 'absolute/path',
      anchor: 'intro',
    });
  });

  test('returns null when relative traversal would escape the content root', () => {
    expect(resolveInternalHref('../../escape.md', 'folder/page')).toBeNull();
    expect(resolveInternalHref('../../../way-out.md', 'deep/a/b')).toBeNull();
  });
});
