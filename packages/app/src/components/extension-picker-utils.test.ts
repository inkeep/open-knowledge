import { describe, expect, test } from 'vitest';
import {
  type DocExtension,
  detectExtension,
  isDocExtension,
  SUPPORTED_EXTENSIONS,
  stripExt,
} from './extension-picker-utils';

describe('SUPPORTED_EXTENSIONS', () => {
  test('lists the admitted doc extensions in UI-default order', () => {
    expect(SUPPORTED_EXTENSIONS).toEqual(['.md', '.mdx']);
  });
});

describe('isDocExtension', () => {
  test('accepts the two supported extensions', () => {
    expect(isDocExtension('.md')).toBe(true);
    expect(isDocExtension('.mdx')).toBe(true);
  });

  test('rejects any other string', () => {
    expect(isDocExtension('.txt')).toBe(false);
    expect(isDocExtension('md')).toBe(false);
    expect(isDocExtension('')).toBe(false);
    expect(isDocExtension('.MD')).toBe(false);
  });
});

describe('detectExtension', () => {
  test('returns the extension when present at the tail', () => {
    expect(detectExtension('foo.md')).toBe('.md');
    expect(detectExtension('foo.mdx')).toBe('.mdx');
    expect(detectExtension('nested/path/file.mdx')).toBe('.mdx');
  });

  test('is case-insensitive but returns canonical lowercase', () => {
    expect(detectExtension('foo.MD')).toBe('.md');
    expect(detectExtension('foo.MDX')).toBe('.mdx');
    expect(detectExtension('foo.Md')).toBe('.md');
  });

  test('returns null when no supported extension is present', () => {
    expect(detectExtension('foo')).toBeNull();
    expect(detectExtension('foo.txt')).toBeNull();
    expect(detectExtension('foo.markdown')).toBeNull();
    expect(detectExtension('')).toBeNull();
  });

  test('does not confuse a mid-string ".md" for a tail match', () => {
    expect(detectExtension('foo.md.txt')).toBeNull();
    expect(detectExtension('foo.mdx-backup')).toBeNull();
  });
});

describe('stripExt', () => {
  test('removes a supported extension from the tail', () => {
    expect(stripExt('foo.md')).toBe('foo');
    expect(stripExt('foo.mdx')).toBe('foo');
    expect(stripExt('nested/path/file.mdx')).toBe('nested/path/file');
  });

  test('is case-insensitive', () => {
    expect(stripExt('foo.MD')).toBe('foo');
    expect(stripExt('foo.MDX')).toBe('foo');
  });

  test('passes through strings with no supported extension', () => {
    expect(stripExt('foo')).toBe('foo');
    expect(stripExt('foo.txt')).toBe('foo.txt');
    expect(stripExt('')).toBe('');
  });
});

describe('type DocExtension', () => {
  test('narrows from string literal', () => {
    const md: DocExtension = '.md';
    const mdx: DocExtension = '.mdx';
    expect(md).toBe('.md');
    expect(mdx).toBe('.mdx');
  });
});
