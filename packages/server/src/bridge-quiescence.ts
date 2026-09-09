import type * as Y from 'yjs';

interface DocQuiescenceCounters {
  lastUserTxGen: number;
  settledGen: number;
  /**
   * Lives here (not server-observers.ts) per precedent #13(b)'s spirit — `Date.now()` calls flow
   * through this module so the bridge observer file stays clean of timer machinery.
   */
  lastUserTxAtMs: number | null;
}

const counters = new WeakMap<Y.Doc, DocQuiescenceCounters>();
let globalCounter = 0;

function getCounters(doc: Y.Doc): DocQuiescenceCounters {
  let c = counters.get(doc);
  if (!c) {
    c = { lastUserTxGen: 0, settledGen: 0, lastUserTxAtMs: null };
    counters.set(doc, c);
  }
  return c;
}

/**
 * Matches the structural shape of `OBSERVER_SYNC_ORIGIN` rather than importing it, which would
 * make `server-observers.ts` circular. Origin objects are `LocalTransactionOrigin` shapes and a
 * structural match is the sanctioned form (precedent #1).
 */
function isObserverSelfOrigin(origin: unknown): boolean {
  if (!origin || typeof origin !== 'object') return false;
  const ctx = (origin as { context?: { origin?: unknown } }).context;
  return ctx !== undefined && ctx !== null && ctx.origin === 'observer-sync';
}

export function attachQuiescenceTracker(doc: Y.Doc): () => void {
  const onAfterTransaction = (tx: Y.Transaction): void => {
    if (isObserverSelfOrigin(tx.origin)) return;
    const c = getCounters(doc);
    c.lastUserTxGen = ++globalCounter;
    c.lastUserTxAtMs = Date.now();
  };
  const onAfterAllTransactions = (): void => {
    getCounters(doc).settledGen = ++globalCounter;
  };
  doc.on('afterTransaction', onAfterTransaction);
  doc.on('afterAllTransactions', onAfterAllTransactions);
  return () => {
    doc.off('afterTransaction', onAfterTransaction);
    doc.off('afterAllTransactions', onAfterAllTransactions);
  };
}

const overrides = new WeakMap<Y.Doc, boolean>();

export function isDocQuiescent(doc: Y.Doc): boolean {
  const override = overrides.get(doc);
  if (override !== undefined) return override;
  const c = counters.get(doc);
  if (!c) return true;
  return c.settledGen > c.lastUserTxGen;
}

export function __setQuiescentOverrideForTests(doc: Y.Doc, value: boolean | undefined): void {
  if (value === undefined) overrides.delete(doc);
  else overrides.set(doc, value);
}

export function getMsSinceLastUserTx(doc: Y.Doc, nowMs: number = Date.now()): number | null {
  const c = counters.get(doc);
  if (!c || c.lastUserTxAtMs === null) return null;
  return Math.max(0, nowMs - c.lastUserTxAtMs);
}

export function getQuiescenceCountersForTests(doc: Y.Doc): DocQuiescenceCounters | undefined {
  return counters.get(doc);
}

export function __resetQuiescenceForTests(): void {
  globalCounter = 0;
}
