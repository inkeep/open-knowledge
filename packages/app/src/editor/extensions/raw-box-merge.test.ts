import { describe, expect, test } from 'vitest';
import { computeChange, mergeConcurrentEdit } from './raw-box-merge';

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('mergeConcurrentEdit', () => {
  test('no local change takes the remote text', () => {
    expect(mergeConcurrentEdit('abc', 'abc', 'aXbc')).toBe('aXbc');
  });

  test('no remote change takes the local text', () => {
    expect(mergeConcurrentEdit('abc', 'abcZ', 'abc')).toBe('abcZ');
  });

  test('a composition committed after a concurrent insert earlier in the box keeps both, once each', () => {
    const base = '<CustomWidget>\n\nAAA\n\n</CustomWidget>';
    const local = `${base}日本語`;
    const at = base.indexOf('</CustomWidget>');
    const remote = `${base.slice(0, at)}CONCURRENTZZZ ${base.slice(at)}`;

    const merged = mergeConcurrentEdit(base, local, remote);

    expect(merged).toBe('<CustomWidget>\n\nAAA\n\nCONCURRENTZZZ </CustomWidget>日本語');
    expect(occurrences(merged, '日本語')).toBe(1);
    expect(occurrences(merged, 'CONCURRENTZZZ')).toBe(1);
  });

  test('a local edit before the remote one keeps both in document order', () => {
    expect(mergeConcurrentEdit('0123456789', 'L0123456789', '01234R56789')).toBe('L01234R56789');
  });

  test('a local edit after the remote one is shifted by the remote length change', () => {
    expect(mergeConcurrentEdit('0123456789', '012345678L9', '01RR23456789')).toBe('01RR2345678L9');
  });

  test('inserts at the same point keep both texts', () => {
    const merged = mergeConcurrentEdit('ab', 'aLb', 'aRb');
    expect(occurrences(merged, 'L')).toBe(1);
    expect(occurrences(merged, 'R')).toBe(1);
  });

  test('overlapping edits never drop the locally typed text', () => {
    const merged = mergeConcurrentEdit('hello world', 'hello brave world', 'hello big world');
    expect(merged).toContain('big');
    expect(merged).toContain('brave');
  });
});

describe('computeChange', () => {
  test('equal strings have no change', () => {
    expect(computeChange('same', 'same')).toBeNull();
  });

  test('trims the common prefix and suffix to one contiguous replacement', () => {
    expect(computeChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, text: 'XY' });
  });
});
