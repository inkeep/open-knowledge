import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { applyByPrefixSuffix } from './apply-by-prefix-suffix.ts';

function setup(initial: string): Y.Text {
  const doc = new Y.Doc();
  const ytext = doc.getText('test');
  if (initial) ytext.insert(0, initial);
  return ytext;
}

describe('applyByPrefixSuffix', () => {
  test('identity — no change when currentText === newText', () => {
    const ytext = setup('hello world');
    applyByPrefixSuffix(ytext, 'hello world', 'hello world');
    expect(ytext.toString()).toBe('hello world');
  });

  test('pure append', () => {
    const ytext = setup('hello');
    applyByPrefixSuffix(ytext, 'hello', 'hello world');
    expect(ytext.toString()).toBe('hello world');
  });

  test('pure prepend', () => {
    const ytext = setup('world');
    applyByPrefixSuffix(ytext, 'world', 'hello world');
    expect(ytext.toString()).toBe('hello world');
  });

  test('middle replacement — outer prefix/suffix preserved', () => {
    const ytext = setup('hello cruel world');
    applyByPrefixSuffix(ytext, 'hello cruel world', 'hello kind world');
    expect(ytext.toString()).toBe('hello kind world');
  });

  test('full wholesale replace — no common prefix/suffix', () => {
    const ytext = setup('abc');
    applyByPrefixSuffix(ytext, 'abc', 'xyz');
    expect(ytext.toString()).toBe('xyz');
  });

  test('empty to nonempty', () => {
    const ytext = setup('');
    applyByPrefixSuffix(ytext, '', 'hello');
    expect(ytext.toString()).toBe('hello');
  });

  test('nonempty to empty', () => {
    const ytext = setup('hello');
    applyByPrefixSuffix(ytext, 'hello', '');
    expect(ytext.toString()).toBe('');
  });

  test('Unicode BMP boundary — 3-byte UTF-8 / 1-unit UTF-16 chars', () => {
    // Characters like é (U+00E9), ñ (U+00F1), 日 (U+65E5) are BMP, 1 UTF-16 unit
    const ytext = setup('café日本語');
    applyByPrefixSuffix(ytext, 'café日本語', 'café中文字');
    expect(ytext.toString()).toBe('café中文字');
  });

  test('supplementary-plane boundary — surrogate pairs at prefix/suffix boundary', () => {
    // 🚀 (U+1F680) is a surrogate pair in UTF-16: \uD83D\uDE80
    // Verify the function does not split a surrogate pair
    const ytext = setup('hello🚀world');
    applyByPrefixSuffix(ytext, 'hello🚀world', 'hello🌍world');
    expect(ytext.toString()).toBe('hello🌍world');
  });

  test('supplementary-plane at prefix end', () => {
    // Common prefix ends at a surrogate pair boundary
    const ytext = setup('🚀abc');
    applyByPrefixSuffix(ytext, '🚀abc', '🚀xyz');
    expect(ytext.toString()).toBe('🚀xyz');
  });

  test('supplementary-plane at suffix start', () => {
    // Common suffix starts at a surrogate pair boundary
    const ytext = setup('abc🚀');
    applyByPrefixSuffix(ytext, 'abc🚀', 'xyz🚀');
    expect(ytext.toString()).toBe('xyz🚀');
  });
});
