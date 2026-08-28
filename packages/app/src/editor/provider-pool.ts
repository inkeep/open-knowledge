import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  addsBlankLines,
  composeWithDerivedBody,
  LINEAGE_EPOCH_KEY,
  MarkdownManager,
  normalizeBridge,
  randomUUID,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { HocuspocusAuthRejectionReason } from '@inkeep/open-knowledge-server';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { buildAuthToken } from '../lib/auth-token';
import { readNumericOverride } from '../lib/perf/env-override';
import { mark } from '../lib/perf/mark';
import { emitColdMountChild } from '../lib/perf/otel-spans';
import { projectDigest, scopedStorageKey } from '../lib/storage-scope';
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
import {
  consumeReplayOutboxEntry,
  ReplayOutboxTimeoutError,
  readReplayOutboxEntry,
  writeReplayOutboxEntry,
} from './replay-outbox';
import { BridgeSetupError, invalidateSyncPromise, rejectSyncPromise } from './sync-promise';

/**
 * Opaque Y.Doc transaction origin applied when the pool replays a buffered
 * update onto a freshly-recycled provider. Lets tests and future observers
 * distinguish replay writes from user edits / server sync deliveries.
 */
export const TAB_REPLAY_ORIGIN = Object.freeze({ kind: 'tab-replay' } as const);

/**
 * One doc's captured pre-recycle unsynced edit. See the `bufferedUpdates`
 * field comment for what `delta`/`fullState` carry.
 */
interface BufferedReplayUpdate {
  readonly delta: Uint8Array;
  readonly fullState: Uint8Array | null;
  /**
   * The branch this buffer was captured under — one component of the outbox
   * key, alongside the project namespace and the docName. Deliberately not
   * stated as an ordinal: `outboxDbName` composes those into a name whose
   * project segment is absent for a null namespace, so the branch's position
   * there moves by host.
   *
   * Captured rather than re-read at use time because a discard CAN run after
   * a branch switch has already moved the observed branch — and
   * `discardBufferedUpdate` keys its detached consume off this field for that
   * reason. See its docblock for which discards those are, and for what the
   * captured branch does and does not protect.
   */
  readonly branch: string;
  /**
   * True once a durable outbox record for this buffer has committed. That
   * record is the cross-tab exactly-once token, so it also decides whether
   * the replay must claim before applying and whether a discard has to reach
   * IDB. Flipped by the write's resolution, so it stays false for over-cap
   * docs, failed writes, and engines with no durable outbox at all — those
   * buffers are RAM-only and behave exactly as they did before the outbox.
   */
  durable: boolean;
}

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
 * Ceiling on consecutive server-driven-close reauth attempts before the pool
 * stops re-authing and emits a one-shot escalation breadcrumb (a structured
 * `console.warn`, not a queryable state field).
 *
 * Division of labour, so this constant is not mistaken for the dead-server fix:
 * a genuine server-driven close (application-level `CloseMessage`) carries a
 * reason and normally means a rename/remove remap that a single `sendToken()`
 * resolves. The DEAD-server reconnect loop is filtered upstream by the
 * empty-reason guard in `onServerDrivenClose` (a dead server's raw WS drops carry
 * no reason), so it never reaches — let alone touches — this counter. Concurrent
 * closes are deduped by `serverDrivenCloseReauthInFlight`. This ceiling is the
 * remaining backstop for a REASONED close that repeats with no intervening
 * `synced` (e.g. a server bug resending 4205). The counter
 * (`serverDrivenCloseReauthAttempts`) resets to 0 on any successful `synced`, so
 * a genuine transient never trips it.
 */
const SERVER_DRIVEN_CLOSE_REAUTH_CEILING = 5;

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
 * persistence still attached. The only narrowing benefit of a separate
 * variant would be `observerCleanup === null`, which doesn't earn its
 * variant weight.
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
  /**
   * Count of consecutive reasoned server-driven-close reauth attempts since the
   * last successful `synced`; reset to 0 in the `synced` handler. Held at most
   * one PAST `SERVER_DRIVEN_CLOSE_REAUTH_CEILING` — the ceiling+1 value is the
   * one-shot sentinel meaning "escalation breadcrumb already emitted". See that
   * constant's docblock for what the bound protects against (and what it
   * deliberately does not).
   */
  serverDrivenCloseReauthAttempts: number;
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
  serverDrivenCloseReauthAttempts: 0;
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
 * How long to wait after a contentless provider disconnects before recycling
 * it (ms). During this window the provider's built-in exponential backoff
 * handles reconnection attempts. If it reconnects and syncs, the pending
 * recycle is cancelled. If the window expires with the contentless provider
 * still disconnected, a single recycle fires.
 *
 * 4s is long enough to ride out a server restart cycle (typically 1-3s) and
 * short enough that a provider which never materialized content does not sit
 * around indefinitely.
 * Validated by the Liveblocks `lostConnectionTimeout` pattern (default 5s).
 */
const RECYCLE_DEBOUNCE_MS = 4_000;
const CLEAR_DATA_TIMEOUT_MS = 10_000;

function hasMaterializedLocalContent(doc: Y.Doc): boolean {
  // Runs inside the disconnect handler, where a throw would escape as an
  // uncaught exception. A doc that cannot be read (e.g. the bridge-failed S4
  // state, whose recovery path deliberately breaks the doc) is not one worth
  // preserving — report no content so the recycle path stays available.
  try {
    return doc.getText('source').length > 0 || doc.getXmlFragment('default').length > 0;
  } catch {
    return false;
  }
}

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
 * gap). Scoped per project by `scopedStorageKey` — see that helper for why
 * one key per ORIGIN is not one key per project.
 */
const LAST_OBSERVED_BRANCH_KEY = 'ok-last-observed-branch';

/**
 * localStorage key for the persisted per-doc lineage-epoch records.
 * Scoped per project by `scopedStorageKey`, for the same reason the branch
 * key is: a sibling project's window shares this origin's localStorage, and
 * its write would clobber this project's envelope. A clobbered read still
 * fails safe via the validation below, but the fence it feeds goes silently
 * dead until the next learned epoch.
 * Single envelope per project:
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
 * backoff handles server-restart-on-same-port transparently, which is
 * the common case; contentless providers additionally get a debounced
 * recycle, and server-instance mismatch has its own explicit clear +
 * recycle path. Port-change-on-restart is rare
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
  /**
   * Documents rendered in visible editor panes. These entries must survive LRU
   * churn even when they are not the globally focused document: every visible
   * pane owns a live editor bound to its provider.
   *
   * The set deliberately stores names rather than PoolEntry references. A
   * recycle replaces an entry in place while the pane continues to own the
   * document, and the next `open()` must retain that protection.
   */
  private visibleDocNames = new Set<string>();
  private readonly maxSize: number;
  private readonly wsUrl: string;
  private readonly recycleDebounceMs: number;
  private readonly clearDataTimeoutMs: number;
  /**
   * Gates the background-flush / resync-on-visible mechanism. Wired from
   * the project `bridge.flushOnHide.enabled` kill-switch (default ON) via
   * `setFlushOnHideEnabled`; when off, `flushOnHide`/`resyncOnVisible` are
   * inert.
   */
  private flushOnHideEnabled = true;
  /**
   * Listeners notified whenever any provider's `unsyncedChanges` count moves.
   * Separate from `onChange` (a single lifecycle callback) so the desktop
   * background-throttle reporter can observe unsynced-work edges without
   * competing for the `onChange` slot the DocumentContext owns.
   */
  private readonly unsyncedWorkListeners = new Set<() => void>();
  private onChange: PoolChangeCallback | null = null;
  private tabIdentity: { principalId: string; tabSessionId: string } | null = null;
  private serverRestartRecoveryState: ServerRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
  /**
   * Live server instance ID observed from `/api/server-info` or CC1
   * `server-info`. Drives the auth-token claim and the
   * `serverInstanceId` segment of the IndexedDB DB name.
   *
   * An epoch transition clears it only while it still holds the epoch just
   * proven dead, so a fresher one observed on another channel survives to be
   * claimed by the entries the recycle re-opens. What follows the clear
   * depends on how the rotation was learned: the auth-rejection arm leaves
   * the field null until a later observation adopts an epoch through
   * `whenServerInstanceKnown()` + `attachDeferredPersistence`, while an
   * observation that already carries the new epoch adopts it inline and
   * leaves re-attachment to the recycle's own re-opens.
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
   * pending handle stays alive until a real epoch lands. That matters on the
   * auth-rejection arm, where the transition clears the epoch mid-recovery
   * and a later boot/refresh fetch races the new one back into place. An
   * observation that reports the rotation directly has no such window: it
   * resolves the handle inline, in the same call that starts the transition.
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
   * Dead epochs whose transition has already been routed through
   * `handleServerInstanceMismatch`.
   *
   * Dedupe keys on the stale claim VALUE rather than on
   * `cachedServerInstanceId` equality. That field is the live-epoch cache
   * (auth claim + IDB name) and has more than one legitimate writer, so
   * using it as the latch let an unrelated writer decide whether a
   * transition had run: an epoch observed over HTTP while per-doc providers
   * were still retrying a frozen stale claim used to suppress their recycle
   * entirely. The claim value is immutable per provider and cannot be
   * disturbed that way.
   *
   * Bounded by construction — a provider freezes exactly one claim at
   * admission, so the set holds at most one entry per pool slot within a
   * recycle window, and it is dropped when the recycle settles.
   */
  private readonly handledStaleClaims = new Set<string>();
  /**
   * Unsynced-edit buffer captured per-doc during a `server-instance-mismatch`
   * recycle. Populated right before `clearData()` wipes IDB; drained at the
   * fresh provider's FIRST post-recycle `synced` event when the replay
   * listener restores the edit. This map is the fast in-session carrier; a
   * durable copy is mirrored into the replay outbox (`replay-outbox.ts`) so a
   * tab crash inside the recycle window no longer loses the buffer — a fresh
   * tab reads it back from IDB and replays. The two stay coherent: whichever
   * source the replay listener consumes, it deletes the durable outbox first
   * so the edit is never re-applied.
   *
   * `delta` is the raw unsynced Yjs update relative to the last acked
   * baseline. It CANNOT integrate into the post-restart doc on its own:
   * the restarted server rebuilds every Y.Doc from markdown under a fresh
   * clientID, so the delta's left/right origins reference item IDs that no
   * longer exist and `Y.applyUpdate` parks the structs in `pendingStructs`
   * forever. `fullState` (the complete pre-recycle doc) exists so the
   * replay can reconstruct the edit at CONTENT level instead: rebuild the
   * old doc in a throwaway replica, work out which CRDT surface holds the
   * un-drained edit, and splice the recovered content into the fresh
   * Y.Text as an ordinary client edit. `fullState` is null when the doc
   * exceeded the buffer cap — the replay then falls back to the legacy
   * delta apply (which at worst leaves the structs pending, today's
   * behavior).
   */
  private readonly bufferedUpdates = new Map<string, BufferedReplayUpdate>();
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
   * rejection so the DocumentContext reconciliation adapter can preserve
   * the existing best-effort cleanup behavior inside Promise.all
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
   * failures so the DocumentContext reconciliation adapter does not see
   * partial-failure rejections, and the in-flight
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

  /**
   * Project-scoped storage keys, resolved once at construction from
   * `options.storageNamespace`. See `scopedStorageKey` for why the bare
   * constants cannot be used directly in a packaged desktop window.
   */
  private readonly lastObservedBranchKey: string;
  private readonly docLineageEpochsKey: string;

  /**
   * Project identity handed to every replay-outbox call. Held raw rather than
   * pre-scoped because the outbox composes its own database name around the
   * digest; see `outboxDbName`.
   */
  private readonly storageNamespace: string | null;

  constructor(
    maxSize: number,
    wsUrl: string,
    options?: {
      recycleDebounceMs?: number;
      clearDataTimeoutMs?: number;
      storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
      /**
       * Project identity (the content dir) that scopes this pool's storage
       * keys. Omit / null on hosts where the origin already isolates
       * projects. See `scopedStorageKey`.
       */
      storageNamespace?: string | null;
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
    const storageNamespace = options?.storageNamespace ?? null;
    this.storageNamespace = storageNamespace;
    this.lastObservedBranchKey = scopedStorageKey(LAST_OBSERVED_BRANCH_KEY, storageNamespace);
    this.docLineageEpochsKey = scopedStorageKey(DOC_LINEAGE_EPOCHS_KEY, storageNamespace);
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
   * Observe the live server epoch reported by `/api/server-info` or CC1
   * `server-info`. This is an observation entry point, not a field setter:
   * the pool owns the epoch-transition contract, and every channel that can
   * learn of a rotation (HTTP refresh, CC1 push, a rejected auth claim) is a
   * reporter routed through the same handling.
   *
   * Three observations, three outcomes:
   *
   * - **Same epoch** — no-op. The common case on every `__system__`
   *   reconnect when the server did not restart.
   * - **First epoch after boot or after a recycle** (`null` → id) — adopt.
   *   Resolves any pending `whenServerInstanceKnown()` handle and
   *   retroactively attaches persistence to entries opened during the
   *   window before the epoch was known. Persistence is
   *   `IndexeddbPersistence`-backed and the DB-name shape
   *   `ok-ydoc:${branch}:${serverInstanceId}:${docName}` carries the epoch
   *   as a structural correctness signal, so a provider opened before the
   *   live epoch is known cannot attach at admission time without picking
   *   the wrong epoch.
   * - **Rotation** (idA → idB) — route through the same transition handler
   *   the auth-rejection path uses, then adopt idB. Learning that the
   *   server rotated from an HTTP response is semantically identical to
   *   learning it from a rejected claim, and the per-doc providers holding
   *   frozen claims on idA cannot deliver that news themselves once the
   *   token-less `__system__` channel has already reported it.
   *
   * Does NOT overwrite the storage-backed IDB-associated ID: a fast boot
   * fetch after a server restart must not mask stale IDB contents before
   * the first document provider opens.
   */
  setExpectedServerInstanceId(id: string | null): void {
    const observed = id !== null && id.length > 0 ? id : null;
    const known =
      this.cachedServerInstanceId !== null && this.cachedServerInstanceId.length > 0
        ? this.cachedServerInstanceId
        : null;

    if (known !== null && observed === known) return;

    if (known !== null && observed !== null) {
      // The handler drops the dead epoch from the cache before it runs, so
      // it sees the same "no live epoch" state the auth-rejection path
      // hands it. Adoption of the new epoch happens below, after the
      // transition is under way, so the entries the recycle re-opens claim
      // the epoch that is actually live.
      this.handleServerInstanceMismatch(known);
      this.cachedServerInstanceId = observed;
      this.resolvePendingServerInstanceKnown(observed);
      // Deliberately no `attachDeferredPersistence` here. The recycle
      // re-opens every entry and attaches persistence at admission under
      // the new epoch; attaching mid-transition would instead bind a
      // pre-restart Y.Doc to a fresh-epoch IDB and seed it with the exact
      // stale state the recycle exists to discard.
      return;
    }

    this.cachedServerInstanceId = id;
    if (observed === null) return;
    this.resolvePendingServerInstanceKnown(observed);
    this.attachDeferredPersistence(observed);
  }

  /** Hand a newly-adopted epoch to whoever is waiting on one. */
  private resolvePendingServerInstanceKnown(id: string): void {
    if (this.pendingServerInstanceKnown === null) return;
    const pending = this.pendingServerInstanceKnown;
    this.pendingServerInstanceKnown = null;
    pending.resolve(id);
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
      const stored = this.storage?.getItem(this.lastObservedBranchKey) ?? null;
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
        this.storage?.removeItem(this.lastObservedBranchKey);
      } else {
        this.storage?.setItem(this.lastObservedBranchKey, branch);
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
      const raw = this.storage?.getItem(this.docLineageEpochsKey) ?? null;
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
        this.docLineageEpochsKey,
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
  ): { docName: string; branch: string; serverInstanceId?: string; project?: string } {
    const branch = this.normalizedObservedBranch();
    const base: { docName: string; branch: string; serverInstanceId?: string; project?: string } = {
      docName,
      branch,
    };
    const stale =
      staleClaimOverride !== undefined ? staleClaimOverride : this.recoveryMismatchStaleClaim;
    if (stale !== undefined && stale.length > 0) {
      base.serverInstanceId = stale;
    }
    // `docName` + `branch` are exactly the key two projects legitimately
    // share, so without this a cross-project report has nothing to correlate
    // on and a project-specific storage fault reads as a global one. Carries
    // the DIGEST, not the path: these events go through `console.warn` into
    // diagnostic bundles, and the raw namespace is an absolute path that can
    // contain the OS username. Routed through `projectDigest` — the same step
    // `scopedStorageKey` embeds — so the value stays comparable to the
    // database name's project segment by construction rather than because two
    // call sites happen to hash alike.
    if (this.storageNamespace !== null) {
      base.project = projectDigest(this.storageNamespace);
    }
    return base;
  }

  private emitStructuredClientRecoveryEvent(parts: Record<string, string | number>): void {
    console.warn(JSON.stringify(parts));
  }

  /**
   * Describe a durable-outbox failure for telemetry, splitting a STALL from an
   * ordinary IDB error the same way `ok-client-cache-clear-failed` does. The
   * two call for different responses: an error is one failed operation, a
   * timeout means the storage layer is wedged and whatever the operation was
   * gating (a recycle, a replay) is stuck behind it.
   */
  private outboxFailureFields(err: unknown): {
    failureKind: 'timeout' | 'rejected';
    errorName: string;
    errorMessage: string;
  } {
    return {
      failureKind: err instanceof ReplayOutboxTimeoutError ? 'timeout' : 'rejected',
      errorName: err instanceof Error ? err.name : 'non-error-throw',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  /**
   * Info-level lifecycle breadcrumb for the reconnect/recycle path. Same
   * structured-console channel as the recovery events (the client log
   * forwarder lifts `{event, ...fields}` JSON into the server log, so these
   * reach diagnostics bundles), but at `console.info` — breadcrumbs are
   * expected transitions, not warnings.
   */
  private emitStructuredClientBreadcrumb(parts: Record<string, string | number | boolean>): void {
    console.info(JSON.stringify(parts));
  }

  private clearRecoveryMismatchStaleClaimIfTerminal(): void {
    const kind = this.serverRestartRecoveryState.kind;
    if (kind === 'idle' || kind === 'failed') {
      this.recoveryMismatchStaleClaim = undefined;
    }
  }

  private beginServerRestartRecovery(docNames: readonly string[], startedAt: number): void {
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-restart-recovery-begin',
      phase: 'clearing-local-cache',
      docCount: docNames.length,
    });
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
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-restart-recovery-reconnecting',
      docCount: docNames.length,
      failedCount: failedDocNames.length,
    });
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
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-restart-recovery-synced',
      docName,
      remaining: remaining.length,
    });
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
   * React layer owns the React-state-aware reconciliation (snapshot capture,
   * persistence cleanup, tab remapping, active-tab navigation) and emits the
   * structured `removal.cleanup` event after the awaited cleanup settles.
   * Mirrors the `setOnBranchMismatch` shape — pool stays free of React/UI knowledge.
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
   * Replace the workspace's visible document set.
   *
   * Visible panes are a resource-policy exemption, not another active-document
   * concept: `activeDocName` still identifies the one focused pane for global
   * shortcuts and awareness. System documents are never admitted to either
   * layer. Shrinking the set eagerly returns the provider pool to its ordinary
   * budget by evicting only entries that are no longer protected.
   */
  setVisibleDocNames(names: ReadonlySet<string>): void {
    const next = new Set<string>();
    for (const docName of names) {
      if (!isSystemDoc(docName)) next.add(docName);
    }

    if (
      next.size === this.visibleDocNames.size &&
      [...next].every((docName) => this.visibleDocNames.has(docName))
    ) {
      return;
    }

    this.visibleDocNames = next;
    this.trimToCapacity();
    mark('ok/pool/visible-set', {
      visibleCount: this.visibleDocNames.size,
      poolSize: this.entries.size,
    });
  }

  private isProtected(docName: string): boolean {
    return docName === this.activeDocName || this.visibleDocNames.has(docName);
  }

  private effectiveCapacity(): number {
    // The focused document is normally in visibleDocNames. Counting it here as
    // well keeps the active-document protection intact during transient
    // workspace updates where a focused target changes before its pane list.
    const protectedCount =
      this.visibleDocNames.size +
      (this.activeDocName !== null && !this.visibleDocNames.has(this.activeDocName) ? 1 : 0);
    return Math.max(this.maxSize, protectedCount);
  }

  private trimToCapacity(): void {
    while (this.entries.size > this.effectiveCapacity() && this.evictLru()) {
      // `evictLru` synchronously removes one unprotected entry. Continue until
      // the normal budget is restored or every remaining entry is protected.
    }
  }

  /**
   * Open (or reuse) a document. Returns the pool entry, or `null` if the
   * docName is reserved (the `__system__` pseudo-doc carries CC1 signals and
   * is never user-editable). If the pool is at
   * capacity, evicts the LRU entry (never an active or visible-pane doc).
   */
  open(docName: string): PoolEntry | null {
    if (isSystemDoc(docName)) return null;

    // Eagerly recycle a disconnected CONTENTLESS entry on the hit path:
    // handing back a dropped-socket provider parks the caller's
    // `syncPromise` on an event that may not arrive soon, burning the full
    // sync timeout before `DocumentErrorBoundary` recycles it anyway.
    // Skipped while the provider still holds unsynced local edits — this
    // path has no buffer-and-replay (that exists only for
    // `server-instance-mismatch`), the same reason the debounced
    // disconnect-recycle re-checks `unsyncedChanges` at fire time. Gated on
    // `hasSynced` for the same reason that path is: an entry still working
    // through its first connect is waiting on a sync that its own backoff
    // will deliver, and recycling it would discard a pending persistence
    // attach on every open.
    //
    // The content check mirrors the onDisconnect guard — one policy, two
    // sites. Without it, a provider preserved across the disconnect is
    // destroyed by the next workspace commit's `open()` of the same doc
    // (the switch back to the tab, exactly when the user would see the
    // blank flash). A content-bearing entry keeps its warm doc either way:
    // if the server is reachable the provider's own backoff resyncs it,
    // and if it is not, a fresh provider could not sync either.
    const pooled = this.entries.get(docName);
    if (
      pooled !== undefined &&
      pooled.kind === 'active' &&
      pooled.hasSynced &&
      pooled.syncState === 'disconnected' &&
      pooled.provider.unsyncedChanges === 0 &&
      !hasMaterializedLocalContent(pooled.provider.document)
    ) {
      mark('ok/pool/recycle-disconnected-on-open', { docName });
      this.emitStructuredClientBreadcrumb({
        event: 'ok-pool-recycle-disconnected-on-open',
        docName,
      });
      this.recycleDisconnectedEntry(docName);
      // The recycle re-admits the active doc under a fresh provider; any
      // other doc is simply dropped and the MISS path below rebuilds it.
      const reopened = this.entries.get(docName);
      if (reopened !== undefined) return reopened;
    }

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

    // Keep MAX_POOL as the normal warm-provider budget, while allowing every
    // visible editor pane to retain its provider. If all current entries are
    // protected, admission may temporarily exceed the baseline; the next
    // visible-set shrink trims unprotected entries back to budget.
    if (this.entries.size >= this.effectiveCapacity()) {
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

    const poolEventId = randomUUID();
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
      serverDrivenCloseReauthAttempts: 0,
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
      // A successful sync means any prior server-driven-close reauth actually
      // worked — clear the streak so a later REASONED close gets a fresh
      // re-auth budget. Scope and non-scope of the bound:
      // `SERVER_DRIVEN_CLOSE_REAUTH_CEILING`.
      entry.serverDrivenCloseReauthAttempts = 0;
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

      // Preserve providers that already materialized content locally. Recycle
      // on ordinary disconnect would destroy the cached Y.Doc/editor and make
      // a warm tab look empty until a fresh provider finishes syncing again.
      // Explicit server-instance mismatch and branch-switch recovery still
      // call recycleDisconnectedEntry because those paths first clear stale
      // persistence and intentionally need a fresh Y.Doc. For contentless
      // providers: only the FIRST disconnect sets the timer; subsequent
      // disconnects (from failed reconnect attempts) are no-ops — each one
      // just means "still can't reach the server."
      if (
        entry.hasSynced &&
        provider.unsyncedChanges === 0 &&
        !hasMaterializedLocalContent(provider.document) &&
        !entry.pendingRecycleTimer
      ) {
        this.emitStructuredClientBreadcrumb({
          event: 'ok-pool-recycle-timer-armed',
          docName,
          debounceMs: this.recycleDebounceMs,
        });
        entry.pendingRecycleTimer = setTimeout(() => {
          // Re-narrow inside the timer closure — `entry` was Active when the
          // timer was scheduled, but TS doesn't carry the narrowing across
          // the async boundary, and the entry may have been torn down before
          // the timer fired.
          if (entry.kind !== 'active') return;
          entry.pendingRecycleTimer = null;
          if (this.entries.get(docName) !== entry) return;
          // Re-check for unsynced local edits at FIRE time, not just arm
          // time. An edit typed inside the debounce window makes the doc
          // dirty, and this plain-recycle path has no buffer-and-replay
          // (that exists only for `server-instance-mismatch`) — recycling a
          // dirty doc destroys the edit permanently whenever the server
          // identity changes before resync (auto-update relaunch is a
          // first-class trigger). Skip instead: the provider's backoff
          // keeps reconnecting, a same-identity reconnect syncs the edit,
          // an identity change routes through the mismatch path's
          // buffer-and-replay, and a later clean disconnect re-arms the
          // timer so resource reclamation still happens.
          if (provider.unsyncedChanges > 0) {
            mark('ok/pool/recycle-skipped-unsynced', { docName });
            this.emitStructuredClientBreadcrumb({
              event: 'ok-pool-recycle-skipped-unsynced',
              docName,
            });
            return;
          }
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
    // authenticationFailed in quick succession. The transition handler
    // dedupes on the stale claim value, so siblings reporting the same dead
    // epoch short-circuit there, and an in-flight recycle collapses siblings
    // reporting different ones. Clearing the cached epoch is a consequence of
    // the transition, not the dedupe mechanism, and is conditional so a
    // fresher epoch already observed on another channel survives.
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
        // `expectedServerInstanceId` is the claim this provider froze at
        // construction time, and the rejection proves that epoch is dead.
        // Idempotence lives in the transition handler, keyed by the claim
        // value: a provider admitted without a claim has nothing to report.
        if (expectedServerInstanceId === null) {
          return;
        }
        this.handleServerInstanceMismatch(expectedServerInstanceId);
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
      // Re-auth is only meaningful for a genuine server-driven doc-level close.
      // This same `'close'` event also fires for a raw WS-transport drop (a dead
      // server's reconnect loop, sleep/wake, a network blip), which arrives with
      // an EMPTY reason — the server NEVER sends an empty CloseMessage reason (its
      // default is "Server closed the connection"; `closeConnections` sends 4205
      // "Reset Connection"), so an empty reason is definitionally a transport
      // drop. Those are owned by the `'disconnect'` arm and the syncPromise
      // rejection, not a doc-level auth decision: re-authing on them is pointless
      // (the transport is gone, the token can't send) and, against a dead server,
      // IS the close-after-close that would otherwise spin. Skip them at the root;
      // what the ceiling below still backstops is documented on
      // `SERVER_DRIVEN_CLOSE_REAUTH_CEILING`.
      if (!event?.reason) return;
      if (entry.serverDrivenCloseReauthInFlight) return;
      // Ceiling: stop re-authing once the streak of failed reauths (no
      // intervening `synced`, which resets the counter) reaches the bound, and
      // escalate ONCE with a structured `console.warn` breadcrumb — a log
      // trail, not a queryable state field. What this protects against (and
      // what the empty-reason guard above already owns instead) is documented
      // once, on `SERVER_DRIVEN_CLOSE_REAUTH_CEILING`.
      if (entry.serverDrivenCloseReauthAttempts >= SERVER_DRIVEN_CLOSE_REAUTH_CEILING) {
        if (entry.serverDrivenCloseReauthAttempts === SERVER_DRIVEN_CLOSE_REAUTH_CEILING) {
          // One-shot: bump past the ceiling so later closes short-circuit here
          // without re-emitting the escalation.
          entry.serverDrivenCloseReauthAttempts = SERVER_DRIVEN_CLOSE_REAUTH_CEILING + 1;
          console.warn(
            JSON.stringify({
              event: 'ok-provider-server-driven-close-reauth-ceiling',
              docName,
              attempts: SERVER_DRIVEN_CLOSE_REAUTH_CEILING,
              reason: event?.reason ?? '<unknown>',
              code: event?.code ?? null,
            }),
          );
        }
        return;
      }
      entry.serverDrivenCloseReauthAttempts += 1;
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
      // Reason is guaranteed non-empty here (empty-reason transport drops
      // returned above), so this only records genuine server-driven closes.
      // `code` still distinguishes the server's close variants (default vs 4205
      // "Reset Connection") in a diagnostic bundle.
      console.info(
        JSON.stringify({
          event: 'ok-provider-server-driven-close-reauth',
          docName,
          reason: event.reason,
          code: event?.code ?? null,
        }),
      );
    };

    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('disconnect', onDisconnect);
    provider.on('authenticationFailed', onAuthenticationFailed);
    provider.on('close', onServerDrivenClose);
    // Fan a provider's unsynced-work edges out to pool-level listeners (the
    // desktop background-throttle reporter). Removed with the provider on
    // `destroy()`. The immediate emit catches a doc that opens already dirty.
    provider.on('unsyncedChanges', () => this.emitUnsyncedWork());
    this.emitUnsyncedWork();

    // Buffer-replay wiring: on the first `synced` after (re)open, replay any
    // unsynced edit captured during a prior `server-instance-mismatch`
    // recycle. Two sources: the in-session RAM buffer (same-tab recycle) and
    // the durable outbox (`replay-outbox.ts`, which survives a tab crash in
    // the recycle window — the only signal a fresh tab has). The listener
    // self-detaches after firing once; with no buffered edit it is a cheap
    // no-op (one `indexedDB.databases()` check). Origin `TAB_REPLAY_ORIGIN`
    // lets observers distinguish replay writes from user edits / server sync.
    const staleClaimAtReplayInstall = this.recoveryMismatchStaleClaim;
    const runReplay = async (): Promise<void> => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      const branch = this.normalizedObservedBranch();

      // Prefer the RAM buffer (no IDB read); fall back to the durable outbox,
      // the only carrier after a tab crash.
      let source: { delta: Uint8Array; fullState: Uint8Array | null };
      // The outbox key this replay's token lives under, and whether a token
      // exists at all. A RAM buffer with no durable mirror (over-cap doc,
      // failed write, engine without `databases()`) has nothing to claim.
      let tokenBranch = branch;
      let tokenBacked: boolean;
      const buffered = this.bufferedUpdates.get(docName);
      if (buffered !== undefined) {
        if (buffered.branch !== branch) {
          // Provenance fence. The buffer was captured against a different
          // branch's content, and edits authored on one branch are not valid
          // against another's — the same "discard, don't preserve" policy the
          // cross-branch invalidation applies, enforced here so it holds no
          // matter which channel triggered this recycle. Discard drops the
          // RAM copy and its durable mirror together, so the branch this
          // buffer belonged to keeps no resurrectable record.
          this.discardBufferedUpdate(docName);
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-buffer-replay-branch-mismatch',
            ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
            reason: 'buffer-captured-on-another-branch',
          });
          return;
        }
        this.bufferedUpdates.delete(docName);
        source = buffered;
        tokenBranch = buffered.branch;
        tokenBacked = buffered.durable;
      } else {
        try {
          const durable = await readReplayOutboxEntry({
            branch,
            docName,
            namespace: this.storageNamespace,
          });
          if (durable === null) return;
          source = durable;
          tokenBacked = true;
        } catch (err: unknown) {
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-buffer-replay-outbox-read-failed',
            ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
            ...this.outboxFailureFields(err),
          });
          return;
        }
      }

      // Consume-first: delete the durable outbox BEFORE any content reaches
      // the server, so a crash after apply can never let a reopen re-apply.
      // The content-level replay's surface comparison is not re-entrant — a
      // stale outbox replayed against already-synced content would clobber it.
      // At-most-once in the tiny [consumed → server-synced] tail (matching the
      // RAM buffer, and past the crash window the outbox exists to close).
      //
      // The consume is also the CROSS-TAB claim: tabs resolving the SAME
      // namespace share one `(namespace, branch, docName)` record, so losing
      // the claim usually means another such tab has already CLAIMED this
      // edit and owns whatever happens to it (consume-first, so that tab may
      // still bail). It can also mean a stale detached consume took the key
      // and nobody owns the edit — `discardBufferedUpdate` documents that
      // race. Stand down regardless: this caller cannot distinguish them, and
      // applying against a real winner splices this tab's stale pre-recycle
      // bytes back over the content just recovered — a silent revert, not a
      // duplicate. A window of a
      // DIFFERENT project never contends for it. That covers both orders —
      // the other tab consuming before we read (we never see a record) and
      // after (we see one but cannot claim it).
      //
      // Only attempt it when a durable record actually backs this replay. An
      // unconditional consume would, on a RAM-only buffer, throw its way into
      // the bail below with the RAM copy ALREADY deleted and no outbox to
      // recover from — dropping the edit inside the mechanism that exists to
      // preserve it.
      if (tokenBacked) {
        let claimed: boolean;
        try {
          claimed = await consumeReplayOutboxEntry({
            branch: tokenBranch,
            docName,
            namespace: this.storageNamespace,
          });
        } catch (err: unknown) {
          // Bail rather than apply: the record is still there, so a later
          // clean open recovers the edit instead of risking a double-apply.
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-buffer-replay-outbox-consume-failed',
            ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
            ...this.outboxFailureFields(err),
          });
          return;
        }
        if (!claimed) {
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-buffer-replay-superseded',
            ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
            reason: 'claimed-by-another-tab',
          });
          return;
        }
      }
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) {
        // Both carriers are gone by now (RAM deleted above, outbox claimed),
        // so this bail is a real in-process loss — not the ratified crash
        // tail. Loud so it can never be mistaken for "nothing to replay".
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-abandoned',
          ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
          reason: 'entry-replaced-during-consume',
          replayByteLength: source.delta.byteLength,
        });
        return;
      }

      try {
        if (
          source.fullState !== null &&
          this.replayBufferedContent(docName, provider, source.fullState)
        ) {
          return;
        }
        // Delta-only fallback (full state over cap, replica rebuild threw, or
        // content divergence made the surface attribution ambiguous). The raw
        // delta usually parks in `pendingStructs` on a rebuilt doc — kept as
        // the terminal fallback so this path never REGRESSES relative to the
        // pre-content-replay behavior.
        Y.applyUpdate(provider.document, source.delta, TAB_REPLAY_ORIGIN);
        this.emitStructuredClientBreadcrumb({
          event: 'ok-pool-buffer-replay-delta-applied',
          docName,
          deltaBytes: source.delta.byteLength,
        });
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : 'non-error-throw';
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-failed',
          ...this.recoveryTelemetryBase(docName, staleClaimAtReplayInstall),
          replayByteLength: source.delta.byteLength,
          errorName,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const onSyncedReplay = (): void => {
      // Detach synchronously so a second `synced` during the async replay never
      // re-triggers. `runReplay` handles its own known failure boundaries
      // (outbox read/consume, apply) and returns; this outer handler fires only
      // on an UNEXPECTED throw — which, once a carrier has been consumed, is a
      // silent in-process loss. Emit it (like this file's other fire-and-forget
      // recovery paths) rather than swallow, while still keeping the rejection
      // out of the `synced` emitter. It carries the full telemetry base: this
      // is the highest-value event on the buffer-replay path for a
      // cross-project incident, so omitting `branch` and `project` here is
      // exactly the wrong place to economize. Safe to call — the base's only
      // fallible step (storage read) already swallows, and the digest is a
      // pure function.
      provider.off('synced', onSyncedReplay);
      void runReplay().catch((err: unknown) => {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-unexpected-error',
          ...this.recoveryTelemetryBase(docName),
          errorName: err instanceof Error ? err.name : 'non-error-throw',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    };
    provider.on('synced', onSyncedReplay);

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
    if (this.handledStaleClaims.has(staleClaimedServerInstanceId)) {
      // The claim rides along because these breadcrumbs are the diagnostic
      // for this race, and "dedupe fired" without "for which epoch" cannot be
      // correlated across a burst. Server instance ids are server-generated
      // UUIDs, so the cardinality discipline is satisfied.
      this.emitStructuredClientBreadcrumb({
        event: 'ok-pool-mismatch-transition-deduped',
        reason: 'claim-already-handled',
        staleClaim: staleClaimedServerInstanceId,
      });
      return;
    }
    this.handledStaleClaims.add(staleClaimedServerInstanceId);
    // Drop the cache only while it still holds the epoch just proven dead.
    // A fresher epoch already observed on another channel must survive so
    // the entries this recycle re-opens claim the one that is live.
    if (this.cachedServerInstanceId === staleClaimedServerInstanceId) {
      this.cachedServerInstanceId = null;
    }
    if (this.mismatchInFlight !== null) {
      // A recycle already covers every pool entry, so a sibling transition
      // reported under a different stale claim must not start a second one.
      // Claim-keyed dedupe alone would miss this collapse.
      this.emitStructuredClientBreadcrumb({
        event: 'ok-pool-mismatch-transition-deduped',
        reason: 'recycle-in-flight',
        staleClaim: staleClaimedServerInstanceId,
        inflightForClaim: this.recoveryMismatchStaleClaim ?? '',
      });
      return;
    }

    this.recoveryMismatchStaleClaim =
      staleClaimedServerInstanceId.length > 0 ? staleClaimedServerInstanceId : undefined;

    // Snapshot entries BEFORE any async work — subsequent recycle mutates
    // the map via destroyEntry → delete → re-open.
    const snapshot = Array.from(this.entries.entries());
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-mismatch-recycle-begin',
      entryCount: snapshot.length,
      branch: this.normalizedObservedBranch(),
    });
    const startedAt = Date.now();
    // Branch scope for the durable replay outbox — captured once so every
    // per-doc write uses the same key the reopen path reconstructs.
    const recoveryBranch = this.normalizedObservedBranch();
    // Durable-outbox writes kicked off during the capture loop. Awaited before
    // `clearData()` so a crash while the y-indexeddb store is being wiped still
    // leaves the buffer recoverable (buffer → clearData → recycle ordering).
    const outboxWrites: Promise<void>[] = [];
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
        // Full pre-recycle state rides along so the replay can recover the
        // edit at content level (see `bufferedUpdates` doc comment). Docs
        // whose full state exceeds the cap keep the delta-only fallback.
        const fullState = Y.encodeStateAsUpdate(poolEntry.provider.document);
        const fullStateForBuffer = fullState.byteLength > MAX_BUFFER_BYTES ? null : fullState;
        const buffered: BufferedReplayUpdate = {
          delta: unsynced,
          fullState: fullStateForBuffer,
          branch: recoveryBranch,
          durable: false,
        };
        this.bufferedUpdates.set(docName, buffered);
        // Mirror the buffer into the durable outbox only when content-level
        // replay is possible (over-cap docs stay RAM-only — their crash loss
        // is the same accepted trade-off as before). A failed durable write
        // degrades to the RAM buffer, so swallow-and-observe rather than
        // block the recycle. `durable` flips only once the record has
        // committed; everything downstream (the cross-tab claim, the discard
        // paths) keys off it, so an unwritten mirror can never be mistaken
        // for a live token.
        if (fullStateForBuffer !== null) {
          outboxWrites.push(
            writeReplayOutboxEntry(
              { branch: recoveryBranch, docName, namespace: this.storageNamespace },
              { delta: unsynced, fullState: fullStateForBuffer },
            )
              .then((persisted) => {
                if (persisted) buffered.durable = true;
                else {
                  this.emitStructuredClientRecoveryEvent({
                    event: 'ok-buffer-replay-outbox-unavailable',
                    ...this.recoveryTelemetryBase(docName),
                    reason: 'indexeddb-databases-unsupported',
                  });
                }
              })
              .catch((err: unknown) => {
                this.emitStructuredClientRecoveryEvent({
                  event: 'ok-buffer-replay-outbox-write-failed',
                  ...this.recoveryTelemetryBase(docName),
                  ...this.outboxFailureFields(err),
                });
              }),
          );
        }
        this.emitStructuredClientBreadcrumb({
          event: 'ok-pool-mismatch-buffer-captured',
          docName,
          deltaBytes: unsynced.byteLength,
          fullStateBytes: fullStateForBuffer === null ? 0 : fullStateForBuffer.byteLength,
        });
      }
    }

    // Select entries to clear now, but DEFER the actual `clearData()` calls
    // until the durable outbox writes commit — a crash between "IDB wiped"
    // and "outbox written" would lose the buffer, so the outbox must land
    // first. Keeps the buffer → clearData → recycle ordering.
    const toClear: { docName: string; persistence: ClientPersistenceProvider }[] = [];
    for (const [docName, poolEntry] of snapshot) {
      // TearingDown entries have null persistence by construction; Active
      // entries opened before the live server epoch was known also have
      // null persistence — the persistent IDB cache wasn't attached, so
      // there's nothing to clear. BridgeFailed entries (Active with
      // bridgeSetupFailed=true) still have persistence attached and
      // SHOULD be cleared.
      if (poolEntry.kind !== 'active') continue;
      if (poolEntry.persistence === null) continue;
      toClear.push({ docName, persistence: poolEntry.persistence });
    }

    // Clear IDB then recycle. When the durable outbox has writes in flight,
    // await them first so a crash between "IDB wiped" and "outbox written"
    // can't lose the buffer; with nothing to write, clearData starts
    // synchronously (timing unchanged from before the durable layer).
    const runClearsAndRecycle = (): Promise<void> => {
      // Gate per-doc on clearData success. A `clearData` failure (blocked
      // by another tab/DevTools, quota exhaustion, transaction-aborted)
      // means the IDB still holds the pre-restart Y.Doc state — recycling
      // into the un-cleared DB would hydrate the fresh provider's Y.Doc
      // from stale data BEFORE Yjs sync runs, re-opening the content-
      // duplication bug class clearData exists to prevent. Use
      // `Promise.allSettled` so per-element rejections surface (the prior
      // `Promise.all + per-element catch` swallowed every failure, then
      // recycled unconditionally).
      const clears: { docName: string; promise: Promise<void> }[] = toClear.map(
        ({ docName, persistence }) => ({
          docName,
          promise: this.withClearDataTimeout(docName, persistence.clearData()),
        }),
      );
      this.emitStructuredClientBreadcrumb({
        event: 'ok-pool-mismatch-clears-begin',
        count: clears.length,
      });
      return Promise.allSettled(clears.map((c) => c.promise)).then((results) => {
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
      });
    };
    const inflight: Promise<void> = (
      outboxWrites.length === 0
        ? runClearsAndRecycle()
        : Promise.allSettled(outboxWrites).then(runClearsAndRecycle)
    ).finally(() => {
      if (this.mismatchInFlight === inflight) {
        this.mismatchInFlight = null;
        // Every entry has been re-opened under a fresh claim, so nothing
        // in the pool can still report these epochs. Dropping them keeps
        // the set bounded and leaves the retry path open for an entry the
        // recycle left inert on a failed clear: its next rejection carries
        // the same claim and gets a real transition rather than a silent
        // bail.
        this.handledStaleClaims.clear();
      }
    });
    this.mismatchInFlight = inflight;
  }

  /**
   * Content-level buffer replay for the `server-instance-mismatch` recycle.
   *
   * The raw unsynced delta cannot integrate into the post-restart doc (the
   * rebuilt doc has fresh item IDs — see the `bufferedUpdates` doc comment),
   * so the edit is reconstructed as CONTENT: rebuild the pre-recycle doc in
   * a throwaway replica, decide which CRDT surface holds the un-drained
   * edit by comparing each surface against the fresh server content
   * (whichever surface still matches the server IS the base), and splice
   * the recovered document string into the fresh Y.Text as an ordinary
   * client edit. Server Observer B derives the fragment from Y.Text, so a
   * single-surface write is sufficient and cannot double-apply.
   *
   * Returns true when the replay is complete (including "nothing to
   * restore"); false when the surface attribution is ambiguous (both
   * surfaces diverge from the server — concurrent server-side change or
   * mixed-mode edits) or the replica rebuild failed, in which case the
   * caller falls back to the legacy delta apply.
   */
  private replayBufferedContent(
    docName: string,
    provider: HocuspocusProvider,
    fullState: Uint8Array,
  ): boolean {
    const replica = new Y.Doc();
    try {
      Y.applyUpdate(replica, fullState);
      const oursYtext = replica.getText('source').toString();
      const fragJson = yXmlFragmentToProseMirrorRootNode(
        replica.getXmlFragment('default'),
        getEditorSchema(),
      ).toJSON();
      const mdMgr = new MarkdownManager({ extensions: sharedExtensions });
      const oursFragBody = mdMgr.serialize(fragJson);
      const { frontmatter: oursFm, body: oursYtextBody } = stripFrontmatter(oursYtext);
      const theirs = provider.document.getText('source').toString();
      const { body: theirsBody } = stripFrontmatter(theirs);
      const theirsNorm = normalizeBridge(theirsBody);
      // `addsBlankLines` breaks the tie the normalized compare cannot: it
      // collapses blank runs on both sides, so buffered blank lines the
      // server's rebuilt state lacks would read as "nothing to restore" and
      // the recycle would discard them.
      const ytextClean =
        normalizeBridge(oursYtextBody) === theirsNorm && !addsBlankLines(theirsBody, oursYtextBody);
      const fragClean =
        normalizeBridge(oursFragBody) === theirsNorm && !addsBlankLines(theirsBody, oursFragBody);
      if (ytextClean && fragClean) return true;
      let ours: string;
      if (ytextClean) {
        // Un-drained WYSIWYG edit: the fragment moved while Y.Text stayed
        // at the acked base the server rebuilt from disk.
        // The only serialize-composed writer outside the server. Without the
        // guard, an un-drained doc-start rule pair replayed through the recycle
        // re-mints the collision server-side after every server writer is
        // fixed.
        ours = composeWithDerivedBody(oursFm, oursFragBody).md;
      } else if (fragClean) {
        // Unacked source-mode edit: Y.Text moved, fragment still at base.
        ours = oursYtext;
      } else {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-diverged',
          ...this.recoveryTelemetryBase(docName),
        });
        return false;
      }
      if (ours !== theirs) {
        // Minimal splice (common prefix/suffix trim) keeps untouched bytes
        // untouched — Y.Text is byte-sacred outside the recovered edit
        // (precedent #57).
        const maxScan = Math.min(ours.length, theirs.length);
        let prefix = 0;
        while (prefix < maxScan && ours[prefix] === theirs[prefix]) prefix += 1;
        let suffix = 0;
        while (
          suffix < maxScan - prefix &&
          ours[ours.length - 1 - suffix] === theirs[theirs.length - 1 - suffix]
        ) {
          suffix += 1;
        }
        const ytext = provider.document.getText('source');
        provider.document.transact(() => {
          ytext.delete(prefix, theirs.length - prefix - suffix);
          ytext.insert(prefix, ours.slice(prefix, ours.length - suffix));
        }, TAB_REPLAY_ORIGIN);
      }
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-buffer-replay-content-applied',
        ...this.recoveryTelemetryBase(docName),
        surface: ytextClean ? 'fragment' : 'ytext',
      });
      return true;
    } catch (err: unknown) {
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-buffer-replay-content-failed',
        ...this.recoveryTelemetryBase(docName),
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      replica.destroy();
    }
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
   * True while a `server-instance-mismatch` recycle owns the pool.
   *
   * The stand-down signal for any other whole-pool invalidation. `flushOnHide`
   * and `resyncOnVisible` read the private field directly; the cross-branch
   * invalidation lives outside this class and needs the same answer, because
   * one `/api/server-info` dispatch can report a rotated epoch and a changed
   * branch together and must still run a single invalidation.
   */
  isMismatchRecycleInFlight(): boolean {
    return this.mismatchInFlight !== null;
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
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-recycle-all',
      count: docNames.length,
    });
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
    this.discardBufferedUpdate(docName);

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
    // The DocumentContext reconciliation adapter batches many calls via
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
      // the idempotent semantics the DocumentContext reconciliation adapter
      // relies on when batching close-and-clears for renames.
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
    for (const docName of Array.from(this.bufferedUpdates.keys())) {
      this.discardBufferedUpdate(docName);
    }
  }

  /**
   * Drop one doc's pending replay buffer on an INTENTIONAL discard — RAM copy
   * and durable mirror together. Two families of trigger, and the split is
   * what the race note below turns on: those that follow a BRANCH MOVE (the
   * cross-branch invalidation, and the replay path's own provenance fence when
   * a buffer turns out to belong to another branch), and those on the branch
   * still current (everything reaching here through `close()` — an explicit
   * close, LRU eviction, the rename flow's close-and-clear).
   *
   * Dropping only the RAM copy would leave the outbox record behind as an
   * immortal orphan: a later open of the same doc reads it back and replays an
   * arbitrarily old edit, which is exactly the surprise `close()` and the
   * cross-branch invalidation were each written to prevent. The consume is
   * detached (`void`) for every caller — none needs the result — and it always
   * keys on `buffered.branch`, the branch captured WITH the buffer, never the
   * branch now current. So a discard triggered by a branch move cannot reach a
   * post-switch record: that record lives under a different key.
   *
   * The still-current-branch family has no such disjointness, and
   * `consumeReplayOutboxEntry` claims the KEY rather than the record — so if
   * the same doc is recaptured before a pending consume lands, that consume
   * takes the NEW record, and the replay behind it then finds its claim gone
   * and stands down, having ALREADY dropped its RAM copy. No tab owns the
   * edit at that point, so it is lost, and reported as
   * `claimed-by-another-tab`, which misnames both the cause and the outcome.
   * Accepted on likelihood: the consume is three IDB hops even nominally (the
   * `databases()` probe, the open, the claim transaction), and
   * `withOutboxTimeout` only REJECTS at its deadline — it cannot abort the
   * transaction — so a stalled one lands arbitrarily later. What keeps the
   * race remote is the other leg. A record only ever appears under that key
   * from `handleServerInstanceMismatch`, and every still-current-branch
   * discard runs through `close()`, which destroys the POOL entry first (not
   * the outbox record) — so the doc has to be REOPENED and hit a SECOND
   * mismatch inside that window.
   * Closing it properly means identifying the record (stamp a token at write,
   * delete only on match) rather than trusting the key.
   *
   * A failure is still reported, since it leaves a resurrectable edit behind.
   *
   * Deliberately NOT called from `dispose()`: that is a pool-lifecycle end
   * (HMR remount, collab-URL swap, test teardown), not a user discard, and the
   * durable copy surviving it is the crash-durability the outbox exists for.
   */
  private discardBufferedUpdate(docName: string): void {
    const buffered = this.bufferedUpdates.get(docName);
    this.bufferedUpdates.delete(docName);
    if (buffered === undefined || !buffered.durable) return;
    void consumeReplayOutboxEntry({
      branch: buffered.branch,
      docName,
      namespace: this.storageNamespace,
    }).catch((err: unknown) => {
      this.emitStructuredClientRecoveryEvent({
        event: 'ok-buffer-replay-outbox-discard-failed',
        ...this.recoveryTelemetryBase(docName),
        ...this.outboxFailureFields(err),
      });
    });
  }

  /**
   * Test-only buffer manipulation. The cross-branch buffer-leak fix is
   * load-bearing but invisible from public APIs (the buffer is a private
   * Map populated only by `handleServerInstanceMismatch` mid-recycle).
   * Tests need a way to seed the buffer + observe its size to assert
   * branch-switched / close drain semantics. Naming-prefix `__test`
   * keeps these out of production call sites by convention.
   */
  __test_seedBufferedUpdate(
    docName: string,
    update: Uint8Array,
    options: { fullState?: Uint8Array; durable?: boolean; branch?: string } = {},
  ): void {
    this.bufferedUpdates.set(docName, {
      delta: update,
      fullState: options.fullState ?? null,
      branch: options.branch ?? this.normalizedObservedBranch(),
      durable: options.durable ?? false,
    });
  }
  __test_bufferedUpdatesSize(): number {
    return this.bufferedUpdates.size;
  }
  __test_hasBufferedUpdate(docName: string): boolean {
    return this.bufferedUpdates.has(docName);
  }
  __test_getBufferedUpdate(docName: string): Uint8Array | undefined {
    return this.bufferedUpdates.get(docName)?.delta;
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
   * Toggle the background-flush / resync-on-visible mechanism. Wired from
   * the project `bridge.flushOnHide.enabled` kill-switch (default ON);
   * disable only to isolate a suspected regression.
   */
  setFlushOnHideEnabled(enabled: boolean): void {
    this.flushOnHideEnabled = enabled;
  }

  /**
   * Push every active doc's unsynced work to the server and commit its IDB
   * cache when the tab is backgrounded or unloaded.
   *
   * A backgrounded tab's timers are throttled and it may be frozen or
   * recycled before the provider's incremental-update path delivers the
   * last edits. IndexedDB alone is not durable — it is an additive cache
   * the mismatch-recycle flow clears — so the flush should reach the SERVER.
   * `forceSync()` re-runs the sync handshake (the same primitive
   * `forceSyncInterval` uses to recover dropped updates), reconciling any
   * edit the server is missing; `flushFullState()` then commits the cache.
   *
   * How much of that lands depends on which hide this is, and the difference
   * is structural, not a gap to close: `forceSync()` only SENDS SyncStep1, and
   * the client's own updates travel to the server one full exchange later (the
   * server answers with its SyncStep1, the client replies SyncStep2). On
   * `visibilitychange → hidden` the tab is still alive, so that exchange
   * completes and the server delivery is real. On a true unload (`pagehide`
   * for a close/navigate) the tab does not survive the round trip, so the
   * effective durability there is the IndexedDB commit — which is why
   * `flushFullState()` is not treated as the redundant half of this pair. No
   * WebSocket primitive can beat unload; `sendBeacon` carries no CRDT session.
   *
   * Skipped while a server-instance-mismatch recycle is in flight: that
   * flow already captures the unsynced delta into the durable replay outbox
   * and owns re-delivery, so a concurrent forceSync would race the epoch it
   * is being recycled against for no benefit.
   */
  flushOnHide(): void {
    if (!this.flushOnHideEnabled) return;
    if (this.mismatchInFlight !== null) return;
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'active') continue;
      if (entry.provider.unsyncedChanges > 0) {
        entry.provider.forceSync();
        // On a true unload this IDB commit is the effective durability (see the
        // docblock above), so a rejection loses edits — route it through the
        // structured emitter like the other durability-path failures in this
        // file rather than swallowing it. Fire-and-forget: never let it reject.
        void entry.persistence?.flushFullState().catch((err: unknown) => {
          this.emitStructuredClientRecoveryEvent({
            event: 'ok-pool-flush-on-hide-failed',
            ...this.recoveryTelemetryBase(entry.docName),
            errorName: err instanceof Error ? err.name : 'non-error-throw',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /**
   * Re-run the sync handshake for every active doc when the tab returns to
   * the foreground. A backgrounded tab can miss server-pushed updates
   * (throttled delivery, a dropped frame, a brief disconnect); `forceSync`
   * pulls whatever the client is behind on so the doc reconverges.
   *
   * Only docs that have completed a sync are re-synced. `forceSync()` calls
   * `resetUnsyncedChanges()`, which sets `unsyncedChanges` to 1
   * unconditionally and only returns to 0 when the server answers — so firing
   * it at a provider that cannot answer LATCHES every clean doc dirty for as
   * long as the disconnect lasts. That pins `hasAnyUnsyncedWork()` true, which
   * holds desktop background-throttling suppressed (battery) and makes
   * `flushOnHide` force-sync every doc on every hide. Nothing is lost by
   * skipping: a provider that is connecting or reconnecting runs the full sync
   * handshake itself once the socket is up.
   */
  resyncOnVisible(): void {
    if (!this.flushOnHideEnabled) return;
    // Same stand-down as `flushOnHide`: the recycle flow owns re-delivery for
    // the epoch being recycled away, so a forceSync here races it. It would
    // also latch `unsyncedChanges` on providers about to be destroyed, which is
    // the exact spurious-latch this method's docblock exists to avoid.
    if (this.mismatchInFlight !== null) return;
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'active') continue;
      if (entry.syncState !== 'synced') continue;
      entry.provider.forceSync();
    }
  }

  /**
   * True while any open doc holds edits the server has not yet acked.
   *
   * Over-reports (true) rather than under-reports: this keys the desktop
   * background-throttle toggle, and keeping timers alive a moment too long is
   * safe (a little less battery), while throttling mid-sync is not. A doc
   * that closes while still dirty is the one residual over-report window.
   */
  hasAnyUnsyncedWork(): boolean {
    for (const entry of this._entries.values()) {
      if (entry.kind === 'active' && entry.provider.unsyncedChanges > 0) return true;
    }
    return false;
  }

  /**
   * Subscribe to unsynced-work edges (see `hasAnyUnsyncedWork`). The callback
   * fires whenever any provider's `unsyncedChanges` count moves and once when
   * a doc opens; the subscriber recomputes `hasAnyUnsyncedWork()` and dedupes
   * the true↔false transition itself. Returns an unsubscribe.
   */
  addUnsyncedWorkListener(cb: () => void): () => void {
    this.unsyncedWorkListeners.add(cb);
    return () => {
      this.unsyncedWorkListeners.delete(cb);
    };
  }

  private emitUnsyncedWork(): void {
    // Isolated per listener. This runs inside a provider's `unsyncedChanges`
    // handler, so an unguarded throw would abandon the remaining listeners AND
    // propagate into the pool's provider event loop. The desktop subscriber
    // calls an Electron IPC proxy, a cross-process boundary the renderer
    // cannot enforce, and the install-time capability check cannot speak for a
    // proxy that throws later. Reported rather than swallowed: a listener that
    // is failing is a real signal, it just must not take sync bookkeeping with
    // it.
    for (const cb of this.unsyncedWorkListeners) {
      try {
        cb();
      } catch (err) {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-pool-unsynced-work-listener-threw',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    this.visibleDocNames.clear();
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
    // Epoch-transition dedupe is per-pool: a fresh pool holds no providers
    // that could still report these claims.
    this.handledStaleClaims.clear();
    // In-memory lineage records die with the pool; the storage envelope
    // deliberately survives — a fresh pool (new tab, HMR remount) re-reads
    // and instance-validates it, which is the cross-tab channel the
    // doc-lineage fence's fresh-pool door depends on.
    this.docLineageEpochs.clear();
    this.docLineageEpochsEnvelopeConsumed = false;
    this.onBranchMismatch = null;
    this.branchMismatchInFlight = null;
    // Same reset as its branch-side sibling: a disposed pool must not report
    // a recycle as in flight, or the stand-down would latch on forever.
    this.mismatchInFlight = null;
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
    // Pool-level subscriptions and toggles are mutable fields like any other:
    // a disposed pool that still fans unsynced-work edges out to a previous
    // mount's subscriber, or that carries a previous run's kill-switch value,
    // is exactly the stale-state bleed this block exists to prevent.
    this.unsyncedWorkListeners.clear();
    this.flushOnHideEnabled = true;
  }

  private evictLru(): boolean {
    // Visible panes and the focused document are both protected. Their
    // providers back live editor trees, so evicting either would orphan a
    // mounted Y.Doc under split-view pressure.
    for (const docName of this.lruOrder) {
      if (!this.isProtected(docName)) {
        mark('ok/pool/evict-lru', { docName });
        this.close(docName);
        return true;
      }
    }
    return false;
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
    torn.serverDrivenCloseReauthAttempts = 0;

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
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-recycle-entry',
      docName,
      wasActive,
    });

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
