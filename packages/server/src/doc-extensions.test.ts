import { beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetDocExtensionsForTests,
  forgetDocExtension,
  getDocExtension,
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from './doc-extensions.ts';

beforeEach(() => {
  _resetDocExtensionsForTests();
});

describe('SUPPORTED_DOC_EXTENSIONS', () => {
  test('is ordered by precedence — .mdx before .md', () => {
    expect(SUPPORTED_DOC_EXTENSIONS).toEqual(['.mdx', '.md']);
  });
});

describe('isSupportedDocFile', () => {
  test('matches .md and .mdx', () => {
    expect(isSupportedDocFile('foo.md')).toBe(true);
    expect(isSupportedDocFile('foo.mdx')).toBe(true);
    expect(isSupportedDocFile('nested/path/foo.mdx')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isSupportedDocFile('foo.MD')).toBe(true);
    expect(isSupportedDocFile('foo.MDX')).toBe(true);
  });

  test('rejects other extensions', () => {
    expect(isSupportedDocFile('foo.txt')).toBe(false);
    expect(isSupportedDocFile('foo.markdown')).toBe(false);
    expect(isSupportedDocFile('foo')).toBe(false);
    expect(isSupportedDocFile('foo.mdown')).toBe(false);
  });
});

describe('stripDocExtension', () => {
  test('strips .md', () => {
    expect(stripDocExtension('foo.md')).toBe('foo');
    expect(stripDocExtension('nested/foo.md')).toBe('nested/foo');
  });

  test('strips .mdx', () => {
    expect(stripDocExtension('foo.mdx')).toBe('foo');
    expect(stripDocExtension('nested/foo.mdx')).toBe('nested/foo');
  });

  test('is case-insensitive', () => {
    expect(stripDocExtension('foo.MD')).toBe('foo');
    expect(stripDocExtension('foo.MDX')).toBe('foo');
    expect(stripDocExtension('nested/foo.Md')).toBe('nested/foo');
  });

  test('passes through non-supported extensions untouched', () => {
    expect(stripDocExtension('foo.txt')).toBe('foo.txt');
    expect(stripDocExtension('releases/v1.0')).toBe('releases/v1.0');
    expect(stripDocExtension('foo')).toBe('foo');
  });
});

describe('registerDocExtension / getDocExtension', () => {
  test('defaults to .md when no file observed', () => {
    expect(getDocExtension('foo')).toBe('.md');
  });

  test('records observed extension', () => {
    const result = registerDocExtension('foo', '.mdx');
    expect(result).toEqual({ effective: '.mdx', changed: true, shadowed: null });
    expect(getDocExtension('foo')).toBe('.mdx');
  });

  test('.mdx wins over .md when both seen', () => {
    registerDocExtension('foo', '.md');
    const second = registerDocExtension('foo', '.mdx');
    expect(second).toEqual({ effective: '.mdx', changed: true, shadowed: '.md' });
    expect(getDocExtension('foo')).toBe('.mdx');
  });

  test('.mdx keeps precedence when .md arrives after', () => {
    registerDocExtension('foo', '.mdx');
    const second = registerDocExtension('foo', '.md');
    expect(second).toEqual({ effective: '.mdx', changed: false, shadowed: '.md' });
    expect(getDocExtension('foo')).toBe('.mdx');
  });

  test('re-registering the same extension is a no-op', () => {
    registerDocExtension('foo', '.md');
    const second = registerDocExtension('foo', '.md');
    expect(second).toEqual({ effective: '.md', changed: false, shadowed: null });
  });

  test('forgetDocExtension removes the mapping', () => {
    registerDocExtension('foo', '.mdx');
    forgetDocExtension('foo');
    expect(getDocExtension('foo')).toBe('.md'); // back to default
  });

  test('forgetDocExtension after collision returns to default (no shadow restore)', () => {
    // Both extensions observed on disk; .mdx wins precedence.
    registerDocExtension('foo', '.md');
    registerDocExtension('foo', '.mdx');
    expect(getDocExtension('foo')).toBe('.mdx');

    // Forget clears the winning entry entirely — the shadowed .md is NOT
    // resurrected. This is intentional: file-watcher re-registers the
    // surviving extension on the next observed event, so drift is self-healing.
    forgetDocExtension('foo');
    expect(getDocExtension('foo')).toBe('.md'); // back to default
  });

  test('preserves uppercase .MD casing observed on disk', () => {
    // Persistence concatenates `${docName}${getDocExtension(docName)}` to derive
    // the on-disk path. If we lowercase here, a `Foo.MD` file gets a duplicate
    // `Foo.md` written next to it on case-sensitive filesystems.
    const result = registerDocExtension('foo', '.MD');
    expect(result).toEqual({ effective: '.MD', changed: true, shadowed: null });
    expect(getDocExtension('foo')).toBe('.MD');
  });

  test('preserves uppercase .MDX casing observed on disk', () => {
    const result = registerDocExtension('foo', '.MDX');
    expect(result).toEqual({ effective: '.MDX', changed: true, shadowed: null });
    expect(getDocExtension('foo')).toBe('.MDX');
  });

  test('precedence applies case-insensitively: .MDX wins over .MD', () => {
    registerDocExtension('foo', '.MD');
    const second = registerDocExtension('foo', '.MDX');
    expect(second).toEqual({ effective: '.MDX', changed: true, shadowed: '.MD' });
    expect(getDocExtension('foo')).toBe('.MDX');
  });

  test('precedence applies case-insensitively: .MDX wins over later .md', () => {
    registerDocExtension('foo', '.MDX');
    const second = registerDocExtension('foo', '.md');
    expect(second).toEqual({ effective: '.MDX', changed: false, shadowed: '.md' });
    expect(getDocExtension('foo')).toBe('.MDX');
  });

  test('same canonical extension is a no-op regardless of case', () => {
    registerDocExtension('foo', '.MD');
    const second = registerDocExtension('foo', '.md');
    expect(second).toEqual({ effective: '.MD', changed: false, shadowed: null });
    expect(getDocExtension('foo')).toBe('.MD');
  });

  test('rejects unsupported extensions', () => {
    expect(() => registerDocExtension('foo', '.txt')).toThrow();
    expect(() => registerDocExtension('foo', '.markdown')).toThrow();
    expect(() => registerDocExtension('foo', '')).toThrow();
  });
});
