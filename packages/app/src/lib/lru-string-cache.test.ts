import { describe, expect, test } from 'vitest';
import { LruStringCache } from './lru-string-cache';

describe('LruStringCache', () => {
  test('get on miss returns undefined', () => {
    const cache = new LruStringCache(8);
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  test('set/get round-trip', () => {
    const cache = new LruStringCache(8);
    cache.set('k1', 'v1');
    expect(cache.get('k1')).toBe('v1');
  });

  test('set replaces existing value at the same key', () => {
    const cache = new LruStringCache(8);
    cache.set('k1', 'v1');
    cache.set('k1', 'v2');
    expect(cache.get('k1')).toBe('v2');
    expect(cache.size).toBe(1);
  });

  test('get re-inserts to MRU position so subsequent eviction skips it', () => {
    const cache = new LruStringCache(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.get('a');
    cache.set('d', '4');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
  });

  test('set above limit evicts the LRU entry', () => {
    const cache = new LruStringCache(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size).toBe(3);
    cache.set('d', '4');
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe('4');
  });

  test('clear empties the map', () => {
    const cache = new LruStringCache(8);
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeUndefined();
  });

  test('updating an existing key promotes it to MRU', () => {
    const cache = new LruStringCache(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('a', '1-updated');
    cache.set('d', '4');
    expect(cache.get('a')).toBe('1-updated');
    expect(cache.get('b')).toBeUndefined();
  });

  test('limit must be positive', () => {
    expect(() => new LruStringCache(0)).toThrow();
    expect(() => new LruStringCache(-1)).toThrow();
  });
});
