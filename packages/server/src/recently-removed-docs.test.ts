import { describe, expect, test } from 'bun:test';
import { RecentlyRemovedDocs, type RemovalEntry } from './recently-removed-docs.ts';

describe('RecentlyRemovedDocs — basic shape', () => {
  test('starts empty with no entries', () => {
    const cache = new RecentlyRemovedDocs(10);
    expect(cache.size).toBe(0);
    expect(cache.has('any')).toBe(false);
    expect(cache.get('any')).toBeUndefined();
  });

  test('setRenamed stores tagged renamed entry with newDocName + addedAt', () => {
    let nowVal = 1_000;
    const cache = new RecentlyRemovedDocs(10, { now: () => nowVal });
    nowVal = 1_234;
    cache.setRenamed('a', 'b');
    const entry = cache.get('a');
    expect(entry).toEqual({ kind: 'renamed', newDocName: 'b', addedAt: 1_234 });
  });

  test('setDeleted stores tagged deleted entry with addedAt and no newDocName', () => {
    let nowVal = 5_000;
    const cache = new RecentlyRemovedDocs(10, { now: () => nowVal });
    nowVal = 5_678;
    cache.setDeleted('a');
    const entry = cache.get('a') as RemovalEntry;
    expect(entry.kind).toBe('deleted');
    expect(entry.addedAt).toBe(5_678);
    expect((entry as { newDocName?: string }).newDocName).toBeUndefined();
  });

  test('has() returns true without promoting', () => {
    const cache = new RecentlyRemovedDocs(2);
    cache.setRenamed('a', 'A');
    cache.setRenamed('b', 'B');
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    cache.setRenamed('c', 'C');
    // 'a' must be the LRU since has() did not promote it
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  test('delete() is idempotent', () => {
    const cache = new RecentlyRemovedDocs(2);
    cache.setRenamed('a', 'A');
    cache.delete('a');
    expect(cache.has('a')).toBe(false);
    expect(() => cache.delete('a')).not.toThrow();
    expect(() => cache.delete('never-existed')).not.toThrow();
    expect(cache.size).toBe(0);
  });

  test('size getter reflects current cardinality', () => {
    const cache = new RecentlyRemovedDocs(10);
    expect(cache.size).toBe(0);
    cache.setRenamed('a', 'A');
    expect(cache.size).toBe(1);
    cache.setDeleted('b');
    expect(cache.size).toBe(2);
    cache.delete('a');
    expect(cache.size).toBe(1);
  });
});

describe('RecentlyRemovedDocs — LRU promotion', () => {
  test('get() promotes hit to MRU; oldest evicts first at cap', () => {
    const cache = new RecentlyRemovedDocs(3);
    cache.setRenamed('a', 'A');
    cache.setRenamed('b', 'B');
    cache.setRenamed('c', 'C');
    // Touch 'a' so 'b' becomes the LRU.
    expect(cache.get('a')?.kind).toBe('renamed');
    cache.setRenamed('d', 'D');
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  test('re-set on existing key promotes to MRU and updates value', () => {
    const cache = new RecentlyRemovedDocs(2);
    cache.setRenamed('a', 'A1');
    cache.setRenamed('b', 'B1');
    cache.setRenamed('a', 'A2'); // promote 'a' + update target
    cache.setRenamed('c', 'C1'); // 'b' is LRU, evicts
    expect(cache.has('b')).toBe(false);
    const a = cache.get('a');
    expect(a).toMatchObject({ kind: 'renamed', newDocName: 'A2' });
    expect(cache.has('c')).toBe(true);
  });

  test('multiple gets do not corrupt order beyond promotion', () => {
    const cache = new RecentlyRemovedDocs(3);
    cache.setRenamed('a', 'A');
    cache.setRenamed('b', 'B');
    cache.setRenamed('c', 'C');
    // Read 'a' three times; should still only count as the same MRU position.
    cache.get('a');
    cache.get('a');
    cache.get('a');
    cache.setRenamed('d', 'D'); // 'b' should evict (LRU)
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  test('rename-then-delete on the same docName overwrites entry kind', () => {
    const cache = new RecentlyRemovedDocs(5);
    cache.setRenamed('a', 'A');
    cache.setDeleted('a');
    expect(cache.get('a')?.kind).toBe('deleted');
    expect(cache.size).toBe(1);
  });
});

describe('RecentlyRemovedDocs — eviction telemetry', () => {
  test('eviction at cap fires onEviction once per evicted entry', () => {
    let evictions = 0;
    const cache = new RecentlyRemovedDocs(2, { onEviction: () => evictions++ });
    cache.setRenamed('a', 'A');
    cache.setRenamed('b', 'B');
    expect(evictions).toBe(0);
    cache.setRenamed('c', 'C'); // evicts 'a'
    expect(evictions).toBe(1);
    cache.setRenamed('d', 'D'); // evicts 'b'
    expect(evictions).toBe(2);
  });

  test('onSizeChange called after every set / delete with post-mutation size', () => {
    const sizes: number[] = [];
    const cache = new RecentlyRemovedDocs(2, { onSizeChange: (s) => sizes.push(s) });
    cache.setRenamed('a', 'A');
    cache.setRenamed('b', 'B');
    cache.setRenamed('c', 'C'); // evict, still size 2
    cache.delete('b');
    expect(sizes).toEqual([1, 2, 2, 1]);
  });

  test('delete() that misses does not fire onSizeChange', () => {
    const sizes: number[] = [];
    const cache = new RecentlyRemovedDocs(5, { onSizeChange: (s) => sizes.push(s) });
    cache.delete('never-existed');
    expect(sizes).toEqual([]);
  });
});

describe('RecentlyRemovedDocs — boundary capacities', () => {
  test('capacity 0 disables caching; entries are immediately dropped', () => {
    const sizes: number[] = [];
    let evictions = 0;
    const cache = new RecentlyRemovedDocs(0, {
      onEviction: () => evictions++,
      onSizeChange: (s) => sizes.push(s),
    });
    cache.setRenamed('a', 'A');
    cache.setDeleted('b');
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBeUndefined();
    expect(evictions).toBe(0);
    expect(sizes).toEqual([0, 0]);
  });

  test('capacity 1 holds exactly one entry; every new set evicts the prior', () => {
    let evictions = 0;
    const cache = new RecentlyRemovedDocs(1, { onEviction: () => evictions++ });
    cache.setRenamed('a', 'A');
    expect(cache.size).toBe(1);
    cache.setRenamed('b', 'B');
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(evictions).toBe(1);
  });

  test('default capacity is 10000 when not specified', () => {
    const cache = new RecentlyRemovedDocs();
    // Add a small number well under the cap to verify no immediate eviction.
    for (let i = 0; i < 50; i++) cache.setRenamed(`k${i}`, `v${i}`);
    expect(cache.size).toBe(50);
  });

  test('negative or fractional capacity is normalized to a non-negative integer', () => {
    const c1 = new RecentlyRemovedDocs(-5);
    c1.setRenamed('a', 'A');
    expect(c1.has('a')).toBe(false);

    const c2 = new RecentlyRemovedDocs(2.9);
    c2.setRenamed('a', 'A');
    c2.setRenamed('b', 'B');
    c2.setRenamed('c', 'C');
    expect(c2.size).toBe(2);
  });
});

describe('RecentlyRemovedDocs — addedAt monotonicity', () => {
  test('addedAt reflects the now() value at set time, not at get', () => {
    let nowVal = 100;
    const cache = new RecentlyRemovedDocs(5, { now: () => nowVal });
    cache.setRenamed('a', 'A');
    nowVal = 999;
    const entry = cache.get('a');
    expect(entry?.addedAt).toBe(100);
  });

  test('re-setting an entry refreshes addedAt', () => {
    let nowVal = 100;
    const cache = new RecentlyRemovedDocs(5, { now: () => nowVal });
    cache.setRenamed('a', 'A1');
    nowVal = 200;
    cache.setRenamed('a', 'A2');
    const entry = cache.get('a');
    expect(entry?.addedAt).toBe(200);
  });
});

describe('RecentlyRemovedDocs — chain-walk-friendly read pattern', () => {
  test('multiple gets across a synthetic chain do not perturb the cache contract', () => {
    // Auth extension walks A -> B -> C; each hop is a get(). The cache's
    // job is to return correct entries; promotion is a side-effect that's
    // safe because chain-walked names are by definition still relevant.
    const cache = new RecentlyRemovedDocs(5);
    cache.setRenamed('A', 'B');
    cache.setRenamed('B', 'C');
    cache.setDeleted('Z');

    const a = cache.get('A');
    expect(a).toMatchObject({ kind: 'renamed', newDocName: 'B' });
    const b = cache.get('B');
    expect(b).toMatchObject({ kind: 'renamed', newDocName: 'C' });
    const z = cache.get('Z');
    expect(z?.kind).toBe('deleted');

    // Subsequent walk returns the same entries.
    const a2 = cache.get('A');
    const b2 = cache.get('B');
    expect(a2).toEqual(a);
    expect(b2).toEqual(b);
  });
});

describe('RecentlyRemovedDocs — peek (non-promoting read)', () => {
  test('peek returns entry without promoting to MRU', () => {
    const cache = new RecentlyRemovedDocs(2);
    cache.setRenamed('A', 'A2');
    cache.setDeleted('B');
    // A is currently oldest. peek(A) must NOT promote it; if peek
    // promoted, the next setDeleted would evict B instead of A.
    const peeked = cache.peek('A');
    expect(peeked).toMatchObject({ kind: 'renamed', newDocName: 'A2' });
    cache.setDeleted('C');
    expect(cache.has('A')).toBe(false);
    expect(cache.has('B')).toBe(true);
    expect(cache.has('C')).toBe(true);
  });

  test('peek returns undefined for absent entries without side effects', () => {
    let sizeChanges = 0;
    const cache = new RecentlyRemovedDocs(10, { onSizeChange: () => sizeChanges++ });
    expect(cache.peek('absent')).toBeUndefined();
    expect(sizeChanges).toBe(0);
    expect(cache.size).toBe(0);
  });
});
