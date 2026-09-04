import { incrementInFlightFlushExpired } from './metrics.ts';

export interface StoreFailure {
  code?: string;
  message: string;
}

const IN_FLIGHT_FLUSH_TTL_MS = 60_000;

interface PendingFlush {
  value: string;
  at: number;
}

export class DocumentDurabilityState {
  private readonly reconciledBaseByBranch = new Map<string, Map<string, string>>();
  private readonly inFlightFlushByDoc = new Map<string, PendingFlush[]>();
  private readonly agentWriteStores = new Set<string>();
  private readonly storeFailures = new Map<string, StoreFailure>();
  private readonly storeDivergences = new Set<string>();
  private activeBranch: string;
  private batchInProgress = false;

  constructor(initialBranch = 'main') {
    this.activeBranch = initialBranch;
    this.reconciledBaseByBranch.set(initialBranch, new Map());
  }

  switchReconciledBaseScope(branch: string): void {
    this.activeBranch = branch;
    if (!this.reconciledBaseByBranch.has(branch)) {
      this.reconciledBaseByBranch.set(branch, new Map());
    }
  }

  getActiveBranch(): string {
    return this.activeBranch;
  }

  getReconciledBase(docName: string): string | undefined {
    return this.reconciledBaseByBranch.get(this.activeBranch)?.get(docName);
  }

  setReconciledBase(docName: string, content: string): void {
    let bases = this.reconciledBaseByBranch.get(this.activeBranch);
    if (!bases) {
      bases = new Map();
      this.reconciledBaseByBranch.set(this.activeBranch, bases);
    }
    bases.set(docName, content);
  }

  /**
   * STOP: at the moment of this call the doc must already be outside the staleness sweep's
   * candidate set — either not loaded, or holding a frozen lifecycle status. The sweep iterates
   * loaded documents and continues on an excluded or frozen doc before it reads
   * inFlightFlushCount, which is what makes dropping the in-flight flush records here inert for
   * it. Call this with the doc still loaded and unfrozen and the sweep can force a store for a
   * doc whose own write is still physically outstanding. The reconcile guard, the other reader,
   * reads that same base and returns early without it.
   */
  deleteReconciledBase(docName: string): void {
    this.reconciledBaseByBranch.get(this.activeBranch)?.delete(docName);
    this.inFlightFlushByDoc.delete(docName);
  }

  private freshInFlightFlushes(docName: string): PendingFlush[] {
    const pending = this.inFlightFlushByDoc.get(docName);
    if (!pending) return [];
    const now = Date.now();
    const fresh = pending.filter((entry) => now - entry.at <= IN_FLIGHT_FLUSH_TTL_MS);
    if (fresh.length === pending.length) return pending;
    incrementInFlightFlushExpired(pending.length - fresh.length);
    if (fresh.length === 0) this.inFlightFlushByDoc.delete(docName);
    else this.inFlightFlushByDoc.set(docName, fresh);
    return fresh;
  }

  beginInFlightFlush(docName: string, normalizedMarkdown: string): void {
    const fresh = this.freshInFlightFlushes(docName);
    fresh.push({ value: normalizedMarkdown, at: Date.now() });
    this.inFlightFlushByDoc.set(docName, fresh);
  }

  peekInFlightFlush(docName: string): string | undefined {
    const pending = this.freshInFlightFlushes(docName);
    return pending[pending.length - 1]?.value;
  }

  inFlightFlushCount(docName: string): number {
    return this.freshInFlightFlushes(docName).length;
  }

  hasInFlightFlush(docName: string, normalizedMarkdown: string): boolean {
    return this.freshInFlightFlushes(docName).some((entry) => entry.value === normalizedMarkdown);
  }

  finishInFlightFlush(docName: string, expectedNormalizedMarkdown: string): void {
    const pending = this.freshInFlightFlushes(docName);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]?.value !== expectedNormalizedMarkdown) continue;
      pending.splice(i, 1);
      if (pending.length === 0) this.inFlightFlushByDoc.delete(docName);
      return;
    }
  }

  setBatchInProgress(value: boolean): void {
    this.batchInProgress = value;
  }

  isBatchInProgress(): boolean {
    return this.batchInProgress;
  }

  markAgentWriteStore(docName: string): void {
    this.agentWriteStores.add(docName);
  }

  consumeAgentWriteStore(docName: string): boolean {
    return this.agentWriteStores.delete(docName);
  }

  recordStoreFailure(docName: string, failure: StoreFailure): void {
    this.storeFailures.set(docName, failure);
  }

  clearStoreFailure(docName: string): void {
    this.storeFailures.delete(docName);
  }

  takeStoreFailure(docName: string): StoreFailure | null {
    const failure = this.storeFailures.get(docName) ?? null;
    this.storeFailures.delete(docName);
    return failure;
  }

  recordStoreDivergence(docName: string): void {
    this.storeDivergences.add(docName);
  }

  takeStoreDivergence(docName: string): boolean {
    return this.storeDivergences.delete(docName);
  }
}
