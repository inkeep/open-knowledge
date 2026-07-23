/**
 * A disk-store failure captured out-of-band so an agent write handler can
 * report disk truth after Hocuspocus swallows a rejected store hook.
 */
export interface StoreFailure {
  code?: string;
  message: string;
}

export class DocumentDurabilityState {
  /** Last known-good markdown for each document, retained independently by branch. */
  private readonly reconciledBaseByBranch = new Map<string, Map<string, string>>();
  /**
   * Normalized snapshots for disk flushes that have started but not settled.
   * These let reconciliation distinguish this server's own just-written bytes
   * from a foreign edit during the rename-to-base-advance window.
   */
  private readonly inFlightFlushByDoc = new Map<string, string>();
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

  deleteReconciledBase(docName: string): void {
    this.reconciledBaseByBranch.get(this.activeBranch)?.delete(docName);
  }

  beginInFlightFlush(docName: string, normalizedMarkdown: string): void {
    this.inFlightFlushByDoc.set(docName, normalizedMarkdown);
  }

  peekInFlightFlush(docName: string): string | undefined {
    return this.inFlightFlushByDoc.get(docName);
  }

  finishInFlightFlush(docName: string, expectedNormalizedMarkdown: string): void {
    if (this.inFlightFlushByDoc.get(docName) === expectedNormalizedMarkdown) {
      this.inFlightFlushByDoc.delete(docName);
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
