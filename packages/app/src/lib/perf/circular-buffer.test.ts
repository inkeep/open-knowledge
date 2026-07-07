import { describe, expect, test } from 'bun:test';
import { CircularBuffer } from './circular-buffer';

describe('CircularBuffer', () => {
  test('rejects non-positive capacity', () => {
    expect(() => new CircularBuffer<number>(0)).toThrow();
    expect(() => new CircularBuffer<number>(-1)).toThrow();
    expect(() => new CircularBuffer<number>(1.5)).toThrow();
  });

  test('push grows length up to capacity, then stays pinned', () => {
    const buf = new CircularBuffer<number>(3);
    expect(buf.length).toBe(0);
    buf.push(1);
    expect(buf.length).toBe(1);
    buf.push(2);
    buf.push(3);
    expect(buf.length).toBe(3);
    buf.push(4);
    buf.push(5);
    expect(buf.length).toBe(3);
  });

  test('toArray returns insertion order while partial', () => {
    const buf = new CircularBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.toArray()).toEqual(['a', 'b', 'c']);
  });

  test('toArray returns chronological order (oldest first) when full', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);

    // Eviction: 1 is oldest, gets overwritten next.
    buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);

    buf.push(5);
    expect(buf.toArray()).toEqual([3, 4, 5]);

    // Wrap around — verify chronological order persists.
    buf.push(6);
    buf.push(7);
    expect(buf.toArray()).toEqual([5, 6, 7]);
  });

  test('clear resets to empty', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrite
    expect(buf.length).toBe(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    // After clear, push behaves as fresh
    buf.push(99);
    expect(buf.toArray()).toEqual([99]);
  });

  test('empty toArray', () => {
    const buf = new CircularBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  test('capacity-of-1 ring keeps only the latest', () => {
    const buf = new CircularBuffer<string>(1);
    buf.push('a');
    expect(buf.toArray()).toEqual(['a']);
    buf.push('b');
    expect(buf.toArray()).toEqual(['b']);
    buf.push('c');
    expect(buf.toArray()).toEqual(['c']);
    expect(buf.length).toBe(1);
  });

  test('object references are preserved by identity', () => {
    const buf = new CircularBuffer<{ x: number }>(2);
    const a = { x: 1 };
    const b = { x: 2 };
    buf.push(a);
    buf.push(b);
    const out = buf.toArray();
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });
});
