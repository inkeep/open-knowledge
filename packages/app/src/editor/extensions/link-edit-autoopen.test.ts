
import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetPendingLinkEditForTest,
  consumePendingLinkEdit,
  setPendingLinkEdit,
} from './link-edit-autoopen';

afterEach(() => {
  _resetPendingLinkEditForTest();
});

describe('setPendingLinkEdit / consumePendingLinkEdit', () => {
  test('consume returns true once, false on subsequent calls for the same id', () => {
    setPendingLinkEdit('m5');
    expect(consumePendingLinkEdit('m5')).toBe(true);
    expect(consumePendingLinkEdit('m5')).toBe(false);
  });

  test('consume returns false for a never-set id', () => {
    expect(consumePendingLinkEdit('m42')).toBe(false);
  });

  test('two different ids do not collide', () => {
    setPendingLinkEdit('m10');
    setPendingLinkEdit('m20');
    expect(consumePendingLinkEdit('m10')).toBe(true);
    expect(consumePendingLinkEdit('m10')).toBe(false); // already drained
    expect(consumePendingLinkEdit('m20')).toBe(true);
    expect(consumePendingLinkEdit('m20')).toBe(false);
  });

  test('set is idempotent for the same id (Set semantics)', () => {
    setPendingLinkEdit('m7');
    setPendingLinkEdit('m7');
    setPendingLinkEdit('m7');
    expect(consumePendingLinkEdit('m7')).toBe(true);
    expect(consumePendingLinkEdit('m7')).toBe(false);
  });

  test('StrictMode double-consume: a single consume wins and the second sees nothing', () => {
    setPendingLinkEdit('m99');
    expect(consumePendingLinkEdit('m99')).toBe(true);
    expect(consumePendingLinkEdit('m99')).toBe(false);
    setPendingLinkEdit('m100');
    expect(consumePendingLinkEdit('m99')).toBe(false);
    expect(consumePendingLinkEdit('m100')).toBe(true);
  });
});
