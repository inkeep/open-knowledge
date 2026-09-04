import type { CommentThreadStore } from './thread-store.ts';
import type { CommentThreadMeta } from './types.ts';

export class CommentIndex {
  private readonly threads = new Map<string, CommentThreadMeta>();
  private readonly docToThreads = new Map<string, Set<string>>();

  async build(store: CommentThreadStore): Promise<void> {
    this.threads.clear();
    this.docToThreads.clear();
    for (const meta of await store.scanCoverSheets()) this.upsert(meta);
  }

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

  remove(threadId: string): void {
    const meta = this.threads.get(threadId);
    if (meta === undefined) return;
    this.threads.delete(threadId);
    this.detach(meta.docName, threadId);
  }

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

  listForDoc(docName: string): CommentThreadMeta[] {
    const out: CommentThreadMeta[] = [];
    for (const threadId of this.docToThreads.get(docName) ?? []) {
      const meta = this.threads.get(threadId);
      if (meta) out.push(meta);
    }
    return out;
  }

  listAll(): CommentThreadMeta[] {
    return [...this.threads.values()];
  }

  threadsForDoc(docName: string): string[] {
    return [...(this.docToThreads.get(docName) ?? [])];
  }

  countsForDocs(docNames: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const docName of docNames) out.set(docName, this.countForDoc(docName));
    return out;
  }

  countsUnderPrefix(prefix: string): Map<string, number> {
    const scope = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`;
    const out = new Map<string, number>();
    for (const docName of this.docToThreads.keys()) {
      if (!docName.startsWith(scope)) continue;
      const count = this.countForDoc(docName);
      if (count > 0) out.set(docName, count);
    }
    return out;
  }

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
