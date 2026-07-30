/**
 * In-memory thread index, the `backlink-index.ts` pattern: scan every thread
 * once at boot, hold the result in memory, and update it incrementally on
 * writes rather than re-reading per query.
 *
 * It holds the threads themselves, not just a doc pointer, so listing them
 * touches no disk at all. The list is the hot path — the app refetches the
 * whole project on every mutation and every push notification — and reading one
 * small file per thread made a single click cost O(every comment ever written).
 *
 * Nothing persists between boots. Like the backlink index, it is rebuilt from
 * the files every time, so there is no cache-invalidation problem: the files
 * remain the source of truth, this is a copy of them, and a restart re-derives
 * it. Staleness would need a writer that bypasses {@link upsert}, and the
 * server lock guarantees a single writing process.
 */

import type { CommentThreadStore } from './thread-store.ts';
import type { CommentThreadMeta } from './types.ts';

export class CommentIndex {
  private readonly threads = new Map<string, CommentThreadMeta>();
  private readonly docToThreads = new Map<string, Set<string>>();

  /** Build the index from the store. Call once at server boot. */
  async build(store: CommentThreadStore): Promise<void> {
    this.threads.clear();
    this.docToThreads.clear();
    for (const meta of await store.scanCoverSheets()) this.upsert(meta);
  }

  /**
   * Record (or replace) a thread. Idempotent, and the ONLY way a change reaches
   * the index — every write path calls this with what it just persisted, which
   * is what keeps the copy honest.
   */
  upsert(meta: CommentThreadMeta): void {
    const previous = this.threads.get(meta.threadId);
    if (previous !== undefined && previous.docName !== meta.docName) {
      this.detach(previous.docName, meta.threadId);
    }
    this.threads.set(meta.threadId, meta);
    let set = this.docToThreads.get(meta.docName);
    if (!set) {
      set = new Set();
      this.docToThreads.set(meta.docName, set);
    }
    set.add(meta.threadId);
  }

  /** Drop a deleted thread from the index. */
  remove(threadId: string): void {
    const meta = this.threads.get(threadId);
    if (meta === undefined) return;
    this.threads.delete(threadId);
    this.detach(meta.docName, threadId);
  }

  /**
   * Follow a doc rename: re-point every thread from `from` to `to`. Wired into
   * the existing rename walk alongside the link/tag indexes. Rewrites each
   * cached thread's `docName` too, or the copy would disagree with the files
   * the rename walk just updated.
   */
  renameDoc(from: string, to: string): void {
    const set = this.docToThreads.get(from);
    if (!set) return;
    this.docToThreads.delete(from);
    const dest = this.docToThreads.get(to) ?? new Set<string>();
    for (const threadId of set) {
      dest.add(threadId);
      const meta = this.threads.get(threadId);
      if (meta) this.threads.set(threadId, { ...meta, docName: to });
    }
    this.docToThreads.set(to, dest);
  }

  /** Every thread on a doc. Order-agnostic — callers sort. */
  listForDoc(docName: string): CommentThreadMeta[] {
    const out: CommentThreadMeta[] = [];
    for (const threadId of this.docToThreads.get(docName) ?? []) {
      const meta = this.threads.get(threadId);
      if (meta) out.push(meta);
    }
    return out;
  }

  /** Every thread, across every doc — the project-wide view the queue renders. */
  listAll(): CommentThreadMeta[] {
    return [...this.threads.values()];
  }

  /** Thread ids anchored to a doc (order-agnostic). */
  threadsForDoc(docName: string): string[] {
    return [...(this.docToThreads.get(docName) ?? [])];
  }

  /**
   * Unresolved-thread counts for the named docs — what a reader needs to know
   * before editing. Every requested name gets an entry (0 when it has none), so
   * a caller can tell "no comments" from "not asked about".
   *
   * Resolved threads are excluded here and in {@link countsUnderPrefix}: they
   * are settled work, and counting them would leave a doc looking permanently
   * outstanding to every agent that reads it.
   */
  countsForDocs(docNames: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const docName of docNames) out.set(docName, this.countForDoc(docName));
    return out;
  }

  /**
   * Unresolved-thread counts for every doc under a folder prefix — the folder
   * rollup an `ls` entry reports. Sparse: only docs that actually carry threads
   * appear, so a caller sums the values for a subtree total and can also name
   * which docs the total came from.
   *
   * `prefix` is a docName prefix, not a path glob. An empty prefix means the
   * whole project.
   */
  countsUnderPrefix(prefix: string): Map<string, number> {
    // A bare `docs` must not match `docsite/page` — segment-boundary the
    // prefix, and treat the empty prefix as project-wide.
    const scope = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`;
    const out = new Map<string, number>();
    for (const docName of this.docToThreads.keys()) {
      if (!docName.startsWith(scope)) continue;
      const count = this.countForDoc(docName);
      if (count > 0) out.set(docName, count);
    }
    return out;
  }

  /** Unresolved threads on one doc. */
  countForDoc(docName: string): number {
    let count = 0;
    for (const threadId of this.docToThreads.get(docName) ?? []) {
      if (this.threads.get(threadId)?.state !== 'resolved') count++;
    }
    return count;
  }

  get size(): number {
    return this.threads.size;
  }

  private detach(docName: string, threadId: string): void {
    const set = this.docToThreads.get(docName);
    if (!set) return;
    set.delete(threadId);
    if (set.size === 0) this.docToThreads.delete(docName);
  }
}
