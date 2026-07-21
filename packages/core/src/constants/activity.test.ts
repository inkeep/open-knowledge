import { describe, expect, test } from 'vitest';
import { changedBlockRange } from './activity.ts';

describe('changedBlockRange', () => {
  test('identical block lists → null', () => {
    expect(changedBlockRange(['a', 'b'], ['a', 'b'])).toBeNull();
    expect(changedBlockRange([], [])).toBeNull();
  });

  test('append → only the new tail blocks (not the whole doc)', () => {
    expect(changedBlockRange(['a', 'b'], ['a', 'b', 'c'])).toEqual({ from: 2, to: 3 });
    expect(changedBlockRange(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual({ from: 2, to: 4 });
  });

  test('a whole-body replace that only appends collapses to the appended tail', () => {
    // The write is a `replace`, but the shared prefix is byte-identical — the
    // reason follow mode flashes the section, not the whole doc.
    expect(changedBlockRange(['heading', 'intro'], ['heading', 'intro', 'new-section'])).toEqual({
      from: 2,
      to: 3,
    });
  });

  test('prepend → the leading blocks', () => {
    expect(changedBlockRange(['b', 'c'], ['a', 'b', 'c'])).toEqual({ from: 0, to: 1 });
  });

  test('an edited middle block is bounded to that block', () => {
    expect(changedBlockRange(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({ from: 1, to: 2 });
  });

  test('empty before → the whole after', () => {
    expect(changedBlockRange([], ['a', 'b'])).toEqual({ from: 0, to: 2 });
  });

  test('pure deletion → null (no new block to flash)', () => {
    expect(changedBlockRange(['a', 'b', 'c'], ['a', 'c'])).toBeNull();
    expect(changedBlockRange(['a', 'b'], ['a'])).toBeNull();
  });

  test('delete-and-replace still reports the changed block', () => {
    expect(changedBlockRange(['a', 'b', 'c'], ['a', 'X'])).toEqual({ from: 1, to: 2 });
  });
});
