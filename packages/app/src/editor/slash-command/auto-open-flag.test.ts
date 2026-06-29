
import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetPendingAutoOpenForTest,
  consumeAutoOpen,
  setPendingAutoOpen,
} from './component-items';

afterEach(() => {
  _resetPendingAutoOpenForTest();
});

describe('setPendingAutoOpen / consumeAutoOpen', () => {
  test('consumeAutoOpen(pos) returns true once, false on subsequent calls for same pos', () => {
    setPendingAutoOpen(5);
    expect(consumeAutoOpen(5)).toBe(true);
    expect(consumeAutoOpen(5)).toBe(false);
  });

  test('consumeAutoOpen(pos) returns false for a never-set pos', () => {
    expect(consumeAutoOpen(42)).toBe(false);
  });

  test('two different pos values do not collide', () => {
    setPendingAutoOpen(10);
    setPendingAutoOpen(20);
    expect(consumeAutoOpen(10)).toBe(true);
    expect(consumeAutoOpen(10)).toBe(false); // already drained
    expect(consumeAutoOpen(20)).toBe(true);
    expect(consumeAutoOpen(20)).toBe(false);
  });

  test('setPendingAutoOpen is idempotent for the same pos (Set semantics)', () => {
    setPendingAutoOpen(7);
    setPendingAutoOpen(7);
    setPendingAutoOpen(7);
    expect(consumeAutoOpen(7)).toBe(true);
    expect(consumeAutoOpen(7)).toBe(false);
  });

  test('consumeAutoOpen() with no arg drains exactly one pending entry (legacy drain path)', () => {
    setPendingAutoOpen(1);
    setPendingAutoOpen(2);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen()).toBe(false);
  });

  test('consumeAutoOpen() with no arg returns false when the set is empty', () => {
    expect(consumeAutoOpen()).toBe(false);
  });

  test('StrictMode double-consume: a single consume wins and the second sees nothing', () => {
    setPendingAutoOpen(99);
    expect(consumeAutoOpen(99)).toBe(true);
    expect(consumeAutoOpen(99)).toBe(false);
    setPendingAutoOpen(100);
    expect(consumeAutoOpen(99)).toBe(false);
    expect(consumeAutoOpen(100)).toBe(true);
  });

  test('legacy drain path does not consume an entry belonging to a specific pos later', () => {
    setPendingAutoOpen(30);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen(30)).toBe(false);
  });
});
