/**
 * Per-process LRU cache of docNames that have been renamed away or deleted
 * since the server booted. Read by the `removalRedirectGuard`
 * `onAuthenticate` extension to reject incoming WebSocket connections to
 * stale docNames before any Y.Doc work runs — the single enforcement point
 * that prevents IDB-resync from recreating the file at the OLD path.
 *
 * Insertion-order semantics are inherited from `JS Map`: every set or
 * lookup that promotes (`get`) deletes-then-sets to move the entry to the
 * back of insertion order, so the front is always the least-recently-used.
 * Eviction at `capacity` removes the front entry. Pattern mirrors
 * `latestDiskAckSVs` in `cc1-broadcast.ts`.
 *
 * STOP rule for consumers: `isSystemDoc()` and `isConfigDoc()` are NOT
 * filtered inside this class — the cache MUST never hold synthetic docs,
 * and every populate site (rename spine, delete handler, watcher reconcile,
 * watcher add invalidation) is responsible for short-circuiting on those
 * predicates BEFORE calling `setRenamed` / `setDeleted`. Centralizing the
 * filter here would hide policy in a data structure; keeping it at the
 * call sites makes the contract auditable.
 */

const DEFAULT_CAPACITY = 10_000;

export type RemovalEntry =
  | { kind: 'renamed'; newDocName: string; addedAt: number }
  | { kind: 'deleted'; addedAt: number };

/**
 * Hooks the server-factory boot wires to telemetry — kept exported so
 * test harnesses (and any future second consumer) can construct a cache
 * with the same shape.
 */
export interface RecentlyRemovedDocsHooks {
  /** Called once per LRU eviction (after the entry has been removed). */
  onEviction?: () => void;
  /** Called after every set / delete with the post-mutation `size`. */
  onSizeChange?: (size: number) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export class RecentlyRemovedDocs {
  private readonly map = new Map<string, RemovalEntry>();
  private readonly capacity: number;
  private readonly onEviction: (() => void) | undefined;
  private readonly onSizeChange: ((size: number) => void) | undefined;
  private readonly now: () => number;

  constructor(capacity: number = DEFAULT_CAPACITY, hooks: RecentlyRemovedDocsHooks = {}) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.onEviction = hooks.onEviction;
    this.onSizeChange = hooks.onSizeChange;
    this.now = hooks.now ?? Date.now;
  }

  setRenamed(oldDocName: string, newDocName: string): void {
    this.put(oldDocName, { kind: 'renamed', newDocName, addedAt: this.now() });
  }

  setDeleted(docName: string): void {
    this.put(docName, { kind: 'deleted', addedAt: this.now() });
  }

  /**
   * Returns the entry if present and promotes it to MRU. Used by the auth
   * extension's chain-walk: each hop is a meaningful access, so promotion
   * keeps active rename chains warm in the cache.
   */
  get(docName: string): RemovalEntry | undefined {
    const entry = this.map.get(docName);
    if (entry === undefined) return undefined;
    this.map.delete(docName);
    this.map.set(docName, entry);
    return entry;
  }

  /**
   * Predicate-only lookup. Does NOT promote (matches `Map.has` semantics
   * and avoids surprise reordering when callers only need existence).
   */
  has(docName: string): boolean {
    return this.map.has(docName);
  }

  /**
   * Non-promoting read. Use when the caller wants the entry payload but
   * does not consider this access a meaningful hit (e.g. the watcher's
   * unpaired-delete guard inspects whether the entry is already a
   * spine-recorded `'renamed'` and refuses to overwrite without claiming
   * the access for LRU recency).
   */
  peek(docName: string): RemovalEntry | undefined {
    return this.map.get(docName);
  }

  delete(docName: string): void {
    if (this.map.delete(docName)) {
      this.onSizeChange?.(this.map.size);
    }
  }

  get size(): number {
    return this.map.size;
  }

  private put(docName: string, entry: RemovalEntry): void {
    // Capacity 0 means caching is disabled — accept and immediately drop so
    // hooks remain consistent (size always 0, no entries reachable).
    if (this.capacity === 0) {
      this.onSizeChange?.(0);
      return;
    }
    this.map.delete(docName);
    this.map.set(docName, entry);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.onEviction?.();
    }
    this.onSizeChange?.(this.map.size);
  }
}
