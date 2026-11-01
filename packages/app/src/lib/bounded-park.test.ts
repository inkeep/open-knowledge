import { describe, expect, test, vi } from 'vitest';
import { createBoundedPark } from './bounded-park';

type Canvas = { name: string };

function parkWithCapacity(capacity: number) {
  const dispose = vi.fn((_canvas: Canvas) => {});
  return { dispose, park: createBoundedPark<string, Canvas>({ capacity, dispose }) };
}

describe('createBoundedPark', () => {
  test('hands a parked value back once', () => {
    const { dispose, park } = parkWithCapacity(2);
    const canvas = { name: 'a' };

    park.park('a', canvas);

    expect(park.reclaim('a')).toBe(canvas);
    expect(park.reclaim('a')).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  test('disposes the value parked longest ago once it holds more than its capacity', () => {
    const { dispose, park } = parkWithCapacity(2);
    const [a, b, c] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

    park.park('a', a);
    park.park('b', b);
    park.park('c', c);

    expect(dispose.mock.calls).toEqual([[a]]);
    expect(park.reclaim('a')).toBeUndefined();
    expect(park.reclaim('b')).toBe(b);
    expect(park.reclaim('c')).toBe(c);
  });

  test('parking a key again counts it as parked most recently', () => {
    const { dispose, park } = parkWithCapacity(2);
    const [a, b, c] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

    park.park('a', a);
    park.park('b', b);
    park.park('a', a);
    park.park('c', c);

    expect(dispose.mock.calls).toEqual([[b]]);
    expect(park.reclaim('a')).toBe(a);
  });

  test('disposes a value that a new value replaces under the same key', () => {
    const { dispose, park } = parkWithCapacity(2);
    const [first, second] = [{ name: 'first' }, { name: 'second' }];

    park.park('a', first);
    park.park('a', second);

    expect(dispose.mock.calls).toEqual([[first]]);
    expect(park.reclaim('a')).toBe(second);
  });
});
