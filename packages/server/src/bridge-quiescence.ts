import type * as Y from 'yjs';

interface DocQuiescenceCounters {
  lastUserTxGen: number;
  settledGen: number;
  /**
   * Wall-clock timestamp (ms since epoch) of the last user-origin transaction
   * — sourced from the per-tx `afterTransaction` hook. Surfaces as the
   * `wallClockMsSinceLastTransaction` telemetry attribute on the
   * `persistence-skip-non-quiescent` event so operators can correlate
   * deferral patterns with real-world user behavior.
   *
   * Lives here (not server-observers.ts) per precedent #13(b)'s spirit —
   * `Date.now()` calls flow through this module so the bridge observer
   * file stays clean of timer machinery.
   */
  lastUserTxAtMs: number | null;
}

/*
 * WARN: module-level state. Today this is correct because exactly one server
 * runs per `contentDir` per process (enforced by `server.lock`); the WeakMap
 * keys on Y.Doc *instance* identity so two doc instances with the same
 * docName naturally separate. If multi-server-per-process is ever adopted
 * (multi-vault desktop, cloud multi-tenant), `globalCounter` would still
 * increment correctly (it's just a monotonic ticker shared across all docs)
 * and the WeakMap-by-instance separation still holds, so this state remains
 * safe under that future. The watchdog's rate-limiter map at
 * `bridge-watchdog.ts:lastEmitMs` is the more concerning case — see the
 * matching WARN there. Compare with the closure-scoped `configLkgCache` in
 * `persistence.ts` (per-server-instance state for config docs) — different
 * scoping rationale: that cache keys by docName string, which would conflate
 * across servers without closure-scoping.
 */
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
 * Match the structural shape of `OBSERVER_SYNC_ORIGIN` from
 * `server-observers.ts`. Importing the constant directly would create a
 * circular dependency (`server-observers.ts` calls
 * `attachQuiescenceTracker`); the structural check is intentional here per
 * precedent #1's same rationale (origin objects are LocalTransactionOrigin
 * shapes; structural match reaches remote-arriving observer-self transactions
 * too, even though those don't actually exist in practice — Yjs transaction
 * origin metadata is local to each Y.Doc instance and never serialized over
 * the wire (`Y.applyUpdate(ydoc, update, transactionOrigin)` takes the origin
 * as a separate argument on the receiving side, not from the update bytes),
 * so the server's origin object cannot reach a remote peer's transaction.
 * `skipStoreHooks: true` is unrelated — it controls whether Hocuspocus's
 * `onStoreDocument` / `afterStoreDocument` persistence hooks fire, not
 * whether Yjs broadcasts CRDT updates to peers).
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
