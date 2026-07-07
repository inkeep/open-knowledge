/**
 * mountTiptapEditorPromise — Suspense + `use(promise)` primitive that splits
 * TipTap's monolithic `new Editor({ element })` cold-mount task into
 * [yield → construct → yield → mount] so the longest synchronous task drops
 * below the perception band on PROJECT-class docs. The pre-construct yield
 * is load-bearing for sibling-subtree paint (sidebar, top bar) — without it,
 * construct()'s synchronous initProseMirrorDoc walk shares a task with the
 * entry-setup microtask and blocks paint for the whole window.
 *
 * Mirrors precedent #18(d) (`sync-promise.ts`) shape — one Suspense-async
 * substrate for "wait for one-shot lifecycle event" across the codebase, not
 * two. Module-level `Map<docName, Entry>` cache; promise identity stable
 * across renders (React Compiler-safe — module state is out of compiler
 * scope, and `use(promise)` requires the same reference across remounts /
 * StrictMode double-invoke to avoid infinite suspension).
 *
 * Differs from `sync-promise.ts` by intentional omission: no
 * `rejectMountPromise` external-injection helper. All mount-promise failures
 * originate inside its own body (construct / yield / mount / register), so
 * the test surface that sync-promise needs for ProviderPool's
 * `BridgeSetupError` injection has no equivalent here.
 *
 * Lifecycle:
 *   - `mountTiptapEditorPromise({ docName, mountId, construct, sizeStats })`
 *     - V2 cache HIT (entry already cached): returns Promise.resolve(entry)
 *       after delegating to `mountTiptapEditor` for the reparent path. No
 *       construction, no yield, no mount() call.
 *     - V2 cache MISS: runs `await scheduler.yield()` → `construct()` →
 *       `await scheduler.yield()` (native on Chromium/Electron, polyfilled
 *       via MessageChannel → requestIdleCallback → setTimeout on
 *       Safari/Firefox) → `editor.mount(transientDiv)` → registers with V2
 *       cache via `mountTiptapEditor` with a no-op factory → resolves with
 *       entry.
 *   - `invalidateMountPromise(docName)` silently tears down the entry: aborts
 *     in-flight construction so the body destroys the pre-mount editor; the
 *     promise is left orphaned (NOT settled) so React's `use()` consumers
 *     that have already unmounted (the typical cancellation path) never see
 *     a rejection. Cache-driven invalidation must be invisible — surfacing
 *     a `MountAbortError` for an LRU eviction the user never requested is
 *     wrong UX. UI-explicit cancellation routes through
 *     `getMountAbortController(docName)?.abort()` which DOES reject.
 *
 * Stalled-but-pending observability (precedent 41):
 *   - At `MOUNT_STALLED_THRESHOLD_MS` (10s default), the substrate emits
 *     `ok/mount/stalled` ONCE per entry and the promise STAYS pending.
 *     Slow IDB hydrate, network partition, hung WebSocket — none are an
 *     auto-failure signal. The substrate emits the observability mark and
 *     waits; the user (via the cancel affordance, which subscribes to
 *     the stalled mark) decides whether to abort.
 *   - `__reapStalledOnVisible(now)` re-checks every pending entry on
 *     `document.visibilitychange → 'visible'` so a tab that backgrounded
 *     past the threshold while `setTimeout` was throttled still emits the
 *     stalled mark on tab restore. Idempotent install/uninstall — the
 *     handler registers once when the cache becomes non-empty and
 *     uninstalls when the cache empties (so test-harness leak checks pass).
 *
 * Cache-entry persistence — load-bearing for two correctness properties
 * (mirrors `syncPromise` lifecycle docstring rationale):
 *   1. Rejection (from explicit `controller.abort()`) survives React
 *      re-render so use() re-throws synchronously to DocumentErrorBoundary
 *      instead of fresh warm-path-resolving on a next render.
 *   2. Resolved entry stays in cache so repeat calls return the same
 *      reference — once React has marked it `.status='fulfilled'`,
 *      subsequent use() calls short-circuit without a Suspense cycle.
 *
 * Pre-mount editors count toward `ACTIVITY_MOUNT_LIMIT` from the moment
 * `mountTiptapEditorPromise` returns the promise — the V2 cache treats the
 * factory-return point as the activity boundary, not mount-completion. This
 * keeps the concurrent-active-editor budget bounded across the construction-
 * to-mount window.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { emitColdMountChild, finalizeColdMountSpan } from '@/lib/perf/otel-spans';
// Side-effect import: ensure `scheduler.yield()` is callable below regardless
// of whether the host-runtime entry point (main.tsx) imported the shim. The
// polyfill IIFE is idempotent — installing twice is a no-op. Production paths
// have main.tsx import this eagerly; tests that import mount-promise directly
// (without going through main.tsx) get the polyfill via this declaration.
import '@/lib/perf/scheduler-polyfill-shim';
import {
  mountTiptapEditor,
  peekTiptap,
  readEditorUndoManager,
  type TiptapCacheEntry,
} from './editor-cache';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bundle returned by the consumer's `construct()` — the four refs the V2
 * cache stores per entry. Mirrors `mountTiptapEditor`'s factory return shape
 * so the V2 cache integration is a no-op pass-through.
 */
interface ConstructedTiptapBundle {
  /**
   * The TipTap editor instance. MUST be constructed with `element: null`
   * (passed explicitly, NOT omitted) so TipTap skips its auto-mount path.
   *
   * The auto-mount gate at `tiptap/packages/core/src/Editor.ts`
   * fires on truthy `options.element`, AND the default for `options.element`
   * is a fresh `document.createElement('div')`. Omitting the field
   * therefore falls through to that default — TipTap auto-mounts onto a
   * throwaway div and the explicit `editor.mount(transient)` call below
   * becomes a *second* mount, doubling the EditorView construction cost.
   * Passing `null` explicitly is the only shape that bypasses auto-mount.
   *
   * mount-promise.ts will call `editor.mount(transientDiv)` after the
   * yield-point so ProseMirror EditorView construction lands on a
   * separate task than the constructor.
   */
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
}

interface MountTiptapEditorPromiseParams {
  docName: string;
  /**
   * Cross-namespace correlation seed. REQUIRED.
   * Threaded into every `ok/mount/*` mark so spans across cache, mount,
   * sync, cold, and typing namespaces join deterministically by mountId
   * equality (no timestamp-window joins).
   *
   * Caller derives via `getMountId(docName) ?? crypto.randomUUID()` —
   * adopting an existing pool-derived id when present so prewarm-then-click
   * flows correlate across the pool→mount boundary. See mount-id-registry.ts
   * for the adoption invariant.
   */
  mountId: string;
  /**
   * Construct the editor + bundle synchronously WITHOUT mounting. The
   * editor MUST be created with `element: null` (passed explicitly) so
   * its auto-mount is skipped — mount-promise.ts owns the deferred
   * `editor.mount(transient)` call after the yield-point. Omitting the
   * field falls back to TipTap's default (a fresh div), which auto-mounts
   * and produces a double-mount regression. See ConstructedTiptapBundle.editor
   * docstring for full source rationale.
   */
  construct: () => ConstructedTiptapBundle;
  /**
   * Optional size stats for V2 cache admission. Forwarded to
   * `mountTiptapEditor` on the cache-MISS registration step so the
   * existing bytes/view-count gates still apply.
   */
  sizeStats?: { viewCount: number; bytes: number };
}

/**
 * Thrown when a mount is cancelled via explicit `controller.abort()`
 * (the cancel-affordance contract). Distinguishable from natural
 * mount failures so error-boundary copy can branch — explicit cancel is
 * a user action, not a "broken editor" surface.
 *
 * NOT thrown by `invalidateMountPromise` (which is silent — see its
 * docstring). The only path that fires this is `getMountAbortController(
 * docName)?.abort()`, the UI-explicit cancellation surface.
 */
export class MountAbortError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Mount aborted for "${docName}"`);
    this.name = 'MountAbortError';
    this.docName = docName;
  }
}

/**
 * Threshold after which a still-pending mount emits `ok/mount/stalled`
 * ONCE for observability. The promise STAYS pending.
 *
 * Rationale (precedent 41): a slow IDB hydrate, slow network, or hung
 * WebSocket is NOT an auto-failure signal. Auto-rejecting after a timer
 * fires would create false-negative cancellations — the user's doc is
 * loading correctly but slowly, and a UI error surface tells them
 * the doc is broken. Cooperative cancellation (the user clicks the FW13
 * cancel affordance, which calls `controller.abort()`) is the only
 * settle-on-stall path.
 *
 * Default 10s; overridable via `__okPerfOverrides.MOUNT_STALLED_THRESHOLD_MS`.
 */
function getStalledThresholdMs(): number {
  return readNumericOverride('MOUNT_STALLED_THRESHOLD_MS', 10_000);
}

// ---------------------------------------------------------------------------
// Module-level cache (mirrors sync-promise CacheEntry shape)
// ---------------------------------------------------------------------------

interface MountPromiseEntry {
  promise: Promise<TiptapCacheEntry>;
  /**
   * Reject the consumer promise. Stored on the entry so explicit
   * `controller.abort()` (the cancel-affordance path) can settle the
   * promise decisively without racing the body's own settle paths.
   */
  rejectFn: (error: Error) => void;
  /**
   * AbortController exposed via `getMountAbortController`. Body checks
   * `controller.signal.aborted` after the yield-point and bails before
   * calling `editor.mount(transient)` so an explicit abort tears down
   * cleanly. The signal also fires an `abort` listener that drives the
   * MountAbortError reject path (so abort during the V2-HIT short-circuit
   * or before the body's first microtask still settles the promise).
   */
  controller: AbortController;
  /** Correlation seed threaded into every mark payload. */
  mountId: string;
  createdAt: number;
  /** True once the promise has resolved or rejected. */
  settled: boolean;
  /**
   * True only on resolve paths (V2 HIT short-circuit + MISS register-success).
   * Distinguishes "the consumer's `use()` will short-circuit synchronously"
   * (resolved=true) from "the consumer's `use()` will throw to error
   * boundary" (settled=true && resolved=false). Read by the public
   * `mountPromiseHasResolved` helper so the EditorArea deferred-value
   * skeleton overlay can skip the warm-reopen flash.
   */
  resolved: boolean;
  /**
   * Pre-mount editor reference. Set after `construct()` succeeds; cleared
   * before successful V2 register (entry is owned by V2 cache from that
   * point). Read by the `.catch` backstop so an escaped throw between
   * construct and successful register (e.g., `await scheduler.yield()`
   * rejection) cleans up the editor + UndoManager-restore closure (~30 MB
   * leak per editor-cache.ts:65-85) instead of just settling the promise.
   */
  preMountEditor: Editor | null;
  /**
   * Stalled-emission timer. Fires once at `MOUNT_STALLED_THRESHOLD_MS` and
   * emits `ok/mount/stalled`. Cleared on every settle path so a late
   * settle doesn't double-emit.
   */
  stalledHandle: ReturnType<typeof setTimeout> | null;
  /**
   * Idempotent flag. Once `ok/mount/stalled` has fired for this entry —
   * either via the timer or via the visibility-restore reaper — set to
   * true so subsequent reaper passes skip re-emission. The promise stays
   * pending; this gates only the mark.
   */
  stalledMarkEmitted: boolean;
}

/** Clear the stalled timer if still armed. Idempotent. */
function clearStalledTimer(entry: MountPromiseEntry): void {
  if (entry.stalledHandle !== null) {
    clearTimeout(entry.stalledHandle);
    entry.stalledHandle = null;
  }
}

/**
 * Emit `ok/mount/stalled` once per entry. Idempotent across the timer and
 * visibility-reaper paths so a tab-restore reaper after a fired-but-not-
 * yet-cleared timer never double-emits.
 */
function emitStalledOnce(entry: MountPromiseEntry, docName: string, now: number): void {
  if (entry.stalledMarkEmitted) return;
  entry.stalledMarkEmitted = true;
  const elapsed = now - entry.createdAt;
  mark('ok/mount/stalled', {
    docName,
    mountId: entry.mountId,
    elapsedMs: elapsed,
  });
}

const cache = new Map<string, MountPromiseEntry>();

// ---------------------------------------------------------------------------
// Stalled subscriber registry (consumed by FW13 affordance)
// ---------------------------------------------------------------------------

type StalledSubscriber = (docName: string, mountId: string) => void;
const stalledSubscribers = new Set<StalledSubscriber>();

/**
 * Subscribe to `ok/mount/stalled` events. The callback fires for every
 * stalled emission going forward, AND immediately for every entry already
 * in the cache that has stalled-but-not-resolved (so a late-mounted
 * subscriber doesn't miss an existing stall — the canonical race for the
 * cancel affordance during rapid-nav).
 *
 * Returns an unsubscribe function. Idempotent — calling unsubscribe twice
 * is a no-op.
 */
export function subscribeMountStalled(callback: StalledSubscriber): () => void {
  stalledSubscribers.add(callback);
  // Replay existing stalled-but-pending entries so a subscriber that mounts
  // after the stall has already fired still sees it.
  for (const [docName, entry] of cache) {
    if (entry.stalledMarkEmitted && !entry.settled) {
      try {
        callback(docName, entry.mountId);
      } catch {
        // Subscriber threw — swallow so one bad subscriber doesn't break
        // others. The mark itself is still in the trace.
      }
    }
  }
  return () => {
    stalledSubscribers.delete(callback);
  };
}

function fanOutStalled(docName: string, entry: MountPromiseEntry): void {
  for (const sub of stalledSubscribers) {
    try {
      sub(docName, entry.mountId);
    } catch {
      // Subscriber threw — swallow per subscribeMountStalled contract.
    }
  }
}

// ---------------------------------------------------------------------------
// Visibility-restore reaper (idempotent install / uninstall)
// ---------------------------------------------------------------------------

let visibilityHandlerInstalled = false;

function visibilityHandler(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  __reapStalledOnVisible(Date.now());
}

function installVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  // Test envs (Bun's no-DOM stub) supply only `createElement`. Skip the
  // listener install when the stub doesn't expose addEventListener — the
  // browser path is the only one that needs the reaper, and the
  // `__reapStalledOnVisible` test export still lets unit tests drive the
  // reap directly.
  if (typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', visibilityHandler);
  visibilityHandlerInstalled = true;
}

function uninstallVisibilityHandler(): void {
  if (!visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  if (typeof document.removeEventListener !== 'function') return;
  document.removeEventListener('visibilitychange', visibilityHandler);
  visibilityHandlerInstalled = false;
}

/**
 * Re-check every pending entry's stalled threshold. Called by
 * `visibilitychange → 'visible'` so a tab that backgrounded past the
 * threshold while `setTimeout` was throttled still emits the mark.
 *
 * Exported for direct test invocation — Playwright/jsdom don't always
 * fire visibilitychange reliably under fake timers, so the reaper is
 * driven directly in unit tests.
 */
export function __reapStalledOnVisible(now: number): void {
  const threshold = getStalledThresholdMs();
  for (const [docName, entry] of cache) {
    if (entry.settled) continue;
    if (entry.stalledMarkEmitted) continue;
    if (now - entry.createdAt < threshold) continue;
    emitStalledOnce(entry, docName, now);
    fanOutStalled(docName, entry);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the cached promise for `docName`, creating one if absent.
 *
 * On V2 cache HIT (entry already present in `editor-cache.ts`'s tiptapCache),
 * the underlying `mountTiptapEditor` call short-circuits to the reparent path
 * and the returned promise resolves immediately with the existing entry —
 * NO construction, no yield, no mount() invocation.
 *
 * On V2 cache MISS:
 *   1. `await scheduler.yield()` so the heavy `construct()` walk lands on
 *      its own task — sibling subtrees (sidebar, top bar) can paint during
 *      the entry-setup → construct gap. construct() includes a synchronous
 *      `initProseMirrorDoc` walk of the Y.XmlFragment (~300-1000ms on
 *      PROJECT-class docs) that would otherwise block paint window-wide.
 *   2. Abort check — if `controller.abort()` fired during the pre-construct
 *      yield, short-circuit before construct (no editor to destroy).
 *   3. `construct()` builds the editor (with `element: null`).
 *   4. `await scheduler.yield()` returns control to the browser scheduler
 *      so the subsequent `editor.mount(transientDiv)` call lands on a fresh
 *      task. Native on Chromium / Electron; polyfilled on Safari / Firefox
 *      via MessageChannel → requestIdleCallback → setTimeout.
 *   5. Abort check — if `controller.abort()` fired during the yield (via
 *      explicit FW13 cancel), destroy the pre-mount editor + reject with
 *      `MountAbortError`.
 *   6. `editor.mount(transientDiv)` — runs ProseMirror EditorView
 *      construction on a fresh task.
 *   7. Register with V2 cache via `mountTiptapEditor` (no-op factory just
 *      returns the pre-built bundle so V2 cache's LRU + telemetry still fires).
 *   8. Resolve with the V2 cache entry.
 *
 * Mount failure (step 6 throws) destroys the pre-mount editor and rejects
 * with the original error — DocumentErrorBoundary catches via the consumer's
 * `use()` call. The cache entry stays settled-rejected so re-renders see the
 * same rejected thenable instead of fresh warm-path resolving.
 */
export function mountTiptapEditorPromise(
  params: MountTiptapEditorPromiseParams,
): Promise<TiptapCacheEntry> {
  const { docName, mountId, construct, sizeStats } = params;

  const existing = cache.get(docName);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const createdAt = Date.now();
  let resolveFn: (entry: TiptapCacheEntry) => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const promise = new Promise<TiptapCacheEntry>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const entry: MountPromiseEntry = {
    promise,
    rejectFn,
    controller,
    mountId,
    createdAt,
    settled: false,
    resolved: false,
    preMountEditor: null,
    stalledHandle: null,
    stalledMarkEmitted: false,
  };

  // Stalled timer: emit observability mark at threshold; promise STAYS
  // pending. Re-read threshold each time so test overrides applied AFTER
  // a previous call still take effect on the next call.
  entry.stalledHandle = setTimeout(() => {
    if (entry.settled) return;
    emitStalledOnce(entry, docName, Date.now());
    fanOutStalled(docName, entry);
  }, getStalledThresholdMs());

  // Explicit-abort path (cancel affordance, NOT cache-driven invalidate).
  // The body has two abort checks (pre-construct and post-construct) covering
  // the construct→yield→mount window; this listener covers the V2-HIT
  // short-circuit and the pre-construct gap so abort() fired before the
  // body's first microtask still settles the promise decisively. Idempotent
  // on already-settled entries.
  controller.signal.addEventListener('abort', () => {
    if (entry.settled) return;
    entry.settled = true;
    clearStalledTimer(entry);
    if (entry.preMountEditor) {
      destroyPreMountEditor(docName, entry.preMountEditor, 'aborted');
      entry.preMountEditor = null;
    }
    cache.delete(docName);
    if (cache.size === 0) uninstallVisibilityHandler();
    mark('ok/mount/reject', { docName, mountId: entry.mountId, reason: 'aborted' });
    rejectFn(new MountAbortError(docName));
    // Close the cold-mount root span symmetrically with the resolve path —
    // otherwise a sibling emit (pool.open, sync-promise) that lazily created
    // the root leaks the Map entry + un-ended Span. Idempotent + safe.
    finalizeColdMountSpan(entry.mountId);
  });

  // Cache first, then start the body — concurrent callers during the body's
  // microtask hop must see the same in-flight entry and return the same
  // promise reference.
  cache.set(docName, entry);
  installVisibilityHandler();
  mark('ok/mount/create', { docName, mountId: entry.mountId });

  // IIFE body. We don't await this at the top level — the returned `promise`
  // settles independently when the body calls resolveFn/rejectFn.
  //
  // Backstop: any throw inside runMountBody outside its own try/catch sites
  // (e.g., the V2 cache HIT reparent path, the `await scheduler.yield()`
  // call) would otherwise leave the outer promise pending forever, infinite-
  // suspending React's `use(promise)`. The `.catch` here ensures both that
  // rejectFn fires AND that the post-construct editor (if any) is destroyed
  // with full UndoManager-restore cleanup. The `entry.settled` guard skips
  // re-rejecting when an explicit abort has already settled the promise via
  // its own rejectFn path — but emits an `ok/mount/post-settle-throw` mark so
  // the dropped `err` is still observable in traces. The editor cleanup
  // runs unconditionally because `preMountEditor` is set/cleared by the
  // body and is a precise signal of "an editor was constructed but not yet
  // handed to V2."
  runMountBody({
    docName,
    construct,
    sizeStats,
    entry,
    resolveFn,
    rejectFn,
  }).catch((err) => {
    if (entry.preMountEditor) {
      destroyPreMountEditor(docName, entry.preMountEditor, 'backstop');
      entry.preMountEditor = null;
    }
    if (entry.settled) {
      // Post-settle escape: the consumer promise already received a rejection
      // (typically MountAbortError from a prior controller.abort() call), so
      // re-rejecting would be a no-op. But the body's actual `err` would
      // otherwise vanish — no telemetry, no console signal. Emit a mark so a
      // TipTap regression that starts throwing on reparent (or any other
      // post-settle escape) is observable in traces. Pre-mount editor cleanup
      // already ran above.
      mark('ok/mount/post-settle-throw', {
        docName,
        mountId: entry.mountId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'unhandled-body-throw',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
  });

  return promise;
}

/**
 * Returns true when the cached promise for `docName` has resolved
 * successfully — i.e., the consumer's `use(promise)` will short-circuit
 * synchronously without a Suspense fallback.
 *
 * Distinct from `__mountPromiseSettled` (test-only): "settled" includes
 * rejected entries that will throw to the error boundary AND
 * stalled-but-pending entries (which return false here — same as actively
 * constructing — so the warm-reopen overlay stays correct under stall).
 * This helper only returns true when the entry's outcome is success.
 *
 * Used by `EditorArea.tsx` to gate the deferred-value skeleton overlay:
 * when both this AND `syncPromiseHasResolved` are true for the new
 * `activeDocName`, the deferred commit is guaranteed to land in 1 frame
 * (no Suspense) and painting a skeleton during the urgent-paint→deferred-
 * commit gap creates a perceptible "cold load" flash on a genuinely warm
 * reopen. False on absent / pending / stalled / rejected — overlay must
 * paint to either cover a slow mount or signal an upcoming error-boundary
 * throw.
 */
export function mountPromiseHasResolved(docName: string): boolean {
  return cache.get(docName)?.resolved === true;
}

/**
 * Returns the AbortController for `docName`'s in-flight mount, or null if
 * no entry exists. Calling `.abort()` on the returned controller rejects
 * the promise with `MountAbortError` and routes through DocumentError
 * Boundary's MountAbortError errorCopy.
 *
 * The ONLY UI-explicit cancellation surface — the cancel affordance
 * (`MountStalledAffordance.tsx`) calls this to cancel a stalled mount.
 * Cache-driven invalidation MUST go through `invalidateMountPromise`
 * (silent path), not this — system-driven cleanup never produces user-
 * visible error UI.
 */
export function getMountAbortController(docName: string): AbortController | null {
  return cache.get(docName)?.controller ?? null;
}

/**
 * Silently tear down the cached entry for `docName`.
 *
 * Called by `parkTiptapEditor` / `evictTiptapEditor` so a rapid-nav-away
 * from a doc whose mount is mid-yield-window cancels cleanly: the body's
 * post-yield abort check fires, destroys the pre-mount editor, and the
 * body's natural cancellation path cleans up. The promise is left
 * orphaned (NOT rejected) — pending consumers holding the old promise
 * via `use()` should have unmounted (Suspense fallback) by the time
 * invalidation runs, and a cache-driven invalidate surfacing
 * MountAbortError to DocumentErrorBoundary for an LRU eviction the user
 * never requested is wrong UX.
 *
 * Does NOT emit any `ok/mount/*` mark: cache-driven invalidate is a
 * silent system action, not an observable mount-lifecycle event.
 *
 * Distinct from `controller.abort()` (the explicit-cancel path via
 * `getMountAbortController`): explicit abort DOES reject with
 * MountAbortError. Routing them through different APIs keeps the
 * "is this an error" decision at the call site, not buried in a flag.
 *
 * Safe no-op when no entry exists.
 */
export function invalidateMountPromise(docName: string): void {
  const entry = cache.get(docName);
  if (!entry) return;
  // Mark settled BEFORE removing from cache so the abort-listener short-
  // circuits if `controller.abort()` fires concurrently (e.g., under React
  // StrictMode double-invoke or a rapid-nav race). The listener's
  // `if (entry.settled) return;` guard handles the rest.
  entry.settled = true;
  clearStalledTimer(entry);
  if (entry.preMountEditor) {
    destroyPreMountEditor(docName, entry.preMountEditor, 'aborted');
    entry.preMountEditor = null;
  }
  cache.delete(docName);
  if (cache.size === 0) uninstallVisibilityHandler();
  mark('ok/mount/invalidate', { docName, mountId: entry.mountId });
  // Symmetric cold-mount span finalization. The abort-listener short-
  // circuits on settled=true (set above) so its finalizeColdMountSpan call
  // never reaches. If a sibling surface (ProviderPool.open, sync-promise)
  // emitted a child during the pre-construct or post-construct yield window
  // before invalidate fired, its lazy-created root span would stay un-ended
  // and the Map entry would persist until COLD_MOUNT_MAP_CAP eviction.
  // Finalize here so invalidate's teardown is observationally symmetric with
  // the explicit-abort path. Idempotent + safe when no entry exists.
  finalizeColdMountSpan(entry.mountId);
  // Trigger the controller for the body's post-yield abort check, but
  // suppress the listener's reject path via the settled guard above.
  entry.controller.abort();
}

// ---------------------------------------------------------------------------
// Internal body
// ---------------------------------------------------------------------------

interface MountBodyParams {
  docName: string;
  construct: () => ConstructedTiptapBundle;
  sizeStats?: { viewCount: number; bytes: number };
  entry: MountPromiseEntry;
  resolveFn: (entry: TiptapCacheEntry) => void;
  rejectFn: (error: Error) => void;
}

/**
 * Destroy a pre-mount editor with the same UndoManager-restore cleanup that
 * `editor-cache.ts` applies at park / evict (precedent #18(c) leak-cleanup).
 * Capturing the UndoManager BEFORE `editor.destroy()` is required because
 * `editor.state` is only safely readable while the editor is alive; clearing
 * `restore` AFTER destroy breaks the @tiptap/extension-collaboration closure
 * that retains the full editor graph (~30 MB per cycle on multi-MB docs).
 *
 * Idempotent on pre-mount editors per TipTap source verification. Emits a
 * telemetry mark on destroy() failure so a regression in TipTap's pre-mount-
 * destroy idempotency surfaces in traces rather than vanishing — mirrors
 * `editor-cache.ts`'s `ok/cache/evict-failed` discipline.
 */
function destroyPreMountEditor(
  docName: string,
  editor: Editor,
  stage: 'aborted' | 'mount-failed' | 'v2-register-failed' | 'backstop',
): void {
  const undoManager = readEditorUndoManager(editor);
  try {
    editor.destroy();
  } catch (err) {
    mark('ok/mount/destroy-failed', {
      docName,
      stage,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (undoManager) {
    undoManager.restore = undefined;
  }
}

async function runMountBody(params: MountBodyParams): Promise<void> {
  const { docName, construct, sizeStats, entry, resolveFn, rejectFn } = params;

  // Always create a fresh transient div for the V2 container — even on HIT,
  // V2's reparent moves view.dom from its current parent (the parking node,
  // post-park) into this transient. The consumer's `<EditorContent>` will
  // then move view.dom from the transient into its React-managed ref on
  // first render.
  const transient = document.createElement('div');

  // V2 cache HIT short-circuit via a non-throwing peek. peekTiptap is a pure
  // Map.get (no LRU touch, no reparent) so callers can branch HIT vs MISS
  // without abusing factory-exception flow. The follow-up mountTiptapEditor
  // call below performs the full HIT-path side effects (LRU touch, reparent,
  // scrollTop / focus restore) when an entry exists.
  //
  // sizeStats is intentionally OMITTED here. mountTiptapEditor evaluates the
  // size gate BEFORE consulting the cache (`editor-cache.ts:353`), so passing
  // sizeStats on a confirmed-HIT call would reroute through the gate-refuse
  // branch when the doc has grown past `BYTES_CACHE_THRESHOLD` since
  // admission — invoking the throw-factory below and surfacing as a
  // "Couldn't open document" error on a doc the user opened moments ago.
  // peekTiptap has already proven cache presence; the only legitimate reason
  // to call mountTiptapEditor here is the side effects, not the admission
  // decision. Omitting sizeStats forces gateRefuses=false → cache.get →
  // existing → reparent path.
  if (peekTiptap(docName) !== undefined) {
    const v2HitEntry = mountTiptapEditor({
      docName,
      container: transient as unknown as HTMLElement,
      factory: () => {
        // Unreachable: peekTiptap confirmed an entry exists, sizeStats is
        // omitted so gateRefuses is false, and mountTiptapEditor's HIT
        // branch never invokes factory. If V2 cache semantics ever change
        // such that HIT invokes factory, surfacing this as a thrown error
        // makes the violation loud.
        throw new Error(
          `mount-promise: V2 cache contract violation — factory invoked on HIT for "${docName}"`,
        );
      },
    });
    entry.settled = true;
    entry.resolved = true;
    clearStalledTimer(entry);
    // V2-HIT short-circuit: the cache-layer `ok/cache/hit` mark already fired
    // from `editor-cache.ts` via the `mountTiptapEditor` call above. No
    // second cache-hit emission here — that would be observer-namespacing
    // redundancy of the same logical event. Observers needing mount-substrate
    // -vs-cache-layer divergence detection correlate by `mountId` across
    // substrate namespaces: `ok/mount/create` marks creation, `ok/cache/hit`
    // marks the cache-layer event, and `ok/mount/resolve` / `ok/mount/reject`
    // mark settle on the MISS path.
    resolveFn(v2HitEntry);
    return;
  }

  // -------------------------------------------------------------------------
  // V2 cache MISS — yield → check abort → construct → yield → check abort
  //   → mount → register
  // -------------------------------------------------------------------------

  // Pre-construct yield. construct() includes a synchronous initProseMirrorDoc
  // walk of the Y.XmlFragment (~300-1000ms on PROJECT-class docs); without
  // this yield, that walk shares a task with the entry-setup microtask and
  // blocks paint of sibling subtrees (sidebar, top bar) for the duration of
  // the walk. Yielding here lets the Suspense fallback + non-editor subtrees
  // paint before the editor build begins.
  await scheduler.yield();

  // Pre-construct abort check — if abort fired during the pre-construct
  // yield window (via explicit `controller.abort()` or `invalidateMount
  // Promise`'s silent teardown), short-circuit before paying the construct()
  // cost. No editor exists yet, so nothing to destroy; the abort-listener
  // path (or invalidate path) has already cleaned up cache state and (for
  // explicit abort) rejected the promise. The body's job here is to exit
  // cleanly without firing additional marks.
  if (entry.controller.signal.aborted) {
    return;
  }

  let constructed: ConstructedTiptapBundle | null = null;
  try {
    constructed = construct();
  } catch (err) {
    // construct() failed. No editor exists to destroy.
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'construct-failed',
      // Carry the failure message like the post-settle-throw backstop does —
      // without it a construct-time crash (e.g. the pre-warm fragment walk
      // throwing on a corrupt remote-authored doc) is an anonymous
      // 'construct-failed' in traces.
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }
  // Hand the constructed editor to the entry so the `.catch` backstop can
  // destroy it if a throw escapes the inner try/catch sites below (the
  // `await scheduler.yield()` rejection being the canonical case). Cleared
  // before successful V2 register — V2 owns the editor lifetime from there.
  entry.preMountEditor = constructed.editor;

  // Yield to the browser scheduler so the post-yield mount() runs on a
  // separate task than the construct() above. On Chromium / Electron this
  // uses the native `scheduler.yield()`; on Safari / Firefox the
  // GoogleChromeLabs `scheduler-polyfill` provides equivalent semantics via
  // MessageChannel → requestIdleCallback → setTimeout. The polyfill is
  // installed via the side-effect import at the top of this module — and
  // again from main.tsx — so this call is safe on every supported runtime.
  await scheduler.yield();

  // Abort check — if abort fired during the yield-window (via explicit
  // controller.abort() or via invalidateMountPromise's silent teardown),
  // the abort-listener has already settled the promise + cleaned up. The
  // body's job here is to short-circuit before the expensive mount() call.
  // destroyPreMountEditor on the pre-mount editor is also safe to skip:
  // either the abort listener already destroyed it (explicit abort) or
  // invalidateMountPromise destroyed it (silent path).
  if (entry.controller.signal.aborted) {
    entry.preMountEditor = null;
    return;
  }

  // Mount-failure recovery: if editor.mount() throws (e.g., DOM ref
  // unmounted, createView fails), destroy the pre-mount editor and propagate
  // the original error. The promise stays settled-rejected in mount-promise
  // cache so React's use() re-throws synchronously across re-renders to
  // DocumentErrorBoundary. destroyPreMountEditor handles the UndoManager
  // restore-closure cleanup so a partial-mount failure doesn't leak the
  // EditorView + ProsemirrorBinding + Editor + PM document tree.
  try {
    constructed.editor.mount(transient);
  } catch (err) {
    destroyPreMountEditor(docName, constructed.editor, 'mount-failed');
    entry.preMountEditor = null;
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'mount-failed',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }

  // The factory ignores `container` because the editor is ALREADY mounted
  // into the transient above by `editor.mount(transient)`. mountTiptapEditor's
  // MISS path calls factory(container) — passing the pre-built bundle here
  // makes V2 store our entry without re-mounting.
  let v2MissEntry: TiptapCacheEntry;
  try {
    v2MissEntry = mountTiptapEditor({
      docName,
      container: transient as unknown as HTMLElement,
      sizeStats,
      factory: () => constructed,
    });
  } catch (err) {
    // V2 cache registration failed — destroy the constructed (now-mounted)
    // editor with full UndoManager cleanup and reject.
    destroyPreMountEditor(docName, constructed.editor, 'v2-register-failed');
    entry.preMountEditor = null;
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'v2-register-failed',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }

  // V2 owns the editor lifetime from this point — clear the backstop
  // reference so a late escape (e.g. resolveFn observer throwing in
  // hostile test envs) doesn't double-destroy a now-cached editor.
  entry.preMountEditor = null;
  entry.settled = true;
  entry.resolved = true;
  clearStalledTimer(entry);
  const elapsed = Date.now() - entry.createdAt;
  mark('ok/mount/resolve', {
    docName,
    mountId: entry.mountId,
    elapsedMs: elapsed,
  });
  // Feed the mount-resolve distribution the convention-cap-graduation sweep
  // drains via getHistogramSnapshot. Bucket name mirrors the sync namespace
  // (kebab-case third segment — the mark-name regex rejects dots).
  mark.histogram('ok/mount/resolve-elapsed-ms', { docName, mountId: entry.mountId }, elapsed);
  // Settle the promise BEFORE OTel emission so a misbehaving SDK cannot
  // strand React's `use(promise)` in an infinite suspend. The OTel API
  // contract says startSpan/end must not throw, but an opt-in SDK fault
  // would otherwise block the user path.
  resolveFn(v2MissEntry);
  // Emit ok.mount-promise as a descendant of the ok.cold-mount root for
  // this cycle. Cold-mount root is lazily created if absent — typical on
  // a fresh cold mount when sync-resolve has not yet finalized it. No-op
  // when OTel is disabled. Only fires on the MISS register-success path:
  // the V2 HIT short-circuit at the top of runMountBody never reaches
  // here, so a warm cache reparent does not pollute the cold-mount
  // distribution.
  const nowMs = Date.now();
  emitColdMountChild(
    entry.mountId,
    'ok.mount-promise',
    { 'doc.name': docName, elapsed_ms: elapsed },
    entry.createdAt,
    nowMs,
  );
  // Finalize the cold-mount root. Idempotent with sync-promise's finalize
  // call — whichever resolves last actually closes the root; the other
  // becomes a no-op. Either path can complete first depending on the
  // network profile, so both call finalize for symmetry.
  finalizeColdMountSpan(entry.mountId, nowMs);
}

// ---------------------------------------------------------------------------
// Test helpers (mirror sync-promise.ts exports)
// ---------------------------------------------------------------------------

/**
 * Test-only: clear all cached entries. Aborts any in-flight body so the
 * promise settles into oblivion (no orphaned promise can resolve into a
 * fresh test case). Also clears any subscribers and uninstalls the
 * visibility handler.
 */
export function __resetMountPromiseCache(): void {
  for (const entry of cache.values()) {
    entry.settled = true;
    clearStalledTimer(entry);
    entry.controller.abort();
  }
  cache.clear();
  stalledSubscribers.clear();
  uninstallVisibilityHandler();
}

/**
 * Test-only: report whether the cache entry for `docName` has settled.
 * Exposed so tests can assert "cache stable but settled" semantics without
 * relying on cache size, which persists settled entries by design.
 */
export function __mountPromiseSettled(docName: string): boolean {
  return cache.get(docName)?.settled ?? false;
}

/** Test-only: report cache size. */
export function __mountPromiseCacheSize(): number {
  return cache.size;
}

/** Test-only: report whether an entry has emitted its stalled mark. */
export function __mountPromiseStalledEmitted(docName: string): boolean {
  return cache.get(docName)?.stalledMarkEmitted ?? false;
}

/** Test-only: report whether the visibility handler is currently installed. */
export function __mountPromiseVisibilityHandlerInstalled(): boolean {
  return visibilityHandlerInstalled;
}
