import type * as Y from 'yjs';

interface DocQuiescenceCounters {
  lastUserTxGen: number;
  settledGen: number;
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
