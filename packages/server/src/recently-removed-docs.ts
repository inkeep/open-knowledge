
const DEFAULT_CAPACITY = 10_000;

export type RemovalEntry =
  | { kind: 'renamed'; newDocName: string; addedAt: number }
  | { kind: 'deleted'; addedAt: number };

export interface RecentlyRemovedDocsHooks {
  onEviction?: () => void;
  onSizeChange?: (size: number) => void;
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

  get(docName: string): RemovalEntry | undefined {
    const entry = this.map.get(docName);
    if (entry === undefined) return undefined;
    this.map.delete(docName);
    this.map.set(docName, entry);
    return entry;
  }

  has(docName: string): boolean {
    return this.map.has(docName);
  }

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
