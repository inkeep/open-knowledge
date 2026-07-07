import { HocuspocusProvider } from '@hocuspocus/provider';
import { LINEAGE_EPOCH_KEY, MarkdownManager } from '@inkeep/open-knowledge-core';
import type { HocuspocusAuthRejectionReason } from '@inkeep/open-knowledge-server';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { buildAuthToken } from '../lib/auth-token';
import { readNumericOverride } from '../lib/perf/env-override';
import { mark } from '../lib/perf/mark';
import { emitColdMountChild } from '../lib/perf/otel-spans';
import {
  type ClientPersistenceProvider,
  captureStateVector,
  computeUnsyncedUpdate,
  createClientPersistence,
  mergeStateVectors,
  type PeekStoredLineageEpochArgs,
  peekStoredLineageEpoch,
  UNKNOWN_BRANCH_SENTINEL,
} from './client-persistence';
import { appendTraceContextToCollabUrl } from './collab-otel';
import { sharedExtensions } from './extensions/shared.ts';
import { isSystemDoc } from './is-system-doc';
import { getMountId } from './mount-id-registry';
import { setupObservers } from './observers';
import { BridgeSetupError, invalidateSyncPromise, rejectSyncPromise } from './sync-promise';

/**
 * Opaque Y.Doc transaction origin applied when the pool replays a buffered
 * update onto a freshly-recycled provider. Lets tests and future observers
 * distinguish replay writes from user edits / server sync deliveries.
 */
export const TAB_REPLAY_ORIGIN = Object.freeze({ kind: 'tab-replay' } as const);

export type SyncState = 'connecting' | 'synced' | 'disconnected';
export type ServerRestartRecoveryState =
  | { kind: 'idle' }
  | {
      kind: 'recovering';
      phase: 'clearing-local-cache' | 'reconnecting';
      docNames: readonly string[];
      failedDocNames: readonly string[];
      startedAt: number;
      /** Present when `failedDocNames` is non-empty — survives until active doc syncs. */
      clearFailureReason?: 'clear-data-failed' | 'clear-data-timeout';
    }
  | {
      kind: 'failed';
      reason: 'clear-data-failed' | 'clear-data-timeout';
      docNames: readonly string[];
      failedDocNames: readonly string[];
      startedAt: number;
    };

const IDLE_SERVER_RESTART_RECOVERY: ServerRestartRecoveryState = Object.freeze({ kind: 'idle' });

/**
 * Pool entries follow a two-state lifecycle modeled as a discriminated
 * union: `Active` (the normal case — provider live, persistence attached)
 * and `TearingDown` (transient, inside `destroyEntry` after the kind flip
 * but before the entry is removed from `entries`).
 *
 * The discriminator narrows `persistence`, `observerCleanup`, and
 * `pendingRecycleTimer` to their non-transient shapes when consumers know
 * the entry is Active — replaces the implicit-invariant pattern of
 * `if (entry.tearingDown || entry.persistence === null) continue;`.
 *
 * Note on `bridgeSetupFailed`: kept as a flag on `Active` rather than a
 * third variant. A bridge-failed entry stays pool-resident with
 * persistence still attached and the recycle-on-disconnect path still
 * functional — the only narrowing benefit of a separate variant would be
 * `observerCleanup === null`, which doesn't earn its variant weight.
 *
 * Note on stale-closure checks: variants don't subsume the
 * `this.entries.get(docName) !== entry` guard in event handlers. That
 * check answers "is my closure stale?" — orthogonal to the entry's
 * lifecycle state. Both checks remain.
 */
interface PoolEntryBase {
  provider: HocuspocusProvider;
  docName: string;
  lastAccessedAt: number;
  /**
   * Deterministic correlation seed minted at fresh-construct time.
   * Joins the pool warm-back / open trace to the activity-list mount
   * cycle that adopts it as `mountId`, replacing a timestamp-window
   * join that would otherwise be needed to follow one logical
   * cold-mount cycle across namespaces.
   */
  poolEventId: string;
  syncState: SyncState;
  hasSynced: boolean;
  /**
   * True when `setupObservers` threw during initial sync. The provider
   * stays pool-resident so `EditorArea` keeps rendering the boundary
   * subtree (which shows `DocumentErrorBoundary`'s `BridgeSetupError`
   * UI), but the entry is inert — observers not wired, no further writes
   * will land. The user's "Try again" path calls `pool.recycle(docName)`
   * which destroys + recreates the entry to retry from a clean slate.
   */
  bridgeSetupFailed: boolean;
  /**
   * Server state vector captured after every Y.js `synced` event ("server
   * has accepted your update into its in-memory Y.Doc"). The delta
   * between this and the doc's current state is the unsynced buffer
   * captured before `clearData` on a `server-instance-mismatch` recycle.
   * `handleServerInstanceMismatch` falls back to this when
   * `lastDiskAckedSV` is null (no disk-ack received yet).
   */
  lastServerSyncedSV: Uint8Array | null;
  /**
   * Stricter watermark advanced by the server's CC1 `disk-ack` channel
   * after L1 markdown flush ("server has durably persisted your update
   * to disk"). `handleServerInstanceMismatch` prefers this over
   * `lastServerSyncedSV` when present — disk-ack'd updates will survive
   * the markdown rebuild on a server-restart, so the recycle buffer
   * doesn't need to replay them. Closes the mid-drain duplication
   * bug class.
   */
  lastDiskAckedSV: Uint8Array | null;
  /**
   * The pool's per-doc lineage-epoch record snapshotted at `open()` time,
   * BEFORE this entry's own sync could re-record a fresher value. The
   * deferred-persistence-attach guard compares this against the live
   * doc's epoch once the server instance id becomes known: the IDB rows
   * a late attach would hydrate were written under the lineage recorded
   * at open — comparing against the record map's CURRENT value would see
   * the fresh epoch this entry's `synced` handler just recorded and wave
   * the stale rows through. `null` when no record existed at open — that
   * population is fenced by the stored-state validation spine, which
   * reads the epoch carried in-band by the rows themselves.
   */
  lineageEpochRecordAtOpen: string | null;
}

/**
 * Live pool entry. Most consumers narrow to this kind via
 * `if (entry.kind === 'active') { … }`.
 *
 * `persistence` is `null` only on entries opened before the live
 * server epoch (`cachedServerInstanceId`) was known. The DB-name shape
 * `ok-ydoc:${branch}:${serverInstanceId}:${docName}` carries the
 * server epoch as a structural correctness signal, so the IndexedDB
 * cache cannot be attached until the epoch is known. The
 * `HocuspocusProvider` is constructed eagerly so the WebSocket
 * handshake can begin in parallel, but no persistent IDB ever points
 * at an unknown-epoch DB name.
 */
interface ActivePoolEntry extends PoolEntryBase {
  kind: 'active';
  /**
   * Client-side Yjs persistence attached to this entry's Y.Doc. Hydrates
   * from IndexedDB on cold mount (instant Cmd-R), persists every
   * non-self update back, and is the handle the mismatch recycle flow
   * uses to `clearData()` before destroying the provider. `null` when
   * the live server epoch was not yet known at `open()` time, or while
   * the stored-state validation spine hasn't yet admitted the rows (no
   * lineage record existed at open to claim-fence them).
   */
  persistence: ClientPersistenceProvider | null;
  /** Wired by `setupObservers` after first sync; null until then. */
  observerCleanup: (() => void) | null;
  /**
   * Cleanup for the DEV-only `ok/perf-counters` observer that tracks remote
   * Y.Doc transactions. Null in production (gated by
   * `import.meta.env.PROD === true` — installer returns a no-op).
   */
  observerFireCounterCleanup: (() => void) | null;
  /** Set when a disconnect schedules a debounced recycle; null otherwise. */
  pendingRecycleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True once a stored-state-validation spine run has claimed this
   * entry's persistence attach. The deferred pass can dispatch onto the
   * same entry more than once (the instance id transitioning
   * id → null → id re-runs it), and a second spine racing an in-flight
   * one would peek and attach in parallel. One-shot per entry: every
   * terminal spine outcome (attach, refuse-and-replace, abort on a
   * stale entry, or a failed/timed-out peek that leaves the entry
   * cacheless for the session) makes a retry on the SAME entry
   * meaningless.
   */
  persistenceAttachOwned: boolean;
  /**
   * Idempotence guard for the server-driven doc-level close handler. A
   * single close can fire `'close'` once, but rapid back-to-back closes
   * (e.g., two MCP renames on the same docName before re-auth completes)
   * would otherwise issue parallel `sendToken` calls and racy
   * authenticationFailed dispatches. The flag flips true on first close,
   * resets when `sendToken` settles (success or failure).
   */
  serverDrivenCloseReauthInFlight: boolean;
}

/**
 * Transient state inside `destroyEntry` between the kind flip and
 * removal from `entries`. All cleanup-fields are nulled by the time
 * `destroyEntry` finishes; consumers that observe a `TearingDown` entry
 * via a stale event-handler closure should bail.
 */
interface TearingDownPoolEntry extends PoolEntryBase {
  kind: 'tearing-down';
  persistence: null;
  observerCleanup: null;
  observerFireCounterCleanup: null;
  pendingRecycleTimer: null;
  serverDrivenCloseReauthInFlight: false;
}

type PoolEntry = ActivePoolEntry | TearingDownPoolEntry;

type RenameRedirectHandler = (args: {
  fromDocName: string;
  toDocName: string;
  hadOpenProvider: boolean;
}) => void;

/**
 * DEV-only observer-fire counter.
 *
 * Counts `afterAllTransactions` drains on `provider.document` whose
 * transactions include any non-local (remote) write. Per-docName fires
 * accumulate on `globalThis.__okPerfCounters.providerObserverFires[docName]`,
 * read by perf scenarios at start + end of each measurement window for a
 * fires-per-second delta.
 *
 * Production path: `import.meta.env.PROD === true` short-circuits both
 * the installer (returns a no-op cleanup) and the bump function. The
 * counter map is therefore never created on prod, and the call site in
 * `open()` retains a null `observerFireCounterCleanup` ref. Bundle DCE
 * removes the inner bodies; only the inert call sites remain. Pattern
 * matches `lib/perf/env-override.ts`.
 */
type ObserverCounterMap = { providerObserverFires: Record<string, number> };
const counterGlobal = globalThis as unknown as { __okPerfCounters?: ObserverCounterMap };

function bumpObserverFire(docName: string): void {
  if (import.meta.env.PROD === true) return;
  let bag = counterGlobal.__okPerfCounters;
  if (!bag) {
    bag = { providerObserverFires: {} };
    counterGlobal.__okPerfCounters = bag;
  }
  bag.providerObserverFires[docName] = (bag.providerObserverFires[docName] ?? 0) + 1;
}

function clearObserverFireCounter(docName: string): void {
  if (import.meta.env.PROD === true) return;
  const bag = counterGlobal.__okPerfCounters;
  if (!bag) return;
  delete bag.providerObserverFires[docName];
}

function installProviderObserverCounter(doc: Y.Doc, docName: string): () => void {
  if (import.meta.env.PROD === true) return () => {};
  // Y.Doc's `afterAllTransactions` fires with `(doc, transactions)` per yjs
  // event signatures. We ignore the doc arg — the closure already captures
  // the docName key. A drain that includes any non-local (remote) transaction
  // bumps the per-docName counter once, regardless of how many remote txns
  // it contains. Per-drain semantic matches the measurement contract:
  // fire rate per measurement window via start/end deltas.
  const handler = (_doc: Y.Doc, transactions: Y.Transaction[]) => {
    if (transactions.some((tx) => !tx.local)) bumpObserverFire(docName);
  };
  doc.on('afterAllTransactions', handler);
  return () => doc.off('afterAllTransactions', handler);
}

type PoolChangeCallback = () => void;

let editorSchema: ReturnType<typeof getSchema> | null = null;

function getEditorSchema(): ReturnType<typeof getSchema> {
  editorSchema ??= getSchema(sharedExtensions);
  return editorSchema;
}

/**
 * How long to wait after a disconnect before recycling the provider (ms).
 * During this window the provider's built-in exponential backoff handles
 * reconnection attempts. If it reconnects and syncs, the pending recycle is
 * cancelled. If the window expires with the provider still disconnected, a
 * single recycle fires. Rapid disconnect events (server flapping) reset the
 * timer — collapsing a flap storm into one recycle at the end.
 *
 * 4s is long enough to ride out a server restart cycle (typically 1-3s) and
 * short enough that the user doesn't stare at a stale disconnected state.
 * Validated by the Liveblocks `lostConnectionTimeout` pattern (default 5s).
 */
const RECYCLE_DEBOUNCE_MS = 4_000;
const CLEAR_DATA_TIMEOUT_MS = 10_000;

type ClientPersistenceFactory = (args: {
  branch: string;
  serverInstanceId: string;
  docName: string;
  doc: Y.Doc;
}) => ClientPersistenceProvider;

type PeekStoredLineageEpoch = (args: PeekStoredLineageEpochArgs) => Promise<string | null>;

class ClientPersistenceClearTimeoutError extends Error {
  constructor(
    readonly docName: string,
    readonly timeoutMs: number,
  ) {
    super(`client persistence clearData timed out for ${docName} after ${timeoutMs}ms`);
    this.name = 'ClientPersistenceClearTimeoutError';
  }
}

class StoredEpochPeekTimeoutError extends Error {
  constructor(
    readonly docName: string,
    readonly timeoutMs: number,
  ) {
    super(`stored-state epoch peek timed out for ${docName} after ${timeoutMs}ms`);
    this.name = 'StoredEpochPeekTimeoutError';
  }
}

/**
 * localStorage key for the persisted last-observed git branch. Used by
 * `ProviderPool` to seed the cross-branch defense's in-memory cache on
 * a fresh tab so the very first auth-token claim is checked against
 * the server's current branch (closes the fresh-tab-with-stale-IDB
 * gap). Single key per origin is fine — a single Hocuspocus server's
 * branch is global to the project.
 */
const LAST_OBSERVED_BRANCH_KEY = 'ok-last-observed-branch';

/**
 * localStorage key for the persisted per-doc lineage-epoch records.
 * Single envelope per origin:
 * `{ branch, serverInstanceId, epochs: Record<docName, epoch> }` —
 * validated against the current observed branch + live instance id on
 * load, so a stale envelope (server restarted, branch switched) is
 * treated as empty rather than leaking dead-lineage claims. Mirrors the
 * `LAST_OBSERVED_BRANCH_KEY` pattern above, including its co-eviction
 * assumption: localStorage and IDB evict together; a record evicted
 * while its IDB rows survive means the claim is absent and the lineage
 * fence does not fire (accepted residual, narrowed by the next learned
 * epoch and the deferred-attach guard).
 */
const DOC_LINEAGE_EPOCHS_KEY = 'ok-doc-lineage-epochs';

/**
 * Periodic full-sync nudge for HocuspocusProvider. Secondary defense against
 * the `synced`-never-fires edge cases documented in hocuspocus#183 and
 * y-websocket#81; the 30s syncPromise timeout is the primary safety net.
 *
 * 5000ms chosen so 0.2 msgs/sec × 10 providers × 2 directions ≈ 4 msgs/sec
 * steady-state — negligible overhead vs the 100 msgs/sec a 200ms interval
 * would generate. Still catches the never-fires edge within 5s,
 * imperceptible vs the 30s timeout.
 */
const FORCE_SYNC_INTERVAL_MS = 5_000;

/**
 * Per-doc cap on the in-memory unsynced-update buffer captured during a
 * `server-instance-mismatch` recycle. A long disconnect window with paste-
 * heavy / agent-driven typing can produce an arbitrarily large
 * `Y.encodeStateAsUpdate(doc, lastAckedSV)` result; without a cap, the pool
 * could hold tens of MB across `MAX_POOL` entries while waiting for the
 * post-recycle `synced` event. 1 MiB matches the pattern used by
 * comparable buffer-and-replay implementations (Liveblocks, AFFiNE) and
 * comfortably fits typical session-length deltas while bounding the
 * pathological case. On overflow the buffer entry is dropped and a
 * loud-fail `mark` event fires so the user-visible "unsynced edits lost"
 * outcome is observable.
 */
const MAX_BUFFER_BYTES = readNumericOverride('MAX_BUFFER_BYTES', 1 * 1024 * 1024);

/**
 * Default pool capacity. Exported so the single point of truth lives in this
 * module (the pool that owns the constraint), and so callers that construct
 * a `ProviderPool` can reference the same name rather than a magic literal.
 *
 * Coupled to `ACTIVITY_MOUNT_LIMIT = 3` (exported from `EditorActivityPool.tsx`)
 * per precedent #18(c): `MAX_POOL` bounds how many warm
 * providers we keep; `ACTIVITY_MOUNT_LIMIT` bounds how many editor subtrees
 * are Activity-mounted inside those providers. The two constraints are
 * intentionally independent — pool-resident-but-not-Activity-mounted docs
 * keep their warm provider (≈5–10 MB) for fast Suspense-gated remount
 * without paying per-editor memory or observer-CPU cost.
 *
 * Changing either constant is an ASK_FIRST boundary. If one moves,
 * audit the other for sympathetic impact.
 */
export const MAX_POOL = readNumericOverride('MAX_POOL', 10);

/**
 * LRU pool of HocuspocusProvider instances. Plain TS class — not a React hook.
 * Owns WebSocket connections, survives React re-renders.
 *
 * **Contract — `wsUrl` is frozen at construction ("first-URL wins").**
 * `DocumentContext` instantiates the module-level singleton the first time
 * `useCollabUrl()` resolves a non-null URL. If `/api/config` later reports a
 * different URL (e.g. `ok start` crashed and was respawned on a different
 * kernel-allocated port, OR the user clicks the ConnectingBanner's Retry
 * after a terminal-state transition and `/api/config` now returns a new
 * port), this pool continues targeting the original URL.
 *
 * Why we accept this today: the built-in HocuspocusProvider exponential
 * backoff + our 4s recycle debounce handle server-restart-on-same-port
 * transparently, which is the common case. Port-change-on-restart is rare
 * enough that a full page reload is an acceptable recovery path — and
 * tearing down live providers mid-session would require deciding about
 * unsaved-CRDT-state preservation, which is out of scope for the
 * Zero-Ceremony Resume bet.
 *
 * The next maintainer who wants dynamic `wsUrl` updates must: (a) add a
 * tear-down + rebuild step keyed on `wsUrl` changes, (b) decide how to
 * reconcile any pending CRDT ops buffered during the disconnect, and (c)
 * extend the multi-client test harness with a port-change scenario.
 */
export class ProviderPool {
  /**
   * Internal mutable map. External callers see the read-only `entries`
   * getter below — `readonly` on the field would prevent reassignment
   * but not Map-level mutation (`set`/`delete`/`clear`). The getter
   * widens the type to `ReadonlyMap` so accidental external writes fail
   * compile.
   */
  private readonly _entries = new Map<string, PoolEntry>();
  /**
   * Read-only view of the live pool. Returned snapshot is the same Map
   * instance — iteration and reads stay zero-copy. Compile-time
   * `ReadonlyMap` typing prevents external `.set` / `.delete` /
   * `.clear` calls; runtime bypass via type-cast is theoretically
   * possible but requires deliberate effort.
   */
  get entries(): ReadonlyMap<string, PoolEntry> {
    return this._entries;
  }
  private lruOrder: string[] = [];
  private activeDocName: string | null = null;
  private readonly maxSize: number;
  private readonly wsUrl: string;
  private readonly recycleDebounceMs: number;
  private readonly clearDataTimeoutMs: number;
  private onChange: PoolChangeCallback | null = null;
  private tabIdentity: { principalId: string; tabSessionId: string } | null = null;
  private serverRestartRecoveryState: ServerRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
  /**
   * Live server instance ID observed from `/api/server-info` or CC1
   * `server-info`. Drives the auth-token claim and the
   * `serverInstanceId` segment of the IndexedDB DB name. Cleared on
   * mismatch so the next epoch cleanly transitions through
   * `whenServerInstanceKnown()` + `attachDeferredPersistence`.
   */
  private cachedServerInstanceId: string | null = null;
  /**
   * One-shot promise handle for callers waiting on a known server epoch.
   * Allocated lazily by `whenServerInstanceKnown()` and resolved (then
   * cleared) the next time `setExpectedServerInstanceId` is called with a
   * non-null id. Once resolved, future `whenServerInstanceKnown()` calls
   * allocate a fresh handle bound to the next epoch transition.
   *
   * `null` arg to `setExpectedServerInstanceId` does NOT reject — the
   * pending handle stays alive until a real epoch lands. This matches the
   * mismatch-recycle path: the handler clears `cachedServerInstanceId` to
   * null mid-recovery, then the boot/refresh fetch races the new id back
   * into place.
   */
  private pendingServerInstanceKnown: {
    promise: Promise<string>;
    resolve: (id: string) => void;
  } | null = null;
  /**
   * Claimed server epoch carried on mismatch auth tokens until recovery
   * reaches a terminal `idle` or `failed` state. Used solely for bounded
   * structured client telemetry alongside `docName` / `branch`.
   */
  private recoveryMismatchStaleClaim: string | undefined;
  /**
   * Unsynced-edit buffer captured per-doc during a `server-instance-mismatch`
   * recycle. Populated right before `clearData()` wipes IDB; drained at the
   * fresh provider's FIRST post-recycle `synced` event when the replay
   * listener applies the bytes back to the Y.Doc. In-memory only — a tab
   * crash inside the recycle window loses the buffer (accepted trade-off).
   */
  private readonly bufferedUpdates = new Map<string, Uint8Array>();
  /**
   * Per-docName `closeAndClearPersistence` in-flight tracking. Drives the
   * delete-then-recreate-same-docname coordination: while a clear is in
   * flight for `docName`, any concurrent `pool.open(docName)` MUST defer
   * its `IndexeddbPersistence` attach. The fresh provider's connection
   * would otherwise be a blocker for the in-flight `deleteDatabase`
   * request (firing `onblocked` on the same dbName, leaving stale rows
   * for the new Y.Doc to hydrate from — exactly the content-duplication
   * bug class clearData is supposed to prevent).
   *
   * Map entries are deleted via a `.then`/`.catch` epilogue when the work
   * settles; the public `closeAndClearPersistence` still swallows the
   * rejection so legacy callers (FileTree bulk rename, EditorTabs
   * cleanup) don't need to handle per-docName failures inside Promise.all
   * batches. The deferred-attach scheduler subscribes to this promise
   * directly (see `open`) and observes both resolve and reject, attaching
   * persistence on success and skipping on failure (entry runs without
   * IDB cache for the rest of the session; the next cold-load retries
   * the clear via the same auth-rejection flow).
   */
  private readonly pendingClears = new Map<string, Promise<void>>();
  /**
   * Per-docName retention of `closeAndClearPersistence` failures across the
   * pendingClears finalize window. The public wrapper swallows clear
   * failures so legacy batch callers (FileTree bulk rename, EditorTabs
   * cleanup) don't see partial-failure rejections, and the in-flight
   * Promise drops out of `pendingClears` once its .then/.catch finalize
   * epilogue runs. Without this set, a non-concurrent reopen of the same
   * docName afterwards (delete → time passes → recreate) observes no
   * in-flight clear and constructs fresh `IndexeddbPersistence` directly
   * against the still-stale IDB rows — hydrating the new Y.Doc with
   * prior-doc content. That's the exact bug class the rename clear flow
   * exists to prevent; `pendingClears` covers the concurrent-race case,
   * but the non-concurrent case slips through unless the failure is
   * durable across the finalize window.
   *
   * Entries are added in the catches of `executeCloseAndClearPersistence`
   * before re-throwing. `pool.open(docName)` re-runs the clear via
   * `runCloseAndClearPersistence` and clears the entry on retry success
   * via `executeCloseAndClearPersistence`'s post-clear cleanup. `dispose()`
   * drops the set wholesale.
   */
  private readonly clearFailures = new Set<string>();
  private readonly persistenceFactory: ClientPersistenceFactory;
  /**
   * Injectable read of the stored rows' in-band lineage epoch (see
   * `peekStoredLineageEpoch`). Same DI rationale as `persistenceFactory`:
   * unit tests stage stored-state shapes without a real IndexedDB.
   */
  private readonly peekStoredEpoch: PeekStoredLineageEpoch;

  /**
   * Storage handle the pool reads/writes `lastObservedBranch` through.
   * Defaults to `globalThis.localStorage` in browser bundles; tests pass
   * a `Map`-backed stub. `null` disables persistence entirely (the
   * in-memory cache still works). Mirrors the DI pattern used by
   * `use-editor-mode.ts` so the Bun test runner — which has no DOM
   * globals — can exercise the persistence code path directly.
   */
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

  constructor(
    maxSize: number,
    wsUrl: string,
    options?: {
      recycleDebounceMs?: number;
      clearDataTimeoutMs?: number;
      storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
      persistenceFactory?: ClientPersistenceFactory;
      peekStoredLineageEpoch?: PeekStoredLineageEpoch;
    },
  ) {
    this.maxSize = maxSize;
    // wsUrl is REQUIRED — resolved asynchronously by `useCollabUrl()` from
    // the `ok ui` /api/config endpoint before the pool is instantiated.
    // Callers must not pass an empty string.
    this.wsUrl = wsUrl;
    this.recycleDebounceMs = options?.recycleDebounceMs ?? RECYCLE_DEBOUNCE_MS;
    this.clearDataTimeoutMs = options?.clearDataTimeoutMs ?? CLEAR_DATA_TIMEOUT_MS;
    this.persistenceFactory = options?.persistenceFactory ?? createClientPersistence;
    this.peekStoredEpoch = options?.peekStoredLineageEpoch ?? peekStoredLineageEpoch;
    if (options?.storage !== undefined) {
      this.storage = options.storage;
    } else {
      // `globalThis.localStorage` is undefined under SSR + the Bun test
      // runner; fall back to null so the pool gracefully no-ops.
      this.storage =
        typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
    }
  }

  /**
   * Set the browser tab's identity (principalId + tabSessionId) after the
   * principal has been fetched from the server. New provider opens will
   * include this as a JSON `token` in the HocuspocusProvider so the server's
   * `onAuthenticate` hook can set `connection.context.principalId` for
   * correct writer attribution.
   */
  setTabIdentity(identity: { principalId: string; tabSessionId: string }): void {
    this.tabIdentity = identity;
  }

  /**
   * Update the live server instance ID observed from `/api/server-info` or CC1
   * `server-info`. Does NOT overwrite the storage-backed IDB-associated ID:
   * a fast boot fetch after server restart must not mask stale IDB contents
   * before the first document provider opens.
   *
   * On a non-null id this also (a) resolves any pending
   * `whenServerInstanceKnown()` handle and (b) retroactively attaches
   * persistence to entries opened during the cold-boot window before the
   * epoch was known. Persistence is `IndexeddbPersistence`-backed and the
   * DB-name shape `ok-ydoc:${branch}:${serverInstanceId}:${docName}`
   * carries the epoch as a structural correctness signal; opening a
   * provider before the live epoch is known means the DB cannot be
   * attached at admission time without picking the wrong epoch.
   */
  setExpectedServerInstanceId(id: string | null): void {
    this.cachedServerInstanceId = id;
    if (id === null || id.length === 0) return;
    if (this.pendingServerInstanceKnown !== null) {
      const pending = this.pendingServerInstanceKnown;
      this.pendingServerInstanceKnown = null;
      pending.resolve(id);
    }
    this.attachDeferredPersistence(id);
  }

  /**
   * Resolve once a non-null server instance ID is known to the pool.
   *
   * - Resolves immediately when `cachedServerInstanceId` is already set.
   * - Otherwise returns a single shared pending promise; subsequent calls
   *   during the same wait window share the same handle.
   * - Resolved promises are stable: a later `setExpectedServerInstanceId`
   *   with a different id does NOT re-resolve an already-returned
   *   handle. The next fresh call observes the new id.
   * - `setExpectedServerInstanceId(null)` does NOT reject pending
   *   handles — null is a transient state during mismatch recovery, and
   *   the boot/refresh fetch is expected to land the next epoch shortly
   *   after.
   */
  whenServerInstanceKnown(): Promise<string> {
    if (this.cachedServerInstanceId !== null && this.cachedServerInstanceId.length > 0) {
      return Promise.resolve(this.cachedServerInstanceId);
    }
    if (this.pendingServerInstanceKnown !== null) {
      return this.pendingServerInstanceKnown.promise;
    }
    let resolve!: (id: string) => void;
    const promise = new Promise<string>((res) => {
      resolve = res;
    });
    this.pendingServerInstanceKnown = { promise, resolve };
    return promise;
  }

  /**
   * Single constructor for client persistence. Boundary contract: every
   * persistence attach is either CLAIM-FENCED (the synchronous admission
   * attach in `open()` — the auth token carried the rows' recorded epoch
   * and the server rejects stale claims before any Yjs sync can run) or
   * STORED-STATE-VALIDATED (`validateStoredStateThenAttach`). Exactly two
   * callers; a third path would re-open the dead-lineage union-merge
   * corruption class this pair of fences closes.
   */
  private buildPersistence(
    serverInstanceId: string,
    docName: string,
    doc: Y.Doc,
  ): ClientPersistenceProvider {
    return this.persistenceFactory({
      branch: this.normalizedObservedBranch(),
      serverInstanceId,
      docName,
      doc,
    });
  }

  /**
   * Stored-state validation spine — the only asynchronous route to
   * `buildPersistence`. Validates the lineage of the stored IndexedDB
   * rows IN-BAND (the epoch travels with the rows; see
   * `peekStoredLineageEpoch`) before they may hydrate into the live doc.
   * Unlike the localStorage record, the in-band epoch is total over
   * every post-epoch row set: no read-timing window (instance-unknown
   * boot) or storage-eviction pattern (record evicted, rows surviving)
   * can detach it from the state it identifies.
   *
   *   stored epoch  | live epoch       | action
   *   --------------|------------------|---------------------------------
   *   absent        | any              | attach (nothing to validate:
   *                 |                  | first open, post-clear reattach,
   *                 |                  | offline-only or pre-epoch rows)
   *   present       | === stored       | attach (same lineage — the warm
   *                 |                  | reload this cache exists for)
   *   present       | differs / absent | refuse; recover via the same
   *                 |                  | close → clear → reopen machinery
   *                 |                  | as the record-present arms
   *
   * The live doc's epoch is only trustworthy post-sync, so when stored
   * rows carry an epoch and the entry hasn't synced yet the spine waits
   * for the entry's first `synced` event. No offline regression hides in
   * that wait: every flow that reaches the spine already required live
   * server contact (the deferred pass needs the server-info fetch, the
   * admission dispatch needs `cachedServerInstanceId`).
   *
   * Refused rows are discarded, not buffered: a Yjs delta extending a
   * dead lineage IS the corruption vector (same policy as the
   * auth-rejection arm and `handleServerInstanceMismatch`'s no-baseline
   * drop). The structured `ok-doc-lineage-mismatch` emission is what
   * makes the discarded population observable.
   *
   * Entry identity is rechecked after every await per this file's
   * stale-closure idiom; `persistenceAttachOwned` keeps a re-dispatch
   * from racing an in-flight run.
   */
  private async validateStoredStateThenAttach(
    entry: ActivePoolEntry,
    serverInstanceId: string,
  ): Promise<void> {
    if (entry.persistenceAttachOwned) return;
    entry.persistenceAttachOwned = true;
    const docName = entry.docName;
    // `pendingClears` is part of the currency check: a clear in flight for
    // this docName owns the (deferred) attach via its own scheduler, and a
    // peek now would both read rows scheduled for deletion and block the
    // pending `deleteDatabase` with a competing connection.
    const entryIsCurrent = (): boolean =>
      this._entries.get(docName) === entry &&
      entry.kind === 'active' &&
      entry.persistence === null &&
      !this.pendingClears.has(docName);
    if (!entryIsCurrent()) return;
    let storedEpoch: string | null;
    try {
      // The peek can wedge indefinitely (e.g. its versionless open queued
      // behind another tab's blocked `deleteDatabase` — invisible to this
      // tab's `pendingClears`). Bound it so a wedge decays into the
      // observable failure arm below instead of a silent forever-cacheless
      // entry with the attach ownership latched.
      storedEpoch = await new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new StoredEpochPeekTimeoutError(docName, this.clearDataTimeoutMs));
        }, this.clearDataTimeoutMs);
        this.peekStoredEpoch({
          branch: this.normalizedObservedBranch(),
          serverInstanceId,
          docName,
        }).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    } catch (err: unknown) {
      // Stored state we cannot read must not hydrate. Leave the entry
      // cacheless for the session — the same degraded-but-correct mode as
      // a failed attach; WS sync remains the source of truth.
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-client-persistence-attach-failed',
        ...this.recoveryTelemetryBase(docName),
        phase: 'peek',
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!entryIsCurrent()) return;
    if (storedEpoch === null) {
      this.attachValidatedPersistence(entry, serverInstanceId);
      return;
    }
    if (!entry.hasSynced) {
      await this.awaitFirstSyncOrDestroy(entry);
      if (!entryIsCurrent() || !entry.hasSynced) return;
    }
    const liveEpochRaw = entry.provider.document.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
    const liveEpoch =
      typeof liveEpochRaw === 'string' && liveEpochRaw.length > 0 ? liveEpochRaw : null;
    if (liveEpoch === storedEpoch) {
      this.attachValidatedPersistence(entry, serverInstanceId);
      return;
    }
    this.emitStructuredClientRecoveryEvent({
      event: 'ok-doc-lineage-mismatch',
      ...this.recoveryTelemetryBase(docName),
      via: 'stored-state-validation',
      staleEpoch: storedEpoch,
      liveEpoch: liveEpoch ?? '<absent>',
    });
    const wasActive = this.activeDocName === docName;
    // Synchronously registers `pendingClears` + closes the entry, so the
    // open() below defers its persistence attach past the clear.
    void this.runCloseAndClearPersistence(docName);
    const reopened = this.open(docName);
    if (reopened !== null && wasActive) this.setActive(docName);
  }

  /**
   * Terminal attach arm of the spine. Builds persistence and schedules
   * the warm-cache backfill for attaches that land after sync already
   * delivered content (see `flushFullState` on the provider interface —
   * without the backfill those caches silently degrade to orphan rows).
   */
  private attachValidatedPersistence(entry: ActivePoolEntry, serverInstanceId: string): void {
    const docName = entry.docName;
    try {
      const persistence = this.buildPersistence(serverInstanceId, docName, entry.provider.document);
      entry.persistence = persistence;
      // Externally observable state change — match the pool's notify-on-state-change
      // pattern used at every other null→real persistence transition site.
      this.notify();
      // A failed backfill degrades the warm cache to orphan rows — the same
      // population the sibling degraded arms make observable, so it routes
      // through the structured emitter rather than a bare console.warn.
      void this.backfillCacheAfterFirstSync(entry, persistence).catch((err: unknown) => {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-client-persistence-attach-failed',
          ...this.recoveryTelemetryBase(docName),
          phase: 'backfill',
          errorName: err instanceof Error ? err.name : 'non-error-throw',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err: unknown) {
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-client-persistence-attach-failed',
        ...this.recoveryTelemetryBase(docName),
        phase: 'attach',
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Flush the doc's full state into the just-attached cache once both the
   * IDB hydrate and the entry's first WS sync have completed. Spine
   * attaches can land at any point relative to sync, and updates applied
   * to the doc BEFORE the attach are invisible to y-indexeddb's
   * incremental listener — flushing once after first sync makes the cache
   * complete regardless of which side won that race.
   */
  private async backfillCacheAfterFirstSync(
    entry: ActivePoolEntry,
    persistence: ClientPersistenceProvider,
  ): Promise<void> {
    await persistence.whenSynced;
    if (!entry.hasSynced) {
      await this.awaitFirstSyncOrDestroy(entry);
    }
    if (
      this._entries.get(entry.docName) !== entry ||
      entry.kind !== 'active' ||
      entry.persistence !== persistence ||
      !entry.hasSynced
    ) {
      return;
    }
    await persistence.flushFullState();
  }

  /**
   * Settle once the entry's provider has either delivered its first
   * `synced` event or been destroyed. The `destroy` arm is load-bearing
   * against hung awaits: a recycled provider never syncs, and Hocuspocus
   * emits `destroy` before `removeAllListeners()`, so the one-shot
   * listener always settles. Callers re-validate entry identity (and
   * `hasSynced`, to distinguish the destroy arm) after the await.
   */
  private async awaitFirstSyncOrDestroy(entry: ActivePoolEntry): Promise<void> {
    if (entry.hasSynced) return;
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        entry.provider.off('synced', settle);
        entry.provider.off('destroy', settle);
        resolve();
      };
      entry.provider.on('synced', settle);
      entry.provider.on('destroy', settle);
    });
  }

  private attachDeferredPersistence(serverInstanceId: string): void {
    // Snapshot — the lineage-guard arm below mutates `_entries` mid-loop
    // (close + reopen). The reopened entry must not be visited by this
    // pass: its attach is owned by the `pendingClears` deferred-attach
    // scheduler, and a direct attach here would hydrate the IDB the
    // in-flight clear is still deleting.
    for (const entry of Array.from(this._entries.values())) {
      if (entry.kind !== 'active') continue;
      if (entry.persistence !== null) continue;
      if (this._entries.get(entry.docName) !== entry) continue;
      // Deferred-attach lineage guard (second door of the doc-lineage
      // fence). This entry opened + synced while the instance id was
      // unknown, so the auth-time epoch claim was deliberately omitted —
      // the IDB rows a late attach would now hydrate were written under
      // the lineage recorded at open() time. When that record exists and
      // differs from the lineage this entry actually synced, hydrating
      // would union-merge a dead lineage into the live doc: route through
      // the same close → clear → reopen recovery as the auth-rejection
      // arm instead. Compare against the open-time SNAPSHOT, not the
      // record map's current value — this entry's own `synced` handler
      // already re-recorded the fresh epoch, which describes the live
      // doc, not the stale IDB rows.
      if (entry.hasSynced && entry.lineageEpochRecordAtOpen !== null) {
        const liveEpoch = entry.provider.document.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
        if (
          typeof liveEpoch === 'string' &&
          liveEpoch.length > 0 &&
          liveEpoch !== entry.lineageEpochRecordAtOpen
        ) {
          const docName = entry.docName;
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-doc-lineage-mismatch',
            ...this.recoveryTelemetryBase(docName),
            via: 'deferred-attach',
            staleEpoch: entry.lineageEpochRecordAtOpen,
            liveEpoch,
          });
          const wasActive = this.activeDocName === docName;
          void this.runCloseAndClearPersistence(docName);
          const reopened = this.open(docName);
          if (reopened !== null && wasActive) this.setActive(docName);
          continue;
        }
      }
      // Every other deferred attach — record absent (boot-window
      // snapshot, evicted envelope, pre-epoch profile), record present
      // but not yet synced, or record present and matching — routes
      // through the spine, which validates the rows' own in-band epoch.
      // The record-absent population in particular used to attach
      // unconditionally here; it is exactly the unfenced door the spine
      // closes.
      void this.validateStoredStateThenAttach(entry, serverInstanceId);
    }
  }

  getServerRestartRecoveryState(): ServerRestartRecoveryState {
    return this.serverRestartRecoveryState;
  }

  /**
   * Advance the entry's `lastDiskAckedSV` watermark via element-wise
   * max-merge with any prior value. Called by `SystemDocSubscriber`
   * for every CC1 `disk-ack` payload AND by every `/api/server-info`
   * batch refresh — the server has just durably written the doc up to
   * this state vector. `handleServerInstanceMismatch` prefers
   * `lastDiskAckedSV` over `lastServerSyncedSV` when computing the
   * recycle buffer baseline: disk-ack'd updates will survive the
   * markdown rebuild on server-restart, so they don't need to be
   * replayed (and replaying them is what causes the mid-drain
   * duplication bug).
   *
   * **Why merge, not overwrite.** Disk-ack updates flow over two
   * independent channels (CC1 stateless WS + `/api/server-info` HTTP)
   * that aren't ordered relative to each other. The server's per-doc
   * SV is monotonic at emit time, but a slow HTTP response can land
   * AFTER a newer WS broadcast — a pure overwrite would regress
   * `lastDiskAckedSV` from the newer to the older value, reopening
   * the disk-ack-staleness duplication path on the next
   * mismatch-recycle. Element-wise max-merge is conservative across
   * out-of-order receives: the merged SV is at least as advanced as
   * either input in every clientID dimension.
   *
   * No-op when no entry exists for `docName` or the entry is
   * tearing-down — both signal "this doc isn't an active part of the
   * pool right now," and a stale watermark on a future entry would
   * be incorrect anyway (each fresh entry starts at null).
   */
  observeDiskAck(docName: string, sv: Uint8Array): void {
    const entry = this.entries.get(docName);
    if (!entry || entry.kind !== 'active') return;
    entry.lastDiskAckedSV = mergeStateVectors(entry.lastDiskAckedSV, sv);
  }

  /**
   * Refresh the `lastDiskAckedSV` watermark for every doc named in the
   * batch via the same element-wise max-merge as `observeDiskAck`.
   * Called by the boot fetch + every `__system__` reconnect via
   * `GET /api/server-info`'s `currentDiskAckSVs` field — closes the
   * missed-frame gap that CC1 stateless broadcasts leave open (no
   * replay; a brief `__system__` WS drop during a write burst would
   * otherwise leave `lastDiskAckedSV` permanently stale and reopen
   * the disk-ack-staleness duplication path on server-restart).
   *
   * Per-doc semantics match `observeDiskAck`: skip when no entry
   * exists for the doc or when the entry is tearing-down. Docs in the
   * batch that the client doesn't have open are silently ignored.
   * The merge protects against the WS+HTTP cross-over window where
   * a slow batch response could otherwise overwrite a newer
   * live-broadcast SV.
   */
  observeDiskAckBatch(svsByDocName: Record<string, Uint8Array>): void {
    for (const [docName, sv] of Object.entries(svsByDocName)) {
      this.observeDiskAck(docName, sv);
    }
  }

  /**
   * Last-observed git branch reported by the server (via `/api/server-info`
   * boot fetch + CC1 `server-info` broadcasts).
   *
   * Persisted to `localStorage` so cold-boot tabs claim the correct branch
   * in their first auth token. Without persistence the in-memory cache is
   * empty on a fresh tab → `expectedBranch` claim is omitted → server
   * accepts unconditionally → the IndexeddbPersistence then hydrates
   * stale-branch Y.Doc state, which Yjs sync union-merges with the
   * server's current-branch state (ghost items, the exact bug class this
   * defense exists to prevent). The persisted value lets the very first
   * post-restore connect's auth-token claim be checked against the
   * server's current branch, so a fresh tab against a switched branch
   * gets rejected → recycled → IDB cleared before sync runs.
   *
   * Lazily seeded from localStorage on first read (see
   * `getOrInitObservedBranch` below) — `localStorage` access at module
   * load would break SSR / Node test environments where `localStorage`
   * is undefined.
   *
   * **Co-eviction assumption.** This defense relies on `localStorage` and
   * IDB staying in sync as a unit. Modern browsers evict both together
   * (same "best-effort" eviction bucket), but a manual mismatch — e.g.
   * DevTools → Application → "Clear storage" with IDB unchecked,
   * profile import/export, custom storage tooling — re-opens the
   * cross-branch ghost-item scenario: localStorage cleared → empty
   * claim → server accepts → stale IDB hydrates → sync union-merge.
   * Recovery requires `provider.clearData()` or a full storage clear.
   * A future structural fix (branch-prefixed IDB names) would remove
   * the assumption; tracked in the spec's deferred-scope list.
   */
  private lastObservedBranch: string | null = null;
  private lastObservedBranchInitialized = false;

  /**
   * Lazy-init the in-memory cache from `this.storage`. Idempotent.
   * Tolerant of missing storage (Node tests, SSR) — falls back to the
   * initial null value.
   */
  private getOrInitObservedBranch(): string | null {
    if (this.lastObservedBranchInitialized) return this.lastObservedBranch;
    this.lastObservedBranchInitialized = true;
    try {
      const stored = this.storage?.getItem(LAST_OBSERVED_BRANCH_KEY) ?? null;
      if (stored !== null && stored.length > 0) {
        this.lastObservedBranch = stored;
      }
    } catch {
      // Storage access can throw in private-mode browsers / sandboxed
      // iframes — fall back to in-memory only.
    }
    return this.lastObservedBranch;
  }

  /**
   * Persist the observed branch alongside the in-memory cache. Tolerant
   * of storage failures (private browsing, quota exceeded) — the
   * in-memory cache always succeeds.
   */
  private persistObservedBranch(branch: string | null): void {
    this.lastObservedBranch = branch;
    this.lastObservedBranchInitialized = true;
    try {
      if (branch === null || branch.length === 0) {
        this.storage?.removeItem(LAST_OBSERVED_BRANCH_KEY);
      } else {
        this.storage?.setItem(LAST_OBSERVED_BRANCH_KEY, branch);
      }
    } catch {
      // Storage write failures are non-fatal — see read-side comment.
    }
  }

  /**
   * Per-doc lineage-epoch records — the client half of the doc-lineage
   * fence (third axis of the stale-client-persistence defense:
   * instance → branch → doc lineage). The server mints an epoch into the
   * doc's `lifecycle` Y.Map whenever persistence seeds it from disk; the
   * pool records the epoch it synced per doc and claims it on the next
   * open so `doc-lineage-guard` (server-side) can reject a stale rejoin
   * BEFORE Yjs sync union-merges two materializations of the same doc.
   *
   * In-memory map is authoritative within a pool lifetime (readable even
   * while the server instance id is unknown — the deferred-attach guard
   * needs the open-time snapshot during exactly that window). The
   * localStorage envelope under `DOC_LINEAGE_EPOCHS_KEY` extends records
   * across tabs/pools; it is folded into the map at most once, and only
   * after it validates against the current observed branch + live
   * instance id (stale envelope ⇒ ignored; the next record write
   * overwrites it). Records from a dead instance/branch that survive in
   * memory self-heal: a stale claim is rejected, the rejection arm drops
   * the record, and the reopen claims nothing.
   */
  private readonly docLineageEpochs = new Map<string, string>();
  private docLineageEpochsEnvelopeConsumed = false;

  /**
   * The branch scope lineage records (and the IDB DB names built by
   * `buildPersistence`) live under when no branch has been observed.
   * Envelope writers and validators must agree on this normalization —
   * a fresh tab that never observes a branch still produces/consumes a
   * consistent envelope.
   */
  private normalizedObservedBranch(): string {
    return this.getOrInitObservedBranch() ?? UNKNOWN_BRANCH_SENTINEL;
  }

  /**
   * Fold the persisted envelope into the in-memory records, at most once
   * per pool lifetime, and only when it validates against the live
   * instance id + observed branch. Called lazily from the read path —
   * validation needs `cachedServerInstanceId`, which is unknown at
   * construction. An envelope that fails validation is permanently
   * stale (its epochs identify lineages of a dead instance or another
   * branch) and is treated as empty.
   */
  private consumeLineageEpochEnvelopeIfValid(): void {
    if (this.docLineageEpochsEnvelopeConsumed) return;
    const instanceId = this.cachedServerInstanceId;
    if (instanceId === null || instanceId.length === 0) return;
    this.docLineageEpochsEnvelopeConsumed = true;
    try {
      const raw = this.storage?.getItem(DOC_LINEAGE_EPOCHS_KEY) ?? null;
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const envelope = parsed as { branch?: unknown; serverInstanceId?: unknown; epochs?: unknown };
      if (envelope.branch !== this.normalizedObservedBranch()) return;
      if (envelope.serverInstanceId !== instanceId) return;
      if (typeof envelope.epochs !== 'object' || envelope.epochs === null) return;
      for (const [docName, epoch] of Object.entries(envelope.epochs as Record<string, unknown>)) {
        if (typeof epoch === 'string' && epoch.length > 0 && !this.docLineageEpochs.has(docName)) {
          this.docLineageEpochs.set(docName, epoch);
        }
      }
    } catch (err: unknown) {
      // Storage access throws in private-mode browsers / sandboxed iframes
      // surface as DOMException and are expected — stay silent. Any other
      // throw (malformed envelope, JSON.parse failure) is unexpected: warn
      // once (the envelope-consumed flag set above makes this at-most-once
      // per pool lifetime). In-memory records still work either way.
      if (!(err instanceof DOMException)) {
        console.warn(
          JSON.stringify({
            event: 'ok-lineage-epoch-envelope-read-error',
            errorName: err instanceof Error ? err.name : typeof err,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  private getRecordedLineageEpoch(docName: string): string | null {
    const inMemory = this.docLineageEpochs.get(docName);
    if (inMemory !== undefined) return inMemory;
    this.consumeLineageEpochEnvelopeIfValid();
    return this.docLineageEpochs.get(docName) ?? null;
  }

  /**
   * Persist the full record map as the storage envelope. Skipped while
   * the instance id is unknown — the envelope must be instance-stamped
   * to be validatable, and an unstamped write would let a later pool
   * claim epochs against the wrong instance. In-memory records written
   * during that window still drive this pool's own claims and the
   * deferred-attach guard.
   */
  private persistLineageEpochEnvelope(): void {
    const instanceId = this.cachedServerInstanceId;
    if (instanceId === null || instanceId.length === 0) return;
    try {
      this.storage?.setItem(
        DOC_LINEAGE_EPOCHS_KEY,
        JSON.stringify({
          branch: this.normalizedObservedBranch(),
          serverInstanceId: instanceId,
          epochs: Object.fromEntries(this.docLineageEpochs),
        }),
      );
    } catch {
      // Storage write failures are non-fatal — mirrors persistObservedBranch.
    }
  }

  private recordLineageEpoch(docName: string, epoch: string): void {
    if (this.docLineageEpochs.get(docName) === epoch) return;
    this.docLineageEpochs.set(docName, epoch);
    this.persistLineageEpochEnvelope();
  }

  private deleteLineageEpochRecord(docName: string): void {
    if (this.docLineageEpochs.delete(docName)) {
      this.persistLineageEpochEnvelope();
    }
  }

  private withClearDataTimeout(docName: string, promise: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new ClientPersistenceClearTimeoutError(docName, this.clearDataTimeoutMs));
      }, this.clearDataTimeoutMs);
      promise.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });
  }

  private recoveryTelemetryBase(
    docName: string,
    staleClaimOverride?: string | undefined,
  ): { docName: string; branch: string; serverInstanceId?: string } {
    const branch = this.normalizedObservedBranch();
    const base: { docName: string; branch: string; serverInstanceId?: string } = {
      docName,
      branch,
    };
    const stale =
      staleClaimOverride !== undefined ? staleClaimOverride : this.recoveryMismatchStaleClaim;
    if (stale !== undefined && stale.length > 0) {
      base.serverInstanceId = stale;
    }
    return base;
  }

  private emitStructuredClientRecoveryEvent(parts: Record<string, string | number>): void {
    console.warn(JSON.stringify(parts));
  }

  private clearRecoveryMismatchStaleClaimIfTerminal(): void {
    const kind = this.serverRestartRecoveryState.kind;
    if (kind === 'idle' || kind === 'failed') {
      this.recoveryMismatchStaleClaim = undefined;
    }
  }

  private beginServerRestartRecovery(docNames: readonly string[], startedAt: number): void {
    this.serverRestartRecoveryState = {
      kind: 'recovering',
      phase: 'clearing-local-cache',
      docNames,
      failedDocNames: [],
      startedAt,
    };
    for (const docName of docNames) {
      invalidateSyncPromise(docName);
    }
    this.notify();
  }

  private enterServerRestartReconnect(
    docNames: readonly string[],
    failedDocNames: readonly string[],
    startedAt: number,
    failureReason: 'clear-data-failed' | 'clear-data-timeout',
  ): void {
    if (docNames.length === 0) {
      this.serverRestartRecoveryState =
        failedDocNames.length === 0
          ? IDLE_SERVER_RESTART_RECOVERY
          : {
              kind: 'failed',
              reason: failureReason,
              docNames: failedDocNames,
              failedDocNames,
              startedAt,
            };
      this.clearRecoveryMismatchStaleClaimIfTerminal();
      this.notify();
      return;
    }

    this.serverRestartRecoveryState = {
      kind: 'recovering',
      phase: 'reconnecting',
      docNames,
      failedDocNames,
      startedAt,
      ...(failedDocNames.length > 0 ? { clearFailureReason: failureReason } : {}),
    };
    this.notify();
  }

  private markServerRestartRecoverySynced(docName: string): void {
    const state = this.serverRestartRecoveryState;
    if (state.kind !== 'recovering' || state.phase !== 'reconnecting') return;
    if (!state.docNames.includes(docName)) return;

    const remaining = state.docNames.filter((candidate) => candidate !== docName);
    if (remaining.length > 0) {
      this.serverRestartRecoveryState = { ...state, docNames: remaining };
      return;
    }

    if (state.failedDocNames.length > 0) {
      this.serverRestartRecoveryState = {
        kind: 'failed',
        reason: state.clearFailureReason ?? 'clear-data-failed',
        docNames: state.failedDocNames,
        failedDocNames: state.failedDocNames,
        startedAt: state.startedAt,
      };
      this.clearRecoveryMismatchStaleClaimIfTerminal();
      return;
    }

    this.serverRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
    this.clearRecoveryMismatchStaleClaimIfTerminal();
  }

  /**
   * Update the observed branch without triggering invalidation. Called by
   * `handleBranchSwitched` after the live broadcast has already fired the
   * recycle, so the comparison path on the next `server-info` frame
   * doesn't double-invalidate.
   */
  setObservedBranch(branch: string): void {
    this.persistObservedBranch(branch);
  }

  /**
   * Compare-and-set the observed branch. Returns `true` when the supplied
   * branch differs from the prior observed value (signalling the caller
   * should run `handleBranchSwitched`); returns `false` on first
   * observation or matching branch. Always advances `lastObservedBranch`
   * to the supplied value.
   */
  compareAndUpdateObservedBranch(branch: string): boolean {
    const prior = this.getOrInitObservedBranch();
    this.persistObservedBranch(branch);
    return prior !== null && prior !== branch;
  }

  /**
   * Handler invoked when the server rejects a connect with
   * `reason: 'branch-mismatch'`. Set by DocumentContext (which owns
   * `handleBranchSwitched` invocation) after pool construction so the
   * pool itself stays free of React/UI imports.
   *
   * Callback MUST return a Promise — the in-flight gate awaits the
   * returned promise to collapse concurrent dispatches across event-
   * loop turns. A `void`-fronted callback (e.g., `() => { void
   * fetch(...) }`) returns `undefined` synchronously; the gate clears
   * on the next microtask while the actual work is still in flight,
   * defeating the gate.
   *
   * In-flight gate: when a branch switch happens server-side that the
   * client missed (offline window, stale IDB), every open provider's
   * auth fails with `branch-mismatch` in quick succession — N parallel
   * `/api/server-info` fetches + N concurrent `handleBranchSwitched`
   * calls would otherwise fan out. The gate collapses concurrent
   * dispatches into a single in-flight promise: the first call runs
   * the user-supplied callback; subsequent calls during that window
   * are dropped (the recycle is already in progress for the whole
   * pool, so re-entry would just churn the active doc's fresh
   * provider).
   */
  // The wrapped dispatcher returns void synchronously (it just kicks off
  // the in-flight promise tracked in `branchMismatchInFlight`); the input
  // callback supplied via `setOnBranchMismatch` MUST return a Promise so
  // the gate can await it across event-loop turns.
  private onBranchMismatch: (() => void) | null = null;
  private branchMismatchInFlight: Promise<void> | null = null;
  /**
   * Resolves when the in-flight `server-instance-mismatch` recycle chain
   * (`handleServerInstanceMismatch`'s `Promise.allSettled` over `clearData`
   * + the trailing `recycleAllEntries`) has settled. `null` between
   * recycles. Mirrors `branchMismatchInFlight`. Tests await
   * `awaitMismatchSettled()` instead of polling on real time.
   */
  private mismatchInFlight: Promise<void> | null = null;
  setOnBranchMismatch(cb: (() => Promise<void>) | null): void {
    if (cb === null) {
      this.onBranchMismatch = null;
      return;
    }
    this.onBranchMismatch = () => {
      if (this.branchMismatchInFlight !== null) return;
      // Wrap `cb()` in `Promise.resolve().then(cb)` rather than
      // `Promise.resolve(cb())` so a synchronous throw from `cb`
      // settles the wrapper as a rejection instead of escaping the
      // gate. Without this, a sync throw bypasses the
      // `branchMismatchInFlight = inflight` assignment entirely; the
      // next dispatch sees a null gate and re-fires the (still
      // throwing) callback.
      const inflight = Promise.resolve()
        .then(cb)
        .finally(() => {
          if (this.branchMismatchInFlight === inflight) {
            this.branchMismatchInFlight = null;
          }
        });
      this.branchMismatchInFlight = inflight;
    };
  }

  /**
   * Auth-rejection cleanup callbacks for the rename-redirect / doc-deleted
   * arms of `onAuthenticationFailed`. Pool computes `hadOpenProvider` from
   * its own entry map (the only state it can observe synchronously); the
   * React layer owns the React-state-aware cleanup (closeAndClearForRename,
   * remapTabsForRename, active-tab navigation) and emits the structured
   * `removal.cleanup` event after the awaited cleanup settles. Mirrors the
   * `setOnBranchMismatch` shape — pool stays free of React/UI knowledge.
   */
  private onRenameRedirect: RenameRedirectHandler | null = null;
  private onDocDeleted: ((args: { docName: string; hadOpenProvider: boolean }) => void) | null =
    null;
  setOnRenameRedirect(cb: RenameRedirectHandler | null): void {
    this.onRenameRedirect = cb;
  }
  setOnDocDeleted(
    cb: ((args: { docName: string; hadOpenProvider: boolean }) => void) | null,
  ): void {
    this.onDocDeleted = cb;
  }

  /** Register a callback that fires whenever pool state changes. */
  setOnChange(cb: PoolChangeCallback | null): void {
    this.onChange = cb;
  }

  private notify(): void {
    this.onChange?.();
  }

  /**
   * Subscribers fired when the pool evicts an entry (whether via LRU,
   * close, recycle, or dispose). The cache module subscribes to clear
   * its `Editor` / `EditorView` cache entries that hold refs to
   * `provider.document` — without this, the next mountTiptapEditor /
   * mountCmEditor call for the same docName would return a stale entry
   * bound to an orphaned Y.Doc.
   *
   * Replaces the explicit `evictTiptapEditor(docName); evictCmEditor(docName)`
   * calls that lived inline in `destroyEntry` — keeps the pool free of
   * cross-module cache knowledge.
   *
   * Subscribers fire AFTER the kind flip to 'tearing-down' but BEFORE
   * `provider.destroy()`, preserving the ordering invariant: cache
   * eviction must run before provider teardown so cached editor
   * destroy() calls operate on a still-live Y.Doc.
   */
  private evictListeners = new Set<(docName: string) => void>();

  /**
   * Subscribe to entry-eviction events. Returns an unsubscribe function.
   * Multiple subscribers all fire in registration order; throws inside
   * a subscriber are caught + logged so one bad subscriber doesn't
   * prevent the others from running.
   */
  onEvict(cb: (docName: string) => void): () => void {
    this.evictListeners.add(cb);
    return () => {
      this.evictListeners.delete(cb);
    };
  }

  private fireEvict(docName: string): void {
    for (const listener of this.evictListeners) {
      try {
        listener(docName);
      } catch (err) {
        console.warn(`[ProviderPool] evict listener threw for ${docName}:`, err);
      }
    }
  }

  /** Touch a doc in the LRU order (move to end = most recently used). */
  private touch(docName: string): void {
    const idx = this.lruOrder.indexOf(docName);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
    this.lruOrder.push(docName);
  }

  /**
   * Open (or reuse) a document. Returns the pool entry, or `null` if the
   * docName is reserved (the `__system__` pseudo-doc carries CC1 signals and
   * is never user-editable). If the pool is at
   * capacity, evicts the LRU entry (never the active doc).
   */
  open(docName: string): PoolEntry | null {
    if (isSystemDoc(docName)) return null;

    const existing = this.entries.get(docName);
    if (existing) {
      const previousAccessedAt = existing.lastAccessedAt;
      existing.lastAccessedAt = Date.now();
      this.touch(docName);
      this.notify();
      // Hit-path visibility: warm-back from the pool. Carries the
      // correlation seed and the pre-touch timestamp so MAX_POOL
      // calibration can reason about reuse age.
      mark('ok/pool/open', {
        docName,
        hit: true,
        lastAccessedAt: previousAccessedAt,
        poolEventId: existing.poolEventId,
      });
      mark.count('ok/pool/open', { hit: true });
      return existing;
    }

    // MISS branch — capture wall-clock at entry so the
    // `ok.provider-pool.open` span emitted just before the `return entry`
    // below carries an accurate duration. Pool MISS work is synchronous —
    // construct provider + attach IDB persistence + wire bridge — so a
    // start/end pair captured around the body is faithful.
    const openStartMs = Date.now();

    // Evict if at capacity
    if (this.entries.size >= this.maxSize) {
      this.evictLru();
    }

    const expectedServerInstanceId = this.cachedServerInstanceId;
    // Snapshot the per-doc lineage record BEFORE this entry's own sync can
    // re-record a fresher value — the deferred-attach guard compares the
    // stale-IDB rows a late attach would hydrate against the lineage that
    // was on record when those rows were last written, not the one this
    // entry just synced. Readable from the in-memory map even while the
    // instance id is unknown (the exact window the guard exists for).
    const lineageEpochRecordAtOpen = this.getRecordedLineageEpoch(docName);
    const token = buildAuthToken(
      this.tabIdentity,
      expectedServerInstanceId,
      this.getOrInitObservedBranch(),
      // Claim the lineage epoch only when the live instance id is known —
      // claims during the instance-unknown boot window would race the
      // instance/branch axes' own recovery with spurious lineage
      // rejections, and the record cannot be instance-validated yet.
      expectedServerInstanceId !== null && expectedServerInstanceId.length > 0
        ? lineageEpochRecordAtOpen
        : null,
    );
    const provider = new HocuspocusProvider({
      // OTel trace context propagation for the WebSocket handshake. The
      // browser's WebSocket API cannot set request headers, so traceparent
      // rides in the query string. No-op when OTel is disabled.
      url: appendTraceContextToCollabUrl(this.wsUrl),
      name: docName,
      forceSyncInterval: FORCE_SYNC_INTERVAL_MS,
      // Always present now — `buildAuthToken` includes client version metadata
      // unconditionally (the v1 wire contract's WS carrier).
      token,
    });

    // Attach client-side Yjs persistence to the provider's Y.Doc. Hydrates
    // from `ok-ydoc:${branch}:${serverInstanceId}:${docName}` on cold mount
    // and persists every non-self update back. On server-instance-mismatch,
    // buffer-and-replay captures unsynced edits before clearData + recycle.
    // The branch + epoch prefix isolates state by IDB-name boundary —
    // different branches → different IDBs by construction; different
    // server epochs → different IDBs by construction, so stale CRDT items
    // from a prior server instance can never be hydrated into a provider
    // that will sync with the current server. `UNKNOWN_BRANCH_SENTINEL` is
    // used when no branch has been observed yet (fresh tab); the
    // auth-token mismatch on first connect drives the recycle to the
    // correct branch-prefixed name.
    //
    // Persistence stays null at admission time when ANY of:
    //   (1) the live server epoch (`cachedServerInstanceId`) is not yet
    //       known — the persistent IDB cache must not attach to an
    //       unknown-epoch DB name. `attachDeferredPersistence` retroactively
    //       builds the IDB cache once `setExpectedServerInstanceId` lands
    //       a non-null id, OR
    //   (2) a `closeAndClearPersistence(docName)` is in flight — opening
    //       a fresh `IndexeddbPersistence` here would create a competing
    //       IDB connection that blocks the in-flight `deleteDatabase`
    //       request from succeeding (firing `onblocked` indefinitely on
    //       the same dbName, leaving stale rows for the new Y.Doc to
    //       hydrate from). Persistence is scheduled to attach (or skip)
    //       once `pendingClear` settles, via the .then below, OR
    //   (3) a prior `closeAndClearPersistence(docName)` failed and the
    //       failure flag in `clearFailures` is still set — the IDB at
    //       `dbName` may still hold the prior session's rows. Re-run the
    //       clear synchronously (registering a fresh `pendingClears` entry)
    //       before reading `pendingClearForDocName` below; the existing
    //       deferred-attach scheduler then handles attach-on-success and
    //       skip-on-failure identically to case (2), OR
    //   (4) no lineage-epoch record existed at open — the auth token
    //       claimed nothing, so nothing fences the stored rows pre-sync.
    //       The stored-state validation spine (dispatched below) reads
    //       the epoch carried in-band by the rows themselves and attaches
    //       only after it validates against the live lineage. The inline
    //       attach here stays reserved for the claim-fenced population:
    //       the token carried the rows' recorded epoch and the server
    //       rejects stale claims before any Yjs sync can run.
    //
    // The provider is still constructed in all cases so the WebSocket
    // handshake can begin in parallel.
    const persistenceServerInstanceId = this.cachedServerInstanceId;
    if (this.clearFailures.has(docName)) {
      // runCloseAndClearPersistence is sync up to the first `await`, so
      // calling it here populates `pendingClears` synchronously before the
      // get() below reads it. The promise it returns rejects on retry
      // failure, which the existing deferred-attach .then chain converts
      // to the structured `ok-pool-deferred-persistence-attach-skipped`
      // warn. We do not await the returned promise: the goal is to make
      // the new entry observe the in-flight clear (deferred attach), not
      // to block open() on the clear settling.
      void this.runCloseAndClearPersistence(docName);
    }
    const pendingClearForDocName = this.pendingClears.get(docName);
    const idbAttachStart = import.meta.env.PROD === true ? 0 : performance.now();
    const persistence: ClientPersistenceProvider | null =
      persistenceServerInstanceId !== null &&
      persistenceServerInstanceId.length > 0 &&
      pendingClearForDocName === undefined &&
      lineageEpochRecordAtOpen !== null
        ? this.buildPersistence(persistenceServerInstanceId, docName, provider.document)
        : null;
    // Split cold-LOAD's IDB-hydrate phase. `idb-attach` fires when the IDB
    // persister is wired to the doc; `synced-after-idb` fires when its
    // whenSynced resolves (IDB hydrate complete); `idb-bypass-no-epoch`
    // fires when persistence stays null at admission, with `reason`
    // distinguishing why (live server epoch unknown / clear in flight /
    // record absent → stored-state validation). Together with
    // `ok/pool/idb-whensynced` (client-persistence.ts), the cold-LOAD
    // wall = idb-attach → synced-after-idb (IDB phase) + provider-synced
    // (WS phase) + ok/cold/editor-* (PM phase).
    if (import.meta.env.PROD !== true) {
      if (persistence !== null) {
        mark(
          'ok/pool/idb-attach',
          { docName, serverInstanceId: persistenceServerInstanceId ?? '' },
          { startTime: idbAttachStart, duration: 0 },
        );
        persistence.whenSynced.then(() => {
          const now = performance.now();
          mark(
            'ok/pool/synced-after-idb',
            { docName, durationMs: Math.round((now - idbAttachStart) * 1000) / 1000 },
            { startTime: idbAttachStart, duration: now - idbAttachStart },
          );
        });
      } else {
        mark(
          'ok/pool/idb-bypass-no-epoch',
          {
            docName,
            reason:
              persistenceServerInstanceId === null || persistenceServerInstanceId.length === 0
                ? 'no-epoch'
                : pendingClearForDocName !== undefined
                  ? 'pending-clear'
                  : 'stored-state-validation',
          },
          { startTime: idbAttachStart, duration: 0 },
        );
      }
    }

    const poolEventId = crypto.randomUUID();
    const entry: ActivePoolEntry = {
      kind: 'active',
      provider,
      persistence,
      lastServerSyncedSV: null,
      lastDiskAckedSV: null,
      observerCleanup: null,
      observerFireCounterCleanup: installProviderObserverCounter(provider.document, docName),
      syncState: 'connecting',
      docName,
      lastAccessedAt: Date.now(),
      poolEventId,
      hasSynced: false,
      pendingRecycleTimer: null,
      bridgeSetupFailed: false,
      serverDrivenCloseReauthInFlight: false,
      persistenceAttachOwned: false,
      lineageEpochRecordAtOpen,
    };
    // Miss-path visibility: a fresh provider was constructed. Pair the
    // mark + counter so MAX_POOL hit-rate is queryable and the
    // poolEventId can later be adopted as `mountId` by the activity
    // pool.
    mark('ok/pool/open', { docName, hit: false, poolEventId });
    mark.count('ok/pool/open', { hit: false });

    // Track sync state
    const onStatus = ({ status }: { status: string }) => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      if (status === 'disconnected') {
        entry.syncState = 'disconnected';
        this.notify();
      }
    };
    const onSynced = () => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      entry.syncState = 'synced';
      entry.hasSynced = true;
      // Refresh the "last server acked" state vector on every sync event —
      // the delta between this and the doc's current state is what the
      // `server-instance-mismatch` recycle buffers before calling clearData.
      entry.lastServerSyncedSV = captureStateVector(provider.document);
      // Record the lineage epoch this client just synced. The epoch rides
      // in-band on the doc's `lifecycle` map (minted server-side at
      // seed-from-disk), so by the time `synced` fires it is present for
      // any doc the current server loaded. Absent on docs loaded by a
      // pre-epoch server — record nothing, the next open claims nothing,
      // and the legacy accept path applies.
      const syncedLineageEpoch = provider.document.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
      if (typeof syncedLineageEpoch === 'string' && syncedLineageEpoch.length > 0) {
        this.recordLineageEpoch(docName, syncedLineageEpoch);
      }
      // Cancel pending recycle — provider reconnected successfully
      if (entry.pendingRecycleTimer) {
        clearTimeout(entry.pendingRecycleTimer);
        entry.pendingRecycleTimer = null;
      }
      this.markServerRestartRecoverySynced(docName);
      this.notify();

      // Set up bidirectional observers once after first sync. A throw here
      // (Y.js observer wiring failure, baseline read crash, schema mismatch)
      // is rare but must not be silent — without surfacing it through the
      // syncPromise, the user would see the doc vanish and fall back to the
      // empty "Select a document" state with no signal about what happened.
      //
      // Path: reject the syncPromise with BridgeSetupError + mark the entry
      // bridgeSetupFailed. The entry stays in the pool so `activeProvider`
      // remains non-null and `EditorArea` continues to render the boundary
      // subtree — `DocumentBoundary`'s suspended fiber re-renders, `use()`
      // re-throws the rejection, and `DocumentErrorBoundary` shows the
      // "Couldn't open document" UI. The user-driven retry path
      // (`pool.recycle(docName)`) destroys + recreates the entry on click;
      // until then the broken provider stays pool-resident but inert
      // (observers not wired, no further writes possible from this client).
      if (!entry.observerCleanup) {
        try {
          const doc = provider.document;
          const mdMgr = new MarkdownManager({ extensions: sharedExtensions });
          entry.observerCleanup = setupObservers({
            doc,
            xmlFragment: doc.getXmlFragment('default'),
            ytext: doc.getText('source'),
            mdManager: mdMgr,
            schema: getEditorSchema(),
            onSyncError: (direction, error) => {
              console.warn(`[Sync] ${direction} failed for ${docName}:`, error.message);
            },
          });
        } catch (err) {
          console.error(`[ProviderPool] setupObservers init failed for ${docName}:`, err);
          entry.bridgeSetupFailed = true;
          rejectSyncPromise(docName, new BridgeSetupError(docName, err));
        }
      }
    };
    const onDisconnect = () => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      entry.syncState = 'disconnected';
      this.notify();

      // If this provider has no local-only CRDT changes buffered, schedule a
      // debounced recycle. During the debounce window the provider's built-in
      // exponential backoff handles reconnection — if it syncs before the timer
      // fires, onSynced cancels the pending recycle. Only the FIRST disconnect
      // sets the timer; subsequent disconnects (from failed reconnect attempts)
      // are no-ops — they shouldn't extend the window because each one just
      // means "still can't reach the server."
      if (entry.hasSynced && provider.unsyncedChanges === 0 && !entry.pendingRecycleTimer) {
        entry.pendingRecycleTimer = setTimeout(() => {
          // Re-narrow inside the timer closure — `entry` was Active when the
          // timer was scheduled, but TS doesn't carry the narrowing across
          // the async boundary, and the entry may have been torn down before
          // the timer fired.
          if (entry.kind !== 'active') return;
          entry.pendingRecycleTimer = null;
          if (this.entries.get(docName) !== entry) return;
          this.recycleDisconnectedEntry(docName);
        }, this.recycleDebounceMs);
      }
    };

    // CRDT server-restart recovery (Shape 2+): when the server's
    // `onAuthenticate` throws with `reason: 'server-instance-mismatch'`,
    // OUR Y.Doc and OUR IndexedDB carry ghost items from the prior server
    // incarnation — letting Yjs sync merge them additively under the fresh
    // server's state produces the content-duplication bug class.
    //
    // The recycle flow is:
    //   1. Buffer each entry's unsynced delta (client's own writes the
    //      server hasn't yet acked) relative to its last-acked state vector.
    //   2. `clearData()` every entry's persistence — wipes IDB. Load-bearing:
    //      must run BEFORE the destroy/recycle path so the fresh provider
    //      hydrates an EMPTY IDB before sync delivers the markdown-rebuilt
    //      server state. Without this, the fresh Y.Doc rehydrates pre-
    //      restart items and observer-bridge resync writes under the new
    //      clientID produce 3x duplication.
    //   3. `recycleAllEntries()` — destroys every provider + re-opens the
    //      active doc with a fresh Y.Doc + fresh (empty) IDB.
    //   4. On the fresh provider's FIRST `synced` event, replay the buffered
    //      bytes back onto the Y.Doc so the user's unsynced edits survive.
    //
    // Idempotence: after a server restart, every open provider fires
    // authenticationFailed in quick succession. The first call clears the
    // IDB-associated claim; sibling failures with the same stale claim then
    // short-circuit while preserving any already-observed fresh server ID.
    const onAuthenticationFailed = ({ reason }: { reason: string }): void => {
      // Trust-boundary narrow: `reason` is a wire-foreign string from
      // Hocuspocus. Inlined (not imported from the server's runtime
      // helper) because a runtime import pulls the entire server bundle
      // into the browser via tree-shake leaks (rolldown traces into
      // `@parcel/watcher`'s `.node` binary). The bidirectional drift
      // guard catches additions on either side: `satisfies` ensures
      // every local literal is in the server-side type; the
      // `_AssertCovers` extends-check fails when the server-side type
      // widens past the local set (the conditional resolves to `never`
      // and the `true` initializer fails to compile).
      //
      // Wire format: `<kind>` for kinds that carry no payload, or
      // `<kind>:<payload>` for kinds that do. We split on the FIRST colon
      // so payloads that themselves contain `:` (docNames are not
      // byte-restricted) round-trip intact. Mirror of
      // `parseAuthRejectionWire` in `auth-token-schema.ts` — kept inline
      // for the same bundling reason as KNOWN.
      const KNOWN = [
        'server-instance-mismatch',
        'branch-mismatch',
        'rename-redirect',
        'doc-deleted',
        'doc-lineage-mismatch',
      ] as const satisfies readonly HocuspocusAuthRejectionReason[];
      type _AssertCovers = HocuspocusAuthRejectionReason extends (typeof KNOWN)[number]
        ? true
        : never;
      const _assertCovers: _AssertCovers = true;
      void _assertCovers;
      const colonIdx = reason.indexOf(':');
      const candidateKind = colonIdx === -1 ? reason : reason.slice(0, colonIdx);
      if (!(KNOWN as readonly string[]).includes(candidateKind)) {
        console.warn(JSON.stringify({ event: 'ok-auth-failed-unknown-reason', reason }));
        return;
      }
      const rawPayload = colonIdx === -1 ? '' : reason.slice(colonIdx + 1);
      const payload: string | undefined = rawPayload.length > 0 ? rawPayload : undefined;
      const typed = candidateKind as HocuspocusAuthRejectionReason;
      if (typed === 'server-instance-mismatch') {
        // `expectedServerInstanceId` is the claim this provider sent at
        // construction time. Idempotence: the first authenticationFailed
        // for this epoch transition clears `cachedServerInstanceId`;
        // every later sibling event observes `cached !== expected` and
        // short-circuits so the recycle path runs exactly once.
        if (expectedServerInstanceId === null) {
          return;
        }
        if (this.cachedServerInstanceId !== expectedServerInstanceId) {
          return;
        }
        const staleClaimFromToken = expectedServerInstanceId;
        this.cachedServerInstanceId = null;
        this.handleServerInstanceMismatch(staleClaimFromToken);
        return;
      }
      // Branch-mismatch is the late-join backstop for the cross-branch
      // invalidation flow: the client's auth-token claim
      // (`expectedBranch = lastObservedBranch`) didn't match the server's
      // current branch, which means a `branch-switched` broadcast happened
      // while this client was offline (or the tab was restored from
      // stale-branch IDB). Routing through the same recycle pathway as
      // CC1 `branch-switched` ensures `clearData` runs BEFORE Yjs sync
      // can union-merge stale-branch state. The handler is set by
      // DocumentContext after construction so the pool stays free of
      // React/UI dependencies; missing handler = legacy behavior (no
      // invalidation, accept current state).
      if (typed === 'branch-mismatch') {
        this.onBranchMismatch?.();
        return;
      }
      if (typed === 'rename-redirect') {
        // Defensive against malformed wire data: bail without dispatching
        // cleanup so the tab stays put and the provider's reconnect loop
        // can surface a structured warn the next cycle. The server-side
        // populator always supplies a non-empty payload for this kind, so
        // an empty payload here means the wire encoding diverged.
        if (payload === undefined || payload.length === 0) {
          console.warn(
            JSON.stringify({
              event: 'rename-redirect-missing-payload',
              fromDocName: docName,
            }),
          );
          return;
        }
        const fromDocName = docName;
        const toDocName = payload;
        // The lineage living at this name is gone — prune its record so the
        // map/envelope don't accumulate dead entries and a doc later created
        // at this name doesn't pay a guaranteed spurious lineage-rejection
        // round-trip for claiming the dead epoch.
        this.deleteLineageEpochRecord(fromDocName);
        const existing = this.entries.get(fromDocName);
        const hadOpenProvider = existing !== undefined && existing.kind === 'active';
        this.onRenameRedirect?.({
          fromDocName,
          toDocName,
          hadOpenProvider,
        });
        return;
      }
      if (typed === 'doc-deleted') {
        // Same dead-record pruning rationale as the rename-redirect arm.
        this.deleteLineageEpochRecord(docName);
        const existing = this.entries.get(docName);
        const hadOpenProvider = existing !== undefined && existing.kind === 'active';
        this.onDocDeleted?.({ docName, hadOpenProvider });
        return;
      }
      if (typed === 'doc-lineage-mismatch') {
        // The claimed lineage epoch is dead: the server unloaded + re-seeded
        // this doc (watcher delete, rename/delete spine, test-reset), so the
        // IDB rows persisted under the claimed epoch would union-merge as a
        // second materialization if the entry ever synced. Recovery at
        // per-doc granularity via the rename-flow ordering (close → clear →
        // deferred attach through `pendingClears`): drop the record so the
        // reopened provider claims nothing (structurally closes the
        // rejection loop), clear the stale IDB, reopen. No replay buffering
        // — deltas extending a dead lineage ARE the corruption vector; same
        // policy as the no-baseline drop in handleServerInstanceMismatch.
        if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
        this.deleteLineageEpochRecord(docName);
        // No `liveEpoch` here: the server rejects BEFORE sync, so the local
        // doc's lifecycle map holds at best the stale hydrated value — only
        // the deferred-attach arm can pair the stale claim with the live one.
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-doc-lineage-mismatch',
          ...this.recoveryTelemetryBase(docName),
          via: 'auth-rejection',
          staleEpoch: entry.lineageEpochRecordAtOpen ?? '',
        });
        const wasActive = this.activeDocName === docName;
        // Synchronously registers `pendingClears` + closes the entry, so the
        // open() below defers its persistence attach past the clear.
        void this.runCloseAndClearPersistence(docName);
        const reopened = this.open(docName);
        if (reopened !== null && wasActive) this.setActive(docName);
        return;
      }
      // Compile-time exhaustiveness — narrowed to `never` here. A new
      // member of HOCUSPOCUS_AUTH_REJECTION_REASONS without a
      // corresponding switch arm fails the build.
      const _never: never = typed;
      void _never;
    };

    // Server-driven doc-level close (MessageType.CLOSE on the wire) does
    // NOT tear down the multiplex WebSocket transport — `Connection.close`
    // in `@hocuspocus/server` sends an application-level `CloseMessage`
    // frame, removes the connection from `Document.connections`, and
    // clears the per-doc `documentConnections[docName]` entry. The OK
    // client's `'disconnect'` handler only fires on WS-transport close,
    // not on this doc-level close. Without intervention, the active tab's
    // `isAuthenticated` flips false, `forceSync` keeps sending
    // `SyncStepOne` frames, and the server queues them indefinitely in
    // `incomingMessageQueue[docName]` waiting for an `AuthenticationMessage`
    // that never comes — the active-tab remap stalls. Calling
    // `provider.sendToken()` re-emits the auth message, which routes
    // through `onAuthenticate` server-side and fires `removalRedirectGuard`
    // when applicable, producing the `'authenticationFailed'` reason the
    // arms above already handle. For a non-removal close (transient
    // server bug, false-positive frame), the re-auth succeeds (file
    // exists, cache miss) and the doc resumes — safe in both directions.
    const onServerDrivenClose = ({ event }: { event?: { code?: number; reason?: string } }) => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      if (entry.serverDrivenCloseReauthInFlight) return;
      entry.serverDrivenCloseReauthInFlight = true;
      // Fire-and-forget. `sendToken` is async (the token resolver may be
      // a function), but failures that surface as a permission denial route
      // through `permissionDeniedHandler` and emit `'authenticationFailed'`
      // — the arms above own that structured recovery. Failures that DON'T
      // produce a permission frame (transport already closed, token resolver
      // throws synchronously, network unreachable) would otherwise vanish;
      // the structured warn keeps them queryable so an operator debugging
      // "active tab never remaps after rename" has a trail. Reset the
      // in-flight flag in `.finally` so a subsequent server-driven close
      // (rare but possible when the same docName is renamed twice in
      // succession) gets a fresh re-auth attempt rather than being silently
      // dropped.
      provider
        .sendToken()
        .catch((err: unknown) => {
          console.warn(
            JSON.stringify({
              event: 'ok-provider-server-driven-close-reauth-failed',
              docName,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        })
        .finally(() => {
          if (entry.kind === 'active' && this.entries.get(docName) === entry) {
            entry.serverDrivenCloseReauthInFlight = false;
          }
        });
      const reason = event?.reason ?? '<unknown>';
      console.info(
        JSON.stringify({
          event: 'ok-provider-server-driven-close-reauth',
          docName,
          reason,
        }),
      );
    };

    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('disconnect', onDisconnect);
    provider.on('authenticationFailed', onAuthenticationFailed);
    provider.on('close', onServerDrivenClose);

    // Buffer-replay wiring: if this docName has a pending buffered update
    // from a prior authenticationFailed recycle, apply it to the fresh
    // Y.Doc on the first `synced` event. The listener self-detaches after
    // firing once; if no buffered update exists for this docName, this is
    // a no-op path. Origin `TAB_REPLAY_ORIGIN` lets observers distinguish
    // replay writes from user edits / server sync deliveries.
    const buffered = this.bufferedUpdates.get(docName);
    if (buffered !== undefined) {
      const staleClaimAtReplayInstall = this.recoveryMismatchStaleClaim;
      const replayOnce = (): void => {
        provider.off('synced', replayOnce);
        if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
        const current = this.bufferedUpdates.get(docName);
        if (current === undefined) return;
        // Drop the buffer reference up-front: a malformed update that
        // throws would throw again on retry, and the server's sync has
        // already delivered the canonical state. Catch the throw so it
        // doesn't escape into Hocuspocus's event emitter as an unhandled
        // rejection and so the next sync can proceed.
        this.bufferedUpdates.delete(docName);
        try {
          Y.applyUpdate(provider.document, current, TAB_REPLAY_ORIGIN);
        } catch (err: unknown) {
          const errorName = err instanceof Error ? err.name : 'non-error-throw';
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-buffer-replay-failed',
            ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
            replayByteLength: current.byteLength,
            errorName,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      };
      provider.on('synced', replayOnce);
    }

    this._entries.set(docName, entry);
    this.touch(docName);
    this.notify();

    // Record-absent admission (case (4) above): validate the stored rows'
    // in-band lineage before they may hydrate. Skipped while a clear is in
    // flight — the `pendingClears` scheduler below owns that attach and
    // routes through the same spine once the clear settles.
    if (
      persistence === null &&
      persistenceServerInstanceId !== null &&
      persistenceServerInstanceId.length > 0 &&
      pendingClearForDocName === undefined
    ) {
      void this.validateStoredStateThenAttach(entry, persistenceServerInstanceId);
    }

    // Deferred persistence attach when this `open()` raced with an
    // in-flight `closeAndClearPersistence(docName)`. Attaching now would
    // create a competing IDB connection that blocks `deleteDatabase`
    // from succeeding (per the comment on the `pendingClears` field).
    // Wait for the clear to settle:
    //   - resolve: IDB is clean → build a fresh persistence against the
    //     clean DB. Subsequent updates persist normally; warm reload
    //     hydrates from this fresh cache.
    //   - reject: the clear failed (typically a cross-tab blocker that
    //     held the DB open past the timeout, or a real IDB error). The
    //     stale DB rows would re-hydrate the new Y.Doc — so skip attach
    //     entirely. The entry runs IDB-cacheless for the rest of this
    //     session; the next cold load (page reload) sees no in-flight
    //     clear and re-triggers the auth-rejection clear flow against a
    //     hopefully-unblocked DB.
    if (
      pendingClearForDocName !== undefined &&
      persistenceServerInstanceId !== null &&
      persistenceServerInstanceId.length > 0
    ) {
      const stableServerInstanceId = persistenceServerInstanceId;
      void pendingClearForDocName.then(
        () => {
          this.attachDeferredPersistenceForEntry(entry, stableServerInstanceId);
        },
        (err: unknown) => {
          console.warn(
            JSON.stringify({
              event: 'ok-pool-deferred-persistence-attach-skipped',
              docName,
              reason: 'pending-clear-failed',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        },
      );
    }

    // Emit `ok.provider-pool.open` as a child of the `ok.cold-mount` root
    // for this cycle. Lazily creates the root if absent — typical because
    // pool.open() is the first cold-mount work, so the root span begins
    // here. mountId is looked up against the activity pool's registry;
    // when absent (e.g., pool.open from a code path that skipped the
    // activity-pool promotion) the span is skipped to avoid an unparented
    // root.
    const openMountId = getMountId(docName);
    if (openMountId !== undefined) {
      emitColdMountChild(
        openMountId,
        'ok.provider-pool.open',
        { 'doc.name': docName },
        openStartMs,
        Date.now(),
      );
    }

    return entry;
  }

  /**
   * Attach persistence to an entry that opened during an in-flight
   * `closeAndClearPersistence(docName)`. Called from the
   * `pendingClears.get(docName).then(...)` epilogue in `open()` —
   * guarded against the entry being torn down or replaced before the
   * clear settled. Skips silently if the entry no longer holds the
   * deferred-attach slot (kind flipped, replaced by a recycle, or
   * already attached by a parallel code path). Routes through the
   * stored-state validation spine for uniformity: a successful clear
   * leaves an empty store, so the peek's null fast path makes this
   * equivalent to the direct attach it replaces.
   */
  private attachDeferredPersistenceForEntry(
    entry: ActivePoolEntry,
    serverInstanceId: string,
  ): void {
    const current = this._entries.get(entry.docName);
    if (current !== entry || current.kind !== 'active' || current.persistence !== null) {
      return;
    }
    void this.validateStoredStateThenAttach(current, serverInstanceId);
  }

  /**
   * Top of the `server-instance-mismatch` recycle flow. Split out of the
   * event handler so the three steps — buffer, clearData, recycle — are
   * sequenced with explicit awaits. Fire-and-forget at the call site: the
   * returned promise is owned here; errors are logged structurally and
   * never rethrown into Hocuspocus's event emitter.
   */
  private handleServerInstanceMismatch(staleClaimedServerInstanceId: string): void {
    this.recoveryMismatchStaleClaim =
      staleClaimedServerInstanceId.length > 0 ? staleClaimedServerInstanceId : undefined;

    // Snapshot entries BEFORE any async work — subsequent recycle mutates
    // the map via destroyEntry → delete → re-open.
    const snapshot = Array.from(this.entries.entries());
    const startedAt = Date.now();
    const recoveryActiveDocName = this.activeDocName;
    // Recovery UI (spinner + failure panel) only tracks the foreground doc.
    // Background pool entries still recycle and clear IDB on mismatch; if
    // clearData fails there, the provider stays inert until a later reconnect
    // retries — no separate banner per background tab by design.
    const activeRecoveryDocNames =
      recoveryActiveDocName !== null &&
      snapshot.some(
        ([docName, poolEntry]) => docName === recoveryActiveDocName && poolEntry.kind === 'active',
      )
        ? [recoveryActiveDocName]
        : [];

    const telemetryDocName =
      recoveryActiveDocName ??
      snapshot.find(([, poolEntry]) => poolEntry.kind === 'active')?.[0] ??
      '';
    if (telemetryDocName.length > 0) {
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-client-cache-epoch-mismatch',
        ...this.recoveryTelemetryBase(telemetryDocName),
      });
    }

    this.beginServerRestartRecovery(activeRecoveryDocNames, startedAt);
    for (const [docName, poolEntry] of snapshot) {
      if (poolEntry.kind === 'active' && !activeRecoveryDocNames.includes(docName)) {
        invalidateSyncPromise(docName);
      }
    }

    for (const [docName, poolEntry] of snapshot) {
      if (poolEntry.kind !== 'active') continue;
      // Baseline-selection: prefer `lastDiskAckedSV` (server has durably
      // persisted) when present — the markdown rebuild on restart will
      // already include those updates, so the recycle buffer doesn't need
      // to replay them. Falls back to `lastServerSyncedSV` for the
      // cold-connect window where no disk-ack has arrived yet
      // (preserving today's "in-memory ack is the best we have" behavior).
      // No baseline at all → drop unsynced state. Any Y.Doc state at this
      // point came from IDB hydration of a prior session whose server is,
      // by definition, a different instance — preserving it would
      // duplicate content. The 50–500 ms cold-connect-then-immediate-
      // mismatch window can lose keystrokes; accepted trade-off.
      const baseline = poolEntry.lastDiskAckedSV ?? poolEntry.lastServerSyncedSV;
      if (baseline === null) {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-skipped-no-baseline',
          ...this.recoveryTelemetryBase(docName),
          reason: 'no-disk-ack-or-server-sync-vector',
        });
        continue;
      }
      const unsynced = computeUnsyncedUpdate(poolEntry.provider.document, baseline);
      if (unsynced.byteLength > MAX_BUFFER_BYTES) {
        // Drop the buffer for this doc; the post-recycle replay would
        // otherwise pin tens of MB on the pool while waiting for sync.
        // Loud-fail so the resulting "unsynced edits lost" outcome is
        // visible — silent-drop would mask the same data-loss class
        // buffer-and-replay exists to prevent.
        mark('ok/pool/buffer-overflow', { docName, bytes: unsynced.byteLength });
        continue;
      }
      if (unsynced.byteLength > 0) {
        this.bufferedUpdates.set(docName, unsynced);
      }
    }

    // Gate per-doc on clearData success. A `clearData` failure (blocked
    // by another tab/DevTools, quota exhaustion, transaction-aborted)
    // means the IDB still holds the pre-restart Y.Doc state — recycling
    // into the un-cleared DB would hydrate the fresh provider's Y.Doc
    // from stale data BEFORE Yjs sync runs, re-opening the content-
    // duplication bug class clearData exists to prevent. Use
    // `Promise.allSettled` so per-element rejections surface (the prior
    // `Promise.all + per-element catch` swallowed every failure, then
    // recycled unconditionally).
    const clears: { docName: string; promise: Promise<void> }[] = [];
    for (const [docName, poolEntry] of snapshot) {
      // TearingDown entries have null persistence by construction; Active
      // entries opened before the live server epoch was known also have
      // null persistence — the persistent IDB cache wasn't attached, so
      // there's nothing to clear. BridgeFailed entries (Active with
      // bridgeSetupFailed=true) still have persistence attached and
      // SHOULD be cleared.
      if (poolEntry.kind !== 'active') continue;
      if (poolEntry.persistence === null) continue;
      clears.push({
        docName,
        promise: this.withClearDataTimeout(docName, poolEntry.persistence.clearData()),
      });
    }

    const inflight: Promise<void> = Promise.allSettled(clears.map((c) => c.promise))
      .then((results) => {
        const failed: string[] = [];
        const cleared: string[] = [];
        let sawClearTimeout = false;
        results.forEach((result, i) => {
          const row = clears[i];
          if (!row) return;
          const docName = row.docName;
          if (result.status === 'rejected') {
            failed.push(docName);
            const isClearTimeout = result.reason instanceof ClientPersistenceClearTimeoutError;
            if (isClearTimeout) {
              sawClearTimeout = true;
            }
            if (isClearTimeout) {
              this.emitStructuredClientRecoveryEvent({
                event: 'ok-client-cache-clear-failed',
                ...this.recoveryTelemetryBase(docName),
                failureKind: 'timeout',
              });
            } else {
              const errorName = result.reason instanceof Error ? result.reason.name : 'unknown';
              this.emitStructuredClientRecoveryEvent({
                event: 'ok-client-cache-clear-failed',
                ...this.recoveryTelemetryBase(docName),
                failureKind: 'rejected',
                errorName,
                errorMessage:
                  result.reason instanceof Error ? result.reason.message : String(result.reason),
              });
            }
          } else {
            cleared.push(docName);
          }
        });
        const reconnectDocNames = cleared.filter((docName) => docName === recoveryActiveDocName);
        if (failed.length > 0) {
          const failureReason: 'clear-data-failed' | 'clear-data-timeout' = sawClearTimeout
            ? 'clear-data-timeout'
            : 'clear-data-failed';
          // Per-doc recycle. An all-or-none gate would re-open the
          // duplication class for the cleared docs: their providers would
          // reconnect after the stale claim has been cleared, then Yjs sync
          // would run against the still-pre-restart Y.Doc and additively
          // merge with post-restart server state — exactly the bug class clearData was
          // supposed to prevent. Recycle the cleared entries (their IDB
          // is empty, their fresh providers will sync cleanly) and leave
          // the failed entries inert. The failed entries' un-cleared
          // IDBs will surface the same mismatch on the next provider
          // reconnect cycle; they need user-visible recovery (close the
          // blocking tab/DevTools, then reload).
          console.warn(
            JSON.stringify({
              event: 'ok-mismatch-recycle-partial-clears-failed',
              failedDocs: failed,
              clearedDocs: cleared,
            }),
          );
          this.enterServerRestartReconnect(reconnectDocNames, failed, startedAt, failureReason);
          for (const docName of cleared) {
            this.recycleDisconnectedEntry(docName);
          }
          return;
        }
        // `failureReason` is only read when `failedDocNames` is non-empty; this branch is all clears OK.
        this.enterServerRestartReconnect(reconnectDocNames, [], startedAt, 'clear-data-failed');
        this.recycleAllEntries();
      })
      .finally(() => {
        if (this.mismatchInFlight === inflight) {
          this.mismatchInFlight = null;
        }
      });
    this.mismatchInFlight = inflight;
  }

  /**
   * Resolve when the current `server-instance-mismatch` recycle (clearData +
   * `recycleAllEntries`) has settled. Resolves immediately when no recycle is
   * in flight. Used by tests to wait deterministically; production code
   * fire-and-forgets.
   */
  awaitMismatchSettled(): Promise<void> {
    return this.mismatchInFlight ?? Promise.resolve();
  }

  /**
   * Recycle every pool entry by calling `recycleDisconnectedEntry` for each.
   * Called by the `authenticationFailed` handler on `server-instance-mismatch`
   * (every provider in the pool is bound to a Y.Doc that merged items under
   * the old server's clientID, so all of them must restart from a fresh
   * Y.Doc before Yjs sync runs) and by `branch-invalidation.ts` on CC1
   * `branch-switched` (every provider's Y.Doc reflects a stale branch's
   * content).
   *
   * Snapshot the keys first so mutations in `recycleDisconnectedEntry` (which
   * deletes + re-opens the active doc) don't disturb the iteration.
   */
  recycleAllEntries(): void {
    const docNames = Array.from(this.entries.keys());
    for (const docName of docNames) {
      this.recycleDisconnectedEntry(docName);
    }
  }

  /**
   * Pre-warm a provider on sidebar hover.
   *
   * Opens a HocuspocusProvider for `docName` WITHOUT promoting it in the
   * LRU order — the returned entry sits at LRU-oldest, evictable by any
   * subsequent user-initiated `open()`. Rate-limiting and concurrency
   * caps are the caller's responsibility (FileSidebar uses an 80 ms
   * intent debounce + a 3-concurrent cap).
   *
   * Idempotent: if the doc is already in the pool (any state), returns
   * the existing entry without modification. The existing entry's LRU
   * position is unchanged by prewarm — calls to `touch()` only happen on
   * user-initiated `open()` / `setActive()`.
   *
   * Returns null for system docs. The pool does not evict an Activity-
   * mounted doc on prewarm admission — evictLru() always skips the
   * active doc. When the pool is at capacity, prewarm's cold-path
   * returns the newly-constructed entry even though it sits at the
   * oldest position and will be the first to be evicted.
   */
  prewarm(docName: string): PoolEntry | null {
    if (isSystemDoc(docName)) return null;
    const existing = this.entries.get(docName);
    if (existing) {
      // Already warm — return without touching LRU.
      return existing;
    }
    // Cold path: use `open()` to construct the provider but DO NOT touch
    // LRU or active. `open()` internally calls `touch(docName)` which
    // bumps LRU to most-recent — we need to counter-act so prewarms are
    // at the oldest slot. The simplest approach: let `open()` run its
    // full init, then move the docName to LRU-oldest immediately.
    const entry = this.open(docName);
    if (!entry) return null;
    // Demote to LRU-oldest — prewarms should never evict user-initiated docs.
    const idx = this.lruOrder.indexOf(docName);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
      this.lruOrder.unshift(docName);
    }
    return entry;
  }

  /** Close a specific document — disconnect and clean up. */
  close(docName: string): void {
    const entry = this.entries.get(docName);
    if (!entry) return;

    this.destroyEntry(entry);
    this._entries.delete(docName);
    this.lruOrder = this.lruOrder.filter((n) => n !== docName);
    // Explicit close discards any pending replay buffer — the user closed
    // the tab; resurrecting unsynced edits later would surprise them.
    this.bufferedUpdates.delete(docName);

    if (this.activeDocName === docName) {
      this.activeDocName = null;
    }
    this.notify();
  }

  /**
   * Delete the IndexedDB for `docName` and close any open pool entry.
   * Used by rename flows so a future open at this name (e.g., the user
   * moves a doc back to a folder it once occupied) starts from a clean
   * persistence — without this, the IDB rows from the prior session at
   * the same name would hydrate the new Y.Doc with foreign-clientID items
   * before sync runs, and merging those items with the server's freshly-
   * loaded Y.Doc (no shared ancestor) appends rather than reconciles,
   * producing visible content duplication.
   *
   * Three cases:
   *   1. In pool with attached persistence — `clearData()` via the live
   *      instance (which also closes the IDB connection), then close the
   *      entry.
   *   2. In pool without persistence (deferred attach hasn't fired) —
   *      close only; there is no IDB yet.
   *   3. Not in pool — construct the canonical IDB name from the cached
   *      branch + serverInstanceId and `deleteDatabase` directly. No-op
   *      when either is unknown (no IDB could exist for that scope).
   *
   * Best-effort: failures warn but do not throw. Awaiting the returned
   * promise guarantees the IDB is gone before the caller proceeds.
   */
  async closeAndClearPersistence(docName: string): Promise<void> {
    // Public API: always resolves, even if the underlying clear failed.
    // FileTree's bulk-rename + EditorTabs cleanup batch many calls via
    // `Promise.all(...)`; propagating a per-docName clear failure would
    // abort the batch and leave partial-rename state in the React tree.
    // The pendingClears tracking exposes the internal status to the
    // deferred-attach scheduler (open()) — that's the consumer that
    // cares whether the clear actually succeeded.
    try {
      await this.runCloseAndClearPersistence(docName);
    } catch {
      // Already logged inside the runner. Swallow at the public boundary.
    }
  }

  /**
   * Internal entry point that registers/dedupes in-flight work in
   * `pendingClears` so a concurrent `pool.open(docName)` can defer its
   * persistence attach. Returns the in-flight promise (rejected on
   * failure) — the public `closeAndClearPersistence` swallows; the
   * deferred-attach scheduler in `open()` subscribes directly to
   * observe success-vs-failure.
   */
  private runCloseAndClearPersistence(docName: string): Promise<void> {
    const inFlight = this.pendingClears.get(docName);
    if (inFlight !== undefined) {
      // Concurrent callers share the same in-flight work — preserves
      // the idempotent semantics existing callers (FileTree, EditorTabs)
      // already rely on when batching close-and-clears for renames.
      return inFlight;
    }
    // Register the pendingClear via a deferred promise BEFORE invoking
    // the executor, so any synchronous re-entry into pool.open(docName)
    // that the executor's evict-listener fan-out triggers observes the
    // map entry. The executor's body runs synchronously up to its first
    // `await` — `this.close(docName)` (which fires evict listeners) sits
    // in that synchronous window. Today's evict subscribers don't
    // re-enter pool.open, but the structural invariant the deferred-
    // attach scheduler depends on ("pendingClears is populated before
    // any code that could re-enter pool.open runs") only holds if the
    // map entry pre-exists every executor side effect. A future evict
    // subscriber that re-enters would otherwise silently observe an
    // empty pendingClears and construct a competing IDB connection.
    let resolveWork: () => void = () => {};
    let rejectWork: (err: unknown) => void = () => {};
    const work = new Promise<void>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    this.pendingClears.set(docName, work);
    const finalize = () => {
      if (this.pendingClears.get(docName) === work) {
        this.pendingClears.delete(docName);
      }
    };
    void work.then(finalize, finalize);
    this.executeCloseAndClearPersistence(docName).then(resolveWork, rejectWork);
    return work;
  }

  private async executeCloseAndClearPersistence(docName: string): Promise<void> {
    // Drop any prior-attempt failure flag at the start of every clear
    // attempt. Either we run to completion (no throw → flag stays dropped,
    // future opens proceed normally) or we hit a catch arm below and
    // re-add the flag before re-throwing. Symmetric with the public
    // wrapper's swallow contract: the failure-survives-across-finalize
    // signal lives in `clearFailures`, not in the rejected Promise.
    this.clearFailures.delete(docName);
    const entry = this.entries.get(docName);
    if (entry?.kind === 'active' && entry.persistence !== null) {
      // Close BEFORE awaiting clearData. Close fires eviction listeners
      // (including the V2 editor cache's cleanup) and removes the entry
      // from `this.entries` synchronously. The IDB-delete still runs on
      // the captured persistence reference: `destroyEntry` synchronously
      // initiates persistence teardown (Y.Doc observer removal is sync;
      // IDB connection close completes async after pending transactions
      // drain), and `clearData()` on the already-destroyed instance
      // proceeds to `indexedDB.deleteDatabase()`. Concurrent
      // `pool.open(docName)` racing this code path is handled at the
      // `open()` site via the `pendingClears` deferred-attach scheduler.
      //
      // `this.close(docName)` is wrapped in try/catch because the reorder
      // creates an implicit "must never throw" contract on destroyEntry's
      // synchronous arms. A throw there would skip
      // `await persistence.clearData()` and leak stale IDB rows for docName.
      const persistence = entry.persistence;
      try {
        this.close(docName);
      } catch (err) {
        console.warn(`[ProviderPool] close before clearData threw for ${docName}:`, err);
      }
      try {
        // Wrap with timeout so a cross-tab IDB blocker that never closes
        // can't pin the pendingClear entry (and the deferred-attach
        // gate) forever. Same primitive used by the mismatch-recycle
        // path; same CLEAR_DATA_TIMEOUT_MS budget. Same-context blockers
        // (pending IDB transactions on the just-`db.close()`-marked
        // connection) typically drain in <100ms — well within the
        // timeout, and the natural drain + `onsuccess` is exactly the
        // behavior client-persistence.ts now waits for instead of
        // pre-terminating on `onblocked`.
        await this.withClearDataTimeout(docName, persistence.clearData());
      } catch (err) {
        console.warn(`[ProviderPool] clearData on rename failed for ${docName}:`, err);
        this.clearFailures.add(docName);
        throw err;
      }
      return;
    }
    if (entry) {
      // Symmetric with the active+persistence branch above: the IDB-by-name
      // delete below must not be skipped because destroyEntry's synchronous
      // arms threw — a throw here would leak stale IDB rows for docName.
      try {
        this.close(docName);
      } catch (err) {
        console.warn(`[ProviderPool] close before IDB-by-name delete threw for ${docName}:`, err);
      }
    }

    // Branch normalization MUST mirror `buildPersistence`: when no branch
    // has been observed, persistence is created under
    // `UNKNOWN_BRANCH_SENTINEL`, so the by-name delete has to target the
    // sentinel-named DB too. Bailing on a null branch (the previous
    // behavior) silently left the sentinel-scoped DB alive — a stale
    // lineage's rows would survive the clear and re-hydrate on the next
    // attach. The instance id has no sentinel: unknown id ⇒ no IDB could
    // have been created for any scope, so there is nothing to delete.
    const branch = this.normalizedObservedBranch();
    const serverInstanceId = this.cachedServerInstanceId;
    if (serverInstanceId === null) return;

    const dbName = `ok-ydoc:${branch}:${serverInstanceId}:${docName}`;
    try {
      await this.withClearDataTimeout(
        docName,
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          // `onblocked` is observational: the deletion stays pending
          // and fires `onsuccess` once every blocking connection
          // closes. The wrapper timeout above bounds the wait so a
          // cross-tab blocker can't hang the cleanup forever.
          req.onblocked = () => {
            console.warn(`[ProviderPool] IDB delete blocked for ${dbName}`);
          };
        }),
      );
    } catch (err) {
      console.warn(`[ProviderPool] IDB delete on rename failed for ${dbName}:`, err);
      this.clearFailures.add(docName);
      throw err;
    }
  }

  /**
   * Drop every entry's pending replay buffer. Called by the
   * `branch-switched` invalidation flow (`branch-invalidation.ts`) so that
   * cross-branch policy ("edits authored against branch A are NOT valid
   * against branch B") applies to the in-memory buffer slot — not just the
   * IDB layer. Without this, a non-active doc's buffer populated by a
   * prior `server-instance-mismatch` would replay onto the post-switch
   * branch B Y.Doc the next time the user opened that doc.
   */
  clearBufferedUpdates(): void {
    this.bufferedUpdates.clear();
  }

  /**
   * Test-only buffer manipulation. The cross-branch buffer-leak fix is
   * load-bearing but invisible from public APIs (the buffer is a private
   * Map populated only by `handleServerInstanceMismatch` mid-recycle).
   * Tests need a way to seed the buffer + observe its size to assert
   * branch-switched / close drain semantics. Naming-prefix `__test`
   * keeps these out of production call sites by convention.
   */
  __test_seedBufferedUpdate(docName: string, update: Uint8Array): void {
    this.bufferedUpdates.set(docName, update);
  }
  __test_bufferedUpdatesSize(): number {
    return this.bufferedUpdates.size;
  }
  __test_hasBufferedUpdate(docName: string): boolean {
    return this.bufferedUpdates.has(docName);
  }
  __test_getBufferedUpdate(docName: string): Uint8Array | undefined {
    return this.bufferedUpdates.get(docName);
  }

  /** Set the active document. Must already be open. */
  setActive(docName: string): void {
    const entry = this.entries.get(docName);
    if (!entry) {
      throw new Error(`[ProviderPool] Cannot setActive — "${docName}" is not open`);
    }
    entry.lastAccessedAt = Date.now();
    this.touch(docName);
    this.activeDocName = docName;
    this.notify();
  }

  /** Clear the active document without closing any open providers. */
  clearActive(): void {
    if (this.activeDocName === null) return;
    this.activeDocName = null;
    this.notify();
  }

  /** Get the active pool entry, or null if nothing is active. */
  getActive(): PoolEntry | null {
    if (!this.activeDocName) return null;
    return this.entries.get(this.activeDocName) ?? null;
  }

  /** Get the active document name. */
  getActiveDocName(): string | null {
    return this.activeDocName;
  }

  /** Check if a document is open in the pool. */
  has(docName: string): boolean {
    return this.entries.has(docName);
  }

  /**
   * Inspect a pool entry without affecting MRU ordering or emitting
   * marks. Read-only view for callers that need to read e.g.
   * `poolEventId` (mountId adoption invariant) before deciding whether
   * to call `open()`. Returns `null` for system docs and for docs not
   * in the pool.
   */
  peek(docName: string): PoolEntry | null {
    return this.entries.get(docName) ?? null;
  }

  /**
   * Destroy and recreate the entry for `docName`, preserving `activeDocName`
   * across the swap. Used by the "Try again" retry path in
   * `DocumentErrorBoundary` to recover from `BridgeSetupError` (or any sync
   * failure that leaves the provider in a known-broken state). Differs from
   * `close + open` in that it does NOT intermediately null `activeDocName`,
   * so `EditorArea` does not flash the "Select a document" empty state
   * during the swap.
   *
   * No-op if the doc is not in the pool.
   */
  recycle(docName: string): void {
    this.recycleDisconnectedEntry(docName);
  }

  /** Dispose of all entries and pool-owned mutable state. */
  dispose(): void {
    for (const entry of this._entries.values()) {
      this.destroyEntry(entry);
    }
    this._entries.clear();
    this.lruOrder = [];
    this.activeDocName = null;
    this.onChange = null;
    // Reset every mutable field so a disposed pool can't bleed stale state
    // into a future test or reused harness instance. Production HMR drops
    // the whole pool reference, but tests and the `[collabUrl]` cleanup in
    // DocumentContext call dispose() and may keep the reference around.
    this.bufferedUpdates.clear();
    // Drop any in-flight `closeAndClearPersistence` tracking. The async
    // work continues to run (its scheduling is unchanged), but anyone
    // who was awaiting `open()`'s deferred-attach via `pendingClears`
    // is now disposed alongside the pool — the .then handler's
    // `_entries.get(docName) !== entry` guard short-circuits cleanly.
    this.pendingClears.clear();
    // Disposal ends this pool instance's responsibility for the retry —
    // the next pool to handle this docName (HMR remount, fresh test
    // harness) starts from a clean slate. Leaving the flag set would
    // cause the next pool to retry a clear we've already abandoned.
    this.clearFailures.clear();
    // In-memory lineage records die with the pool; the storage envelope
    // deliberately survives — a fresh pool (new tab, HMR remount) re-reads
    // and instance-validates it, which is the cross-tab channel the
    // doc-lineage fence's fresh-pool door depends on.
    this.docLineageEpochs.clear();
    this.docLineageEpochsEnvelopeConsumed = false;
    this.onBranchMismatch = null;
    this.branchMismatchInFlight = null;
    this.onRenameRedirect = null;
    this.onDocDeleted = null;
    this.evictListeners.clear();
    this.serverRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
    this.cachedServerInstanceId = null;
    // Drop any pending whenServerInstanceKnown handle. Awaiters of a
    // disposed pool stay pending — disposal happens during HMR / test
    // teardown when the entire pool reference is replaced, so leaving
    // the promise un-resolved is the correct behavior. Resolving with
    // a placeholder id would mislead callers into reading from a torn
    // pool.
    this.pendingServerInstanceKnown = null;
    this.tabIdentity = null;
    this.recoveryMismatchStaleClaim = undefined;
  }

  private evictLru(): void {
    // Find the LRU entry that is NOT the active doc
    for (const docName of this.lruOrder) {
      if (docName !== this.activeDocName) {
        mark('ok/pool/evict-lru', { docName });
        this.close(docName);
        return;
      }
    }
  }

  private destroyEntry(entry: PoolEntry): void {
    // Idempotent: a second destroyEntry call on a torn-down entry no-ops.
    if (entry.kind === 'tearing-down') return;

    // Capture variant-specific Active fields BEFORE the kind flip so we
    // can run the cleanup work after we've put the entry into a state
    // where event-handler closures will bail on `kind !== 'active'`.
    const observerCleanup = entry.observerCleanup;
    const observerFireCounterCleanup = entry.observerFireCounterCleanup;
    const persistence = entry.persistence;
    const pendingRecycleTimer = entry.pendingRecycleTimer;
    const docName = entry.docName;

    // Flip kind to 'tearing-down' atomically + null variant-specific
    // fields. The cast through `unknown` is unavoidable because TS's
    // discriminated unions don't model in-place kind mutations — both
    // sides of the union are structurally compatible at the JS level.
    const torn = entry as unknown as TearingDownPoolEntry;
    torn.kind = 'tearing-down';
    torn.persistence = null;
    torn.observerCleanup = null;
    torn.observerFireCounterCleanup = null;
    torn.pendingRecycleTimer = null;
    torn.serverDrivenCloseReauthInFlight = false;

    if (pendingRecycleTimer) clearTimeout(pendingRecycleTimer);

    // Detach the syncPromise cache entry BEFORE destroy() fires the provider's
    // `close` event — otherwise the sync-promise listener would reject the
    // already-consumed promise with PreSyncDisconnectError on pool-triggered
    // teardown. Natural (network-triggered) close events still reject as
    // expected because this path only runs inside pool destroy/recycle/evict.
    invalidateSyncPromise(docName);
    // Fire the eviction event so the editor cache (and any future
    // subscriber) can clean up entries bound to `provider.document` via
    // Collaboration.configure / y-codemirror.next BEFORE the provider is
    // destroyed. Without this ordering, cached `Editor`/`EditorView`
    // instances retain refs to an orphaned Y.Doc. The pool stays free
    // of editor-cache knowledge; the cache subscribes via
    // `pool.onEvict(...)` and runs whatever teardown it owns.
    this.fireEvict(docName);
    // Observer cleanup (observers reference Y.Doc state). Captured pre-flip
    // because the post-flip variant has `observerCleanup: null`. Wrapped in
    // try/catch matching fireEvict's pattern: a buggy observer cleanup must
    // not abort the rest of destroyEntry — in particular it must not stop
    // closeAndClearPersistence's downstream clearData() from running, which
    // would re-open the content-duplication bug class the close-before-await
    // reorder is designed to prevent.
    try {
      observerCleanup?.();
    } catch (err) {
      console.warn(`[ProviderPool] observer cleanup threw for ${docName}:`, err);
    }
    // Tear down DEV-only observer-fire counter for this docName before the
    // Y.Doc is destroyed. The Y.Doc.off call inside the cleanup must run
    // while the doc is alive; the counter entry is then deleted from the
    // exposed map so a fresh open() starts from a clean slate. Captured
    // pre-flip — same rationale as observerCleanup. Same try/catch discipline.
    try {
      observerFireCounterCleanup?.();
    } catch (err) {
      console.warn(`[ProviderPool] observer-fire-counter cleanup threw for ${docName}:`, err);
    }
    clearObserverFireCounter(docName);

    // Tear down client-side persistence BEFORE the provider. The synchronous
    // part of y-indexeddb's `destroy()` runs `doc.off('update', _storeUpdate)`
    // and `doc.off('destroy', this.destroy)` immediately, so by the time
    // `provider.destroy()` runs (which calls `document.destroy()` internally)
    // the persistence's listeners are gone — no recursive re-entry. The
    // returned promise only covers the IDB connection close, which is safe
    // to run asynchronously against a separate IDB handle. We intentionally
    // do not `await` here — keeping `destroyEntry` synchronous preserves all
    // call-site shapes.
    if (persistence !== null) {
      const pendingPersistenceDestroy = persistence.destroy();
      pendingPersistenceDestroy.catch((err) => {
        console.warn(`[ProviderPool] persistence destroy failed for ${docName}:`, err);
      });
    }

    try {
      torn.provider.destroy(); // destroy() disconnects + removes all listeners + awareness cleanup
    } catch (err) {
      console.warn(`[ProviderPool] Provider destroy failed for ${docName}:`, err);
    }
  }

  private recycleDisconnectedEntry(docName: string): void {
    const entry = this.entries.get(docName);
    if (!entry || entry.kind !== 'active') return;

    const wasActive = this.activeDocName === docName;
    mark('ok/pool/recycle-disconnected', { docName, wasActive });

    this.destroyEntry(entry);
    this._entries.delete(docName);
    this.lruOrder = this.lruOrder.filter((n) => n !== docName);

    if (wasActive) {
      // docName came from `this.entries.get(docName)` above — a system doc
      // cannot reach this branch because `open()` rejects system docs at
      // admission time.
      const reopened = this.open(docName);
      if (reopened) this.setActive(docName);
      return;
    }

    this.notify();
  }
}
