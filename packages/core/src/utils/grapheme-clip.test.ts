import { describe, expect, test, vi } from 'vitest';
import { graphemePrefix, graphemeSuffix } from './grapheme-clip.ts';

const GRINNING = '\u{1F600}';
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
const E_ACUTE_DECOMPOSED = 'e\u{0301}';
const RARE_HAN = '\u{20BB7}';

describe('graphemePrefix', () => {
  test('returns text that already fits unchanged', () => {
    expect(graphemePrefix('hello', 5)).toBe('hello');
    expect(graphemePrefix('', 0)).toBe('');
  });

  test('cuts plain text at the budget', () => {
    expect(graphemePrefix('hello world', 5)).toBe('hello');
  });

  test('never splits a surrogate pair', () => {
    expect(graphemePrefix(`ab${GRINNING}cd`, 3)).toBe('ab');
    expect(graphemePrefix(`ab${RARE_HAN}`, 3)).toBe('ab');
    expect(graphemePrefix(`ab${GRINNING}cd`, 4)).toBe(`ab${GRINNING}`);
  });

  test('keeps a whole grapheme cluster or drops it', () => {
    expect(graphemePrefix(`x${FAMILY}y`, 5)).toBe('x');
    expect(graphemePrefix(`x${FAMILY}y`, 1 + FAMILY.length)).toBe(`x${FAMILY}`);
    expect(graphemePrefix(`x${FLAG_JP}`, 4)).toBe('x');
    expect(graphemePrefix(`caf${E_ACUTE_DECOMPOSED}s`, 4)).toBe('caf');
  });

  test('a budget of zero or less yields an empty string', () => {
    expect(graphemePrefix('abc', 0)).toBe('');
    expect(graphemePrefix('abc', -3)).toBe('');
  });
});

describe('graphemeSuffix', () => {
  test('returns text that already fits unchanged', () => {
    expect(graphemeSuffix('hello', 5)).toBe('hello');
  });

  test('keeps the last characters within the budget', () => {
    expect(graphemeSuffix('hello world', 5)).toBe('world');
  });

  test('never starts on the second half of a surrogate pair', () => {
    expect(graphemeSuffix(`ab${GRINNING}cd`, 3)).toBe('cd');
    expect(graphemeSuffix(`ab${GRINNING}cd`, 4)).toBe(`${GRINNING}cd`);
  });

  test('keeps a whole grapheme cluster or drops it', () => {
    expect(graphemeSuffix(`x${FAMILY}y`, 5)).toBe('y');
    expect(graphemeSuffix(`${E_ACUTE_DECOMPOSED}tc`, 3)).toBe('tc');
  });

  test('a budget of zero or less yields an empty string', () => {
    expect(graphemeSuffix('abc', 0)).toBe('');
  });
});

describe('without Intl.Segmenter', () => {
  async function loadWithoutSegmenter(): Promise<typeof import('./grapheme-clip.ts')> {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Reflect.deleteProperty(Intl, 'Segmenter');
    vi.resetModules();
    try {
      return await import('./grapheme-clip.ts');
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
      vi.resetModules();
    }
  }

  test('a prefix still never splits a surrogate pair', async () => {
    const mod = await loadWithoutSegmenter();
    expect(mod.graphemePrefix(`ab${GRINNING}cd`, 3)).toBe('ab');
    expect(mod.graphemePrefix(`ab${GRINNING}cd`, 4)).toBe(`ab${GRINNING}`);
    expect(mod.graphemePrefix('hello world', 5)).toBe('hello');
  });

  test('a suffix still never starts on the second half of a surrogate pair', async () => {
    const mod = await loadWithoutSegmenter();
    expect(mod.graphemeSuffix(`ab${GRINNING}cd`, 3)).toBe('cd');
    expect(mod.graphemeSuffix(`ab${GRINNING}cd`, 4)).toBe(`${GRINNING}cd`);
    expect(mod.graphemeSuffix('hello world', 5)).toBe('world');
  });
});
