/**
 * syncPromise — React-19-idiomatic subscription-to-event primitive that bridges
 * HocuspocusProvider's `synced` event to React Suspense via `use(promise)`.
 *
 * Module-level cache by docName. Promise identity is stable across renders —
 * React Compiler-safe because module state is out of compiler scope, and
 * `use(promise)` requires the same reference across remounts / StrictMode
 * double-invoke to avoid infinite suspension.
 *
 * Lifecycle:
 *   - `syncPromise(docName, provider)` creates or returns the cached promise.
 *     Attaches `synced` + `close` listeners and starts a 30s timeout.
 *   - On `synced`: resolve + auto-cleanup (listeners off, timeout cleared, cache entry removed).
 *   - On pre-sync `close`: reject with PreSyncDisconnectError + cleanup.
 *   - On 30s timeout: reject with SyncTimeoutError + cleanup.
 *   - `invalidateSyncPromise(docName)` tears the entry down without rejecting
 *     (provider-pool calls this on destroy/recycle; the next `syncPromise` call
 *     creates a fresh promise).
 */

import type { HocuspocusProvider, onCloseParameters } from '@hocuspocus/provider';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { emitColdMountChild, finalizeColdMountSpan } from '@/lib/perf/otel-spans';
import { firstContent } from '@/lib/perf/startup-marks';
import { getMountId } from './mount-id-registry';

/**
 * Per-call accessor for the sync-timeout dial. Reads the override on every
 * invocation so a Playwright `addInitScript`, a DevTools paste, or an
 * in-session sweep override takes effect without
 * a module reload. Mirrors the sibling pattern in `mount-promise.ts`
 * (`getThresholdMs`) and `prewarm-correlation.ts` (`getTtlMs`).
 */
export function getSyncTimeoutMs(): number {
  return readNumericOverride('SYNC_TIMEOUT_MS', 30_000);
}

/**
 * ⚠️ Class-name vs user-copy seam.
 *
 * Class names below (`SyncTimeoutError`, `PreSyncDisconnectError`,
 * `BridgeSetupError`, `DocumentNotFoundError`) describe the wire-level
 * mechanism — they're what telemetry / Sentry / dev-tools see. User-facing
 * copy is translated via `errorCopy()` in
 * `packages/app/src/components/DocumentErrorBoundary.tsx` into the
 * "load/loading" vocabulary the product uses. DO NOT propagate the word
 * "sync" into user-facing strings from these class names; always route
 * through `errorCopy()`. If you add a new error class here, add a matching
 * `errorCopy` arm before the generic fallback.
 */

export class SyncTimeoutError extends Error {
  readonly docName: string;
  readonly elapsedMs: number;
  constructor(docName: string, elapsedMs: number) {
    super(`Sync timed out for "${docName}" after ${elapsedMs}ms`);
    this.name = 'SyncTimeoutError';
    this.docName = docName;
    this.elapsedMs = elapsedMs;
  }
}

export class PreSyncDisconnectError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Provider disconnected before sync for "${docName}"`);
    this.name = 'PreSyncDisconnectError';
    this.docName = docName;
  }
}

/**
 * Document lookup failed (not yet surfaced by the current sync pipeline — reserved
 * so the error-boundary copy taxonomy is complete and future sync paths can throw
 * a typed instance instead of a generic Error).
 */
export class DocumentNotFoundError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Document not found: "${docName}"`);
    this.name = 'DocumentNotFoundError';
    this.docName = docName;
  }
}

/**
 * Bridge setup failed during `setupObservers` initialization in `ProviderPool`.
 * Surfaced through the syncPromise so the user gets a deterministic error UI
 * (DocumentErrorBoundary's "Try again") instead of a silent fall-back to the
 * "Select a document" empty state. Without this, an init throw would close the
 * provider, null out `activeDocName`, and leave the user with no signal about
 * what happened or what to do next.
 */
export class BridgeSetupError extends Error {
  readonly docName: string;
  readonly cause?: unknown;
  constructor(docName: string, cause?: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
    super(`Bridge setup failed for "${docName}": ${causeMsg}`);
    this.name = 'BridgeSetupError';
    this.docName = docName;
    this.cause = cause;
  }
}

/**
 * Server connected but lacks a capability we need (today: WebSocket
 * collab). Reserved for a future renderer-side capability check that can
 * detect post-attach divergence (e.g., `/api/server-info` claims `ws` but
 * the upgrade handler is missing). The desktop's pre-attach probe in
 * window-manager closes the same hole before the renderer mounts; this
 * class is the parallel error class for the renderer-side failure mode
 * so `errorCopy` has a complete taxonomy.
 */
export class ServerCapabilityMismatchError extends Error {
  readonly docName: string;
  readonly missingCapability: string;
  constructor(docName: string, missingCapability: string) {
    super(`Server is missing capability "${missingCapability}" required to open "${docName}".`);
    this.name = 'ServerCapabilityMismatchError';
    this.docName = docName;
    this.missingCapability = missingCapability;
  }
}

interface CacheEntry {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  createdAt: number;
  /** null when the entry is a settled sentinel (warm-path or post-settle). */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  provider: HocuspocusProvider;
  onSynced: () => void;
  onClose: (data: onCloseParameters) => void;
  settled: boolean;
  /**
   * True only on resolve paths (warm-provider sentinel + onSynced firing).
   * Distinguishes "the consumer's `use()` will short-circuit synchronously"
   * (resolved=true) from "the consumer's `use()` will throw to error
   * boundary" (settled=true && resolved=false). Read by the public
   * `syncPromiseHasResolved` helper so the EditorArea deferred-value
   * skeleton overlay can skip the warm-reopen flash.
   */
  resolved: boolean;
  /**
   * True when listeners have been removed and timeout cleared (sentinel state).
   *
   * Invariant: `detached` implies `settled` — never set `detached: true` without
   * first setting `settled: true`. Every caller of `detach(entry)` below does
   * this in order (see the settle helpers at `resolveSyncPromise`,
   * `rejectSyncPromise`, `timeoutSyncPromise`, `invalidateSyncPromise`, and
   * `__resetSyncPromiseCache`). Future modifiers: preserve the ordering so the
   * sentinel state `{settled: true, detached: true}` is the only terminal one
   * the rest of the module ever observes.
   */
  detached: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Visibility-change handler installed lazily on first pending entry. Browsers
 * aggressively throttle (and sometimes pause outright) `setTimeout` in
 * backgrounded tabs — a 30s timer armed before a tab-sleep won't fire at 30s
 * of wall-clock time, leaving the Suspense fallback stuck with no rejection
 * arriving to trigger the error boundary. On every flip to
 * `document.visibilityState === 'visible'`, re-check elapsed time against
 * every pending entry and reject any that have exceeded the timeout — the
 * `setTimeout` stays as best-effort scheduler but the visibility handler
 * makes the timeout deterministic.
 *
 * Installed once the first pending entry exists and torn down when the cache
 * has no pending entries, so the listener never runs when there's nothing to
 * check. Uses `Date.now()` because it measures real wall-clock time even when
 * the tab was backgrounded (unlike `performance.now()`, which may freeze in
 * some engines under background tab throttling).
 */
let visibilityHandlerInstalled = false;

function hasPendingEntries(): boolean {
  for (const entry of cache.values()) {
    if (!entry.settled) return true;
  }
  return false;
}

function checkTimeoutsOnVisible(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  __reapTimedOutEntries(Date.now());
}

/**
 * Test-only: pure timeout-reaping for a given wall-clock `now`. Visible to
 * unit tests so the visibility-restore path can be verified without a DOM
 * (Bun's test env does not expose `document`). Production call path is
 * `checkTimeoutsOnVisible` which wraps this with the DOM-gate.
 *
 * Returns the number of entries rejected — tests assert on the count.
 *
 * Emits a single consolidated warn summarizing all reaped entries rather than
 * one warn per entry. Volume is bounded by `ACTIVITY_MOUNT_LIMIT = 3` so
 * per-entry logging was already small, but a single summary keeps dev-console
 * output cleaner when a user wakes a laptop that had 2-3 docs pending.
 */
export function __reapTimedOutEntries(now: number): number {
  const reaped: Array<{ docName: string; elapsedMs: number }> = [];
  for (const [docName, entry] of cache) {
    if (entry.settled) continue;
    const elapsed = now - entry.createdAt;
    if (elapsed < getSyncTimeoutMs()) continue;
    entry.settled = true;
    const error = new SyncTimeoutError(docName, elapsed);
    detach(entry);
    entry.reject(error);
    // Close the cold-mount root span for this cycle. The pool's
    // `emitColdMountChild` lazily creates the root entry on pool MISS; without
    // this finalize the entry's Span + Map key would never be released.
    // `finalizeColdMountSpan` is idempotent and safe when no root exists.
    const reapMountId = getMountId(docName);
    if (reapMountId !== undefined) finalizeColdMountSpan(reapMountId);
    reaped.push({ docName, elapsedMs: elapsed });
  }
  if (reaped.length > 0) {
    const summary = reaped.map((r) => `${r.docName} (${r.elapsedMs}ms)`).join(', ');
    console.warn(
      `[syncPromise] reaped ${reaped.length} timed-out ${
        reaped.length === 1 ? 'entry' : 'entries'
      } on visibility restore (tab-sleep recovered): ${summary}`,
    );
  }
  if (!hasPendingEntries()) uninstallVisibilityHandler();
  return reaped.length;
}

function installVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', checkTimeoutsOnVisible);
  visibilityHandlerInstalled = true;
}

function uninstallVisibilityHandler(): void {
  if (!visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', checkTimeoutsOnVisible);
  visibilityHandlerInstalled = false;
}

/**
 * Test-only armed-rejection map. When `__test_armPendingRejection(docName, kind)`
 * is called, the next `syncPromise(docName, provider)` creation path checks
 * this map and rejects the freshly-created promise immediately with the armed
 * error kind. Load-bearing for e2e tests on localhost where sync completes in
 * a few ms — a post-hoc `__test_rejectSyncPromise` polling loop races the real
 * sync and cannot reliably catch the window before the entry settles. Arming
 * BEFORE navigation guarantees the rejection fires on the first creation.
 *
 * Scoped with `armedRejections` (not merged into `cache`) because the arm is
 * a one-shot prime that only fires on the NEXT creation — it must not
 * interfere with entries that already exist (e.g. warm-provider sentinels from
 * a prior mount).
 */
const armedRejections = new Map<string, 'timeout' | 'predisconnect'>();

function detach(entry: CacheEntry): void {
  if (entry.detached) return;
  entry.detached = true;
  if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle);
  // HocuspocusProvider extends EventEmitter whose `off()` short-circuits when
  // no callbacks are registered (verified at @hocuspocus/provider/src/EventEmitter.ts).
  // After destroy(), `removeAllListeners()` empties the callback map, so a
  // subsequent off() is a safe no-op. No try/catch needed — if off() throws,
  // something is structurally wrong and the noise should surface.
  entry.provider.off('synced', entry.onSynced);
  entry.provider.off('close', entry.onClose);
}

/**
 * Returns the cached promise for `docName`, creating one if absent.
 *
 * **Cache lifecycle:** entries persist across resolution and rejection — they
 * are removed only by `invalidateSyncPromise` (or by `ProviderPool.destroyEntry`
 * which calls invalidate). This is load-bearing for two distinct correctness
 * properties:
 *
 *   1. **Rejection survives React re-render.** When a syncPromise rejects, the
 *      DocumentBoundary's `use()` re-throws and the React error boundary
 *      schedules a re-render. During that re-render, DocumentBoundary calls
 *      `syncPromise(docName, provider)` again. If the cache had been cleared
 *      on rejection, syncPromise would create a NEW promise — and for a
 *      warm provider (`provider.synced=true`), the warm-path would resolve
 *      immediately, masking the prior rejection. The boundary would never
 *      catch and the user would see a broken editor instead of the error UI.
 *      Keeping the rejected promise in cache means React's `use()` sees the
 *      same `.status='rejected'` thenable and throws synchronously.
 *
 *   2. **Warm-path stability.** Repeat calls return the same resolved promise
 *      reference — once React has marked it `.status='fulfilled'`, subsequent
 *      `use()` calls short-circuit without a Suspense cycle.
 *
 * The promise resolves when the given provider next emits `synced`, rejects
 * with `PreSyncDisconnectError` if the provider emits `close` before `synced`,
 * and rejects with `SyncTimeoutError` after 30s. Call `invalidateSyncPromise`
 * to tear down (drops the entry; the orphaned promise neither resolves nor
 * rejects further).
 *
 * **Warm-provider fast path:** if the provider has already synced (e.g.
 * pool-resident from a prior mount), `provider.synced` is true and the
 * `'synced'` event has already fired and will not fire again — Hocuspocus's
 * `set synced(value)` is a no-op when the value is unchanged. Returning a
 * pre-resolved promise here is what makes the "cold mount, warm content" path
 * (precedent #18(c)) work — without this gate, every
 * Activity-evicted-but-pool-resident revisit would hang for 30s waiting on a
 * listener that can never fire. The first call still pays one Suspense cycle
 * (Promise.resolve has no React `.status` field on first read); subsequent calls
 * return the same cached reference and short-circuit.
 */
export function syncPromise(docName: string, provider: HocuspocusProvider): Promise<void> {
  const existing = cache.get(docName);
  if (existing) return existing.promise;

  // Test-only: if a rejection was armed for this docName via
  // `__test_armPendingRejection`, fire it immediately on first creation so
  // the DocumentBoundary's `use()` throws and the error boundary catches.
  // Must be checked BEFORE the warm-provider fast path — otherwise an
  // already-synced provider would resolve, masking the armed rejection.
  const armed = armedRejections.get(docName);
  if (armed !== undefined) {
    armedRejections.delete(docName);
    const error =
      armed === 'timeout' ? new SyncTimeoutError(docName, 0) : new PreSyncDisconnectError(docName);
    console.warn(
      `[syncPromise] ${docName} rejected on creation (test hook, armed ${armed}): ${error.message}`,
    );
    mark('ok/sync/create', { docName, mountId: getMountId(docName), warm: false, armed });
    mark('ok/sync/reject', { docName, mountId: getMountId(docName), reason: `armed-${armed}` });
    // Build a pre-settled thenable with `status='rejected'` + `reason=error`.
    // React's `use()` checks `status` synchronously (React 19 shape per
    // `react/src/ReactUseHook.js`): an already-rejected thenable throws on
    // first access WITHOUT suspending. This is load-bearing — a naive
    // `Promise.reject(error)` settles on a microtask, so `use()` would
    // suspend once (showing Suspense fallback) before re-rendering and
    // throwing. During that suspend window the sibling Activity subtrees
    // still render and can crash if a passive effect on a warm editor
    // touches a torn-down ProseMirror view. Synchronous throw keeps the
    // error surface isolated to the DocumentBoundary that owns this promise.
    const promise = createRejectedThenable<void>(error);
    cache.set(docName, makeRejectedSentinelEntry(promise, provider));
    return promise;
  }

  if (provider.synced) {
    console.log(`[syncPromise] ${docName} resolved synchronously (warm provider)`);
    const warmMountId = getMountId(docName);
    mark('ok/sync/create', { docName, mountId: warmMountId, warm: true });
    mark('ok/sync/resolve', { docName, mountId: warmMountId, elapsedMs: 0, warm: true });
    // Feed the resolve distribution the convention-cap-graduation sweep drains
    // via getHistogramSnapshot. Bucket name is kebab-case (the mark-name regex
    // rejects dots in the third segment). The paired mark emitted by
    // mark.histogram carries `warm: true` so cold-only filtering in the sweep
    // is possible from the marks side; the histogram itself aggregates both
    // paths into one bucket and the sweep separates samples at the mark level.
    // The mountId prop is omitted when undefined to keep the paired mark's
    // schema clean (the sweep always provisions a mountId before navigating).
    mark.histogram(
      'ok/sync/resolve-elapsed-ms',
      warmMountId !== undefined
        ? { docName, mountId: warmMountId, warm: true }
        : { docName, warm: true },
      0,
    );
    const promise = Promise.resolve();
    cache.set(docName, makeSentinelEntry(promise, provider));
    return promise;
  }

  const createdAt = Date.now();
  let resolveFn: () => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const onSynced = () => {
    const entry = cache.get(docName);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.resolved = true;
    const elapsed = Date.now() - entry.createdAt;
    console.log(`[syncPromise] ${docName} resolved in ${elapsed}ms`);
    const coldMountId = getMountId(docName);
    mark('ok/sync/resolve', {
      docName,
      mountId: coldMountId,
      elapsedMs: elapsed,
      warm: false,
    });
    // Feed the resolve distribution the convention-cap-graduation sweep drains
    // via getHistogramSnapshot. Cold path omits `warm` so the paired mark is
    // distinguishable from the warm-path emit at the same bucket name.
    // The mountId prop is omitted when undefined (sweep always provisions one).
    mark.histogram(
      'ok/sync/resolve-elapsed-ms',
      coldMountId !== undefined ? { docName, mountId: coldMountId } : { docName },
      elapsed,
    );
    detach(entry);
    if (!hasPendingEntries()) uninstallVisibilityHandler();
    // Settle the promise BEFORE OTel emission so a misbehaving SDK cannot
    // strand React's `use(promise)` in an infinite suspend. The OTel API
    // contract says startSpan/end must not throw, but an opt-in SDK fault
    // would otherwise block the user path. Keep entry in cache.
    entry.resolve();
    // Startup waterfall: the first doc to finish its cold-mount sync this
    // session is the launch's active/initial document, so its resolve is the
    // first-content checkpoint. `firstContent` is idempotent — later doc syncs
    // (navigation) don't move the mark.
    firstContent();
    // Emit ok.sync-promise as a descendant of the ok.cold-mount root, and
    // finalize the root — sync-resolve is typically the last cold-mount
    // child to complete. No-op when OTel is disabled; gated on mountId
    // presence because the cold-mount span tree is keyed by mountId.
    if (coldMountId !== undefined) {
      const nowMs = Date.now();
      emitColdMountChild(
        coldMountId,
        'ok.sync-promise',
        { 'doc.name': docName, elapsed_ms: elapsed },
        entry.createdAt,
        nowMs,
      );
      finalizeColdMountSpan(coldMountId, nowMs);
    }
  };

  const onClose = (_data: onCloseParameters) => {
    const entry = cache.get(docName);
    if (!entry || entry.settled) return;
    entry.settled = true;
    const error = new PreSyncDisconnectError(docName);
    console.warn(`[syncPromise] ${docName} rejected: ${error.message}`);
    const closeMountId = getMountId(docName);
    mark('ok/sync/reject', {
      docName,
      mountId: closeMountId,
      reason: 'pre-sync-disconnect',
    });
    detach(entry);
    if (!hasPendingEntries()) uninstallVisibilityHandler();
    entry.reject(error);
    // Close the cold-mount root span symmetrically with the resolve path —
    // otherwise the pool's lazily-created root entry leaks (Map key + un-ended
    // Span). Idempotent + safe when no root exists.
    if (closeMountId !== undefined) finalizeColdMountSpan(closeMountId);
  };

  const timeoutHandle = setTimeout(() => {
    const entry = cache.get(docName);
    if (!entry || entry.settled) return;
    entry.settled = true;
    const elapsed = Date.now() - entry.createdAt;
    const error = new SyncTimeoutError(docName, elapsed);
    console.warn(`[syncPromise] ${docName} rejected: ${error.message}`);
    const timeoutMountId = getMountId(docName);
    mark('ok/sync/reject', {
      docName,
      mountId: timeoutMountId,
      reason: 'timeout',
      elapsedMs: elapsed,
    });
    detach(entry);
    if (!hasPendingEntries()) uninstallVisibilityHandler();
    entry.reject(error);
    // Mirror the resolve-path finalize so the timeout class of reject leaves
    // the cold-mount tree in the same terminal state as a successful sync.
    if (timeoutMountId !== undefined) finalizeColdMountSpan(timeoutMountId);
  }, getSyncTimeoutMs());

  const entry: CacheEntry = {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    createdAt,
    timeoutHandle,
    provider,
    onSynced,
    onClose,
    settled: false,
    resolved: false,
    detached: false,
  };

  // Cache first, then attach listeners — so any synchronously-fired callback
  // can find the entry via `cache.get(docName)`. EventEmitter.on() does not
  // emit past events, so this ordering is currently belt-and-suspenders, but
  // making it explicit keeps the invariant safe against future provider
  // implementations that might change that contract.
  cache.set(docName, entry);
  provider.on('synced', onSynced);
  provider.on('close', onClose);

  // Arm visibility-change watchdog so a tab-sleep that throttles setTimeout
  // doesn't leave this entry stuck as a non-terminating pending promise.
  installVisibilityHandler();

  mark('ok/sync/create', { docName, mountId: getMountId(docName), warm: false });

  return promise;
}

/**
 * Build a settled sentinel cache entry for the warm-provider fast path. No
 * listeners attached, no timeout armed — just enough shape that `detach` and
 * `invalidateSyncPromise` remain safe to call.
 */
function makeSentinelEntry(promise: Promise<void>, provider: HocuspocusProvider): CacheEntry {
  return {
    promise,
    resolve: () => {},
    reject: () => {},
    createdAt: Date.now(),
    timeoutHandle: null,
    provider,
    onSynced: () => {},
    onClose: () => {},
    settled: true,
    resolved: true,
    detached: true,
  };
}

/**
 * Create a pre-settled rejected thenable with the `status`/`reason` shape
 * React's `use()` hook reads synchronously. Unlike `Promise.reject(error)`
 * (which settles on a microtask so `use()` suspends once before throwing),
 * this throws on first `use()` access — important for test paths that
 * must not suspend the DocumentBoundary at all. See the caller in
 * `syncPromise` for the suspend-sensitive rationale.
 *
 * React does NOT need a real Promise — it type-checks for the Thenable
 * shape (an object with `.then`, plus optional `.status`/`.value`/`.reason`).
 * We add a dummy `.catch` so the value still satisfies `Promise<void>` for
 * downstream callers (which only await it via `use()` in practice). We also
 * call `.catch(() => {})` on a real Promise under the hood to swallow the
 * unhandled-rejection signal without needing browser-level tracking.
 */
function createRejectedThenable<T>(error: Error): Promise<T> {
  const settled = Promise.reject(error) as Promise<T>;
  // Ensure unhandled-rejection warnings are swallowed — `use()` consumers
  // observe the rejection synchronously via status/reason and don't attach
  // `.then` themselves, so the underlying Promise sees no consumer.
  settled.catch(() => {});
  // React inspects these fields as a plain-object protocol — attach them
  // directly (cast-through-unknown since the stock Promise type doesn't
  // have them).
  const thenable = settled as unknown as Promise<T> & {
    status: 'rejected';
    reason: Error;
  };
  thenable.status = 'rejected';
  thenable.reason = error;
  return thenable;
}

/**
 * Build a settled sentinel cache entry for an armed-rejection. Mirrors
 * `makeSentinelEntry` shape but reflects that the entry is pre-rejected —
 * kept in cache so React's `use()` on the same reference across re-renders
 * throws synchronously (see syncPromise lifecycle docstring).
 */
function makeRejectedSentinelEntry(
  promise: Promise<void>,
  provider: HocuspocusProvider,
): CacheEntry {
  return {
    promise,
    resolve: () => {},
    reject: () => {},
    createdAt: Date.now(),
    timeoutHandle: null,
    provider,
    onSynced: () => {},
    onClose: () => {},
    settled: true,
    resolved: false,
    detached: true,
  };
}

/**
 * Returns true when the cached promise for `docName` has resolved
 * successfully — i.e., the consumer's `use(promise)` will short-circuit
 * synchronously without a Suspense fallback.
 *
 * Distinct from `__syncPromiseSettled` (test-only): "settled" includes
 * rejected entries that will throw to the error boundary. This helper only
 * returns true when the entry's outcome is success.
 *
 * Used by `EditorArea.tsx` to gate the deferred-value skeleton overlay
 * (see `mountPromiseHasResolved` in mount-promise.ts for the full
 * rationale). Both must be true for the skeleton overlay to skip.
 */
export function syncPromiseHasResolved(docName: string): boolean {
  return cache.get(docName)?.resolved === true;
}

/**
 * Remove the cached entry for `docName` without settling the promise. Called
 * from ProviderPool on destroy/recycle so the next `syncPromise(docName, provider)`
 * call returns a fresh promise bound to the replacement provider.
 *
 * Any pending consumer that holds the old promise via `use()` will not see it
 * settle — that consumer should have unmounted (Suspense fallback / Error boundary)
 * by the time invalidation runs.
 */
export function invalidateSyncPromise(docName: string): void {
  const entry = cache.get(docName);
  if (!entry) return;
  entry.settled = true;
  detach(entry);
  cache.delete(docName);
  if (!hasPendingEntries()) uninstallVisibilityHandler();
}

/**
 * Reject the cached syncPromise for `docName` with a specific error. Used by
 * `ProviderPool` to surface deterministic init failures (e.g. `BridgeSetupError`
 * from `setupObservers`) through the React error boundary instead of silently
 * tearing down. No-op if no entry exists.
 *
 * The entry stays in cache after rejection — see syncPromise lifecycle docstring
 * for why (rejected promise must survive React re-render so `use()` re-throws
 * synchronously instead of resolving via a freshly-created warm-path promise).
 *
 * Returns true if an entry was rejected, false otherwise.
 */
export function rejectSyncPromise(docName: string, error: Error): boolean {
  const entry = cache.get(docName);
  if (!entry || entry.settled) return false;
  entry.settled = true;
  console.warn(`[syncPromise] ${docName} rejected: ${error.message}`);
  detach(entry);
  if (!hasPendingEntries()) uninstallVisibilityHandler();
  entry.reject(error);
  // Close the cold-mount root span — same rationale as the resolve and
  // timeout paths. ProviderPool's deterministic init-failure surface (the
  // primary caller) emits `emitColdMountChild` before invoking this helper,
  // so the lazily-created root entry must be released here.
  const rejectMountId = getMountId(docName);
  if (rejectMountId !== undefined) finalizeColdMountSpan(rejectMountId);
  return true;
}

/**
 * Test-only helper: clear all cached entries. Exported for unit tests that
 * need a clean slate between cases without discarding the pool state. Also
 * clears any pending armed rejections so tests cannot leak state.
 */
export function __resetSyncPromiseCache(): void {
  for (const entry of cache.values()) {
    entry.settled = true;
    detach(entry);
  }
  cache.clear();
  armedRejections.clear();
  uninstallVisibilityHandler();
}

/**
 * Test-only helper: report whether the cache entry for `docName` has settled.
 * Exposed so tests can assert "cache stable but settled" semantics without
 * relying on cache size, which now persists settled entries by design.
 */
export function __syncPromiseSettled(docName: string): boolean {
  return cache.get(docName)?.settled ?? false;
}

/**
 * Test-only helper: report cache size. Exported for unit tests.
 */
export function __syncPromiseCacheSize(): number {
  return cache.size;
}

/**
 * Test-only helper: force-reject the cached syncPromise for `docName`.
 *
 * Used by Playwright E2E (see packages/app/tests/stress/docs-open.e2e.ts) to
 * exercise DocumentErrorBoundary recovery paths that are otherwise hard to
 * trigger — sync never fires (requires 30s wait) or pre-sync disconnect
 * (requires a real network-level event).
 *
 * Returns `true` if an entry was found and rejected, `false` otherwise.
 *
 * Safe in production: the cache is a local module-level data structure; there
 * is no security boundary crossed by rejecting an entry that a legitimate
 * consumer could simply invalidate via `invalidateSyncPromise`. The helper is
 * exposed so tests can force error-boundary rendering without shipping a
 * dev-only build flag.
 *
 * **Race note:** on localhost where real sync completes in ~3ms, the cache
 * entry is already resolved/removed before a post-hoc polling loop can
 * observe it. Tests that want to deterministically fail the NEXT sync should
 * use `__test_armPendingRejection(docName, kind)` BEFORE triggering
 * navigation — the arm fires on promise creation, winning the race by
 * construction.
 */
export function __rejectSyncPromise(
  docName: string,
  kind: 'timeout' | 'disconnect' = 'timeout',
): boolean {
  const entry = cache.get(docName);
  if (!entry || entry.settled) return false;
  entry.settled = true;
  const elapsed = Date.now() - entry.createdAt;
  const error =
    kind === 'timeout'
      ? new SyncTimeoutError(docName, elapsed)
      : new PreSyncDisconnectError(docName);
  console.warn(`[syncPromise] ${docName} force-rejected (test hook): ${error.message}`);
  detach(entry);
  if (!hasPendingEntries()) uninstallVisibilityHandler();
  // Entry stays in cache (post-settle sentinel) — see syncPromise lifecycle docstring.
  entry.reject(error);
  return true;
}

/**
 * Test-only helper: arm a rejection to fire on the NEXT `syncPromise(docName, ...)`
 * creation. Complements `__rejectSyncPromise` for a different timing regime:
 *
 *   - `__rejectSyncPromise` rejects an existing cached entry. Works when the
 *     promise is still pending. Races the real sync event on localhost where
 *     round-trips are sub-10ms — by the time a polling loop fires, the entry
 *     has already resolved + transitioned to the settled sentinel state
 *     (`.settled=true`), so the helper returns false and the test sees a
 *     successfully-synced editor instead of the error boundary.
 *
 *   - `__test_armPendingRejection` stages a rejection for the NEXT creation.
 *     Must be called BEFORE the navigation that creates the cache entry.
 *     On the next `syncPromise(docName, provider)` call, the function checks
 *     `armedRejections`, rejects the returned promise immediately with the
 *     armed error kind, and removes the arm (one-shot). Wins the race by
 *     construction — no polling required.
 *
 * `kind` — `'timeout'` produces `SyncTimeoutError`, `'predisconnect'`
 * produces `PreSyncDisconnectError`. Both map 1:1 to the error classes the
 * real listener paths throw, so `DocumentErrorBoundary`'s copy taxonomy sees
 * the same shape it would see in production.
 *
 * Safe in production for the same reason `__rejectSyncPromise` is — no
 * security boundary crossed. Exposed only under `import.meta.env.DEV` via
 * the window global wiring in `DocumentContext.tsx`.
 *
 * Returns void (arming is a pure write; there's no pre-existing state to
 * report back). Calling twice for the same docName before creation overwrites
 * the armed kind — tests that want both should arm and consume sequentially.
 */
export function __test_armPendingRejection(
  docName: string,
  kind: 'timeout' | 'predisconnect' = 'timeout',
): void {
  armedRejections.set(docName, kind);
  console.warn(`[syncPromise] ${docName} armed for rejection on next creation (kind=${kind})`);
}

/**
 * Test-only helper: clear any pending armed rejection for `docName`. Useful
 * for test teardown when a previous test armed but never consumed. Returns
 * true if an arm was removed.
 */
export function __test_clearArmedRejection(docName: string): boolean {
  return armedRejections.delete(docName);
}
