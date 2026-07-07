/**
 * `LruStringCache` — a Map-insertion-order LRU cache with string values.
 *
 * Behavior:
 *   - `get`: returns the value (or undefined). On hit, re-inserts the key
 *     to mark it as most-recently-used. Map iteration order in JS / V8 /
 *     JSC is insertion order, so re-inserting deterministically promotes
 *     the entry without a separate timestamp or counter.
 *   - `set`: writes the entry (re-inserting if already present so the key
 *     is MRU), then evicts oldest entries until size <= limit.
 *   - `clear`: empties the map.
 *
 * The cache is intentionally minimal — string values, no TTL, no eviction
 * callback — because the consumers (`useActivityPanel`, `useTimelineEntryDiff`)
 * only need fast in-memory hits keyed by stable string identifiers.
 */
export class LruStringCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly limit: number) {
    if (limit <= 0) {
      throw new Error(`LruStringCache: limit must be > 0 (got ${limit})`);
    }
  }

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
