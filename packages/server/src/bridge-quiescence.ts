/**
 * Per-document quiescence tracker for the persistence quiescence gate.
 *
 * Persistence's debounce can fire mid-burst when Hocuspocus's `maxDebounce` cap
 * elapses before any 2-second pause — at that point the in-memory Y.Doc is
 * still being mutated and the bridge invariant may be transient. The
 * quiescence gate skips that store cycle (and the debounce retries on its
 * normal cadence) until at least one `afterAllTransactions` settlement has
 * landed since the last user-origin transaction.
 *
 * Tracking model — single monotonic counter; per-doc state captures:
 *   - `lastUserTxGen`: the counter value at the last user-origin transaction
 *     (any non-observer-self origin — agents, file-watcher, source-mode,
 *     property-panel form, paired-write origins, all count as user-origin
 *     for quiescence purposes).
 *   - `settledGen`: the counter value at the last `afterAllTransactions`
 *     settlement.
 *
 * Quiescent ⇔ `settledGen > lastUserTxGen` — afterAll has fired since the
 * last user write. New docs (no observed transactions) are trivially
 * quiescent.
 *
 * Observer-self transactions (`OBSERVER_SYNC_ORIGIN` from
 * `server-observers.ts`) are NOT user-origin — they're the bridge syncing
 * its derived view from a prior user write. Counting them would fire-flip
 * the gate every drain (Observer A's nested transact during settlement
 * dispatch would bump `lastUserTxGen` past `settledGen` for the same drain).
 *
 * Companion to the persistence max-defer cap: this predicate is the *gate*;
 * the persistence layer holds the *deferral counter*. After N consecutive
 * deferrals (default 8 ≈ 16 s of sustained typing), persistence force-flushes
 * to bound staleness.
 */

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

// WARN: module-level state. Today this is correct because exactly one server
// runs per `contentDir` per process (enforced by `server.lock`); the WeakMap
// keys on Y.Doc *instance* identity so two doc instances with the same
// docName naturally separate. If multi-server-per-process is ever adopted
// (multi-vault desktop, cloud multi-tenant), `globalCounter` would still
// increment correctly (it's just a monotonic ticker shared across all docs)
// and the WeakMap-by-instance separation still holds, so this state remains
// safe under that future. The watchdog's rate-limiter map at
// `bridge-watchdog.ts:lastEmitMs` is the more concerning case — see the
// matching WARN there. Compare with the closure-scoped `configLkgCache` in
// `persistence.ts` (per-server-instance state for config docs) — different
// scoping rationale: that cache keys by docName string, which would conflate
// across servers without closure-scoping.
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

/**
 * Hook quiescence tracking onto a Y.Doc. Returns a detach function — the
 * caller is responsible for invoking it on doc unload (per the
 * Hocuspocus extension lifecycle).
 *
 * Usage shape mirrors `setupServerObservers`'s cleanup contract: attach in
 * afterLoadDocument, detach in afterUnloadDocument.
 */
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

/**
 * Per-doc override for testing the persistence gate. Production code never
 * sets these — only the `__setQuiescentOverrideForTests` test seam does.
 * Yjs's `afterAllTransactions` fires synchronously after every drain, so
 * a naturally non-quiescent moment doesn't survive the next event-loop
 * tick — the override is the only way to drive the gate's skip path
 * from a test that runs on the same loop.
 */
const overrides = new WeakMap<Y.Doc, boolean>();

/**
 * Returns `true` IFF the document's `afterAllTransactions` settlement has
 * fired since the last user-origin transaction. New docs (never observed)
 * are trivially quiescent.
 *
 * If a test override is set (`__setQuiescentOverrideForTests`), that value
 * wins.
 */
export function isDocQuiescent(doc: Y.Doc): boolean {
  const override = overrides.get(doc);
  if (override !== undefined) return override;
  const c = counters.get(doc);
  if (!c) return true;
  return c.settledGen > c.lastUserTxGen;
}

/**
 * Test seam — pin `isDocQuiescent(doc)` to return `value` regardless of
 * actual counter state. Pass `undefined` to clear the override and resume
 * counter-driven decisions.
 *
 * Used by integration tests to drive the persistence gate's skip path
 * (Yjs always synchronously settles after every drain, so a naturally
 * non-quiescent moment doesn't survive event-loop ticks).
 */
export function __setQuiescentOverrideForTests(doc: Y.Doc, value: boolean | undefined): void {
  if (value === undefined) overrides.delete(doc);
  else overrides.set(doc, value);
}

/**
 * Wall-clock milliseconds since the last user-origin transaction landed on
 * this doc, or `null` if no user-origin transaction has been observed yet.
 *
 * Used as bounded-cardinality telemetry on `persistence-skip-non-quiescent`
 * — the value reflects how long the user has been actively typing without a
 * settlement window, complementing the `deferCount` (which counts persistence
 * cycles).
 *
 * Test seam: pass `nowMs` to make the read deterministic without monkey-
 * patching Date.now().
 */
export function getMsSinceLastUserTx(doc: Y.Doc, nowMs: number = Date.now()): number | null {
  const c = counters.get(doc);
  if (!c || c.lastUserTxAtMs === null) return null;
  return Math.max(0, nowMs - c.lastUserTxAtMs);
}

/**
 * Test seam — read raw counter state for assertions. Production code uses
 * `isDocQuiescent` / `getMsSinceLastUserTx` only.
 */
export function getQuiescenceCountersForTests(doc: Y.Doc): DocQuiescenceCounters | undefined {
  return counters.get(doc);
}

/**
 * Test seam — reset the global counter so cross-test runs start from a known
 * baseline. WeakMap entries can't be enumerated; per-doc state drops when
 * the doc gets GC'd or when the test creates a fresh doc.
 */
export function __resetQuiescenceForTests(): void {
  globalCounter = 0;
}
