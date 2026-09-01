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

export const TAB_REPLAY_ORIGIN = Object.freeze({ kind: 'tab-replay' } as const);

interface BufferedReplayUpdate {
  readonly delta: Uint8Array;
  readonly fullState: Uint8Array | null;
  readonly branch: string;
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

const SERVER_DRIVEN_CLOSE_REAUTH_CEILING = 5;

interface PoolEntryBase {
  provider: HocuspocusProvider;
  docName: string;
  lastAccessedAt: number;
  poolEventId: string;
  syncState: SyncState;
  hasSynced: boolean;
  bridgeSetupFailed: boolean;
  lastServerSyncedSV: Uint8Array | null;
  lastDiskAckedSV: Uint8Array | null;
  lineageEpochRecordAtOpen: string | null;
}

interface ActivePoolEntry extends PoolEntryBase {
  kind: 'active';
  persistence: ClientPersistenceProvider | null;
  observerCleanup: (() => void) | null;
  observerFireCounterCleanup: (() => void) | null;
  pendingRecycleTimer: ReturnType<typeof setTimeout> | null;
  persistenceAttachOwned: boolean;
  serverDrivenCloseReauthInFlight: boolean;
  serverDrivenCloseReauthAttempts: number;
}

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

const RECYCLE_DEBOUNCE_MS = 4_000;
const CLEAR_DATA_TIMEOUT_MS = 10_000;

function hasMaterializedLocalContent(doc: Y.Doc): boolean {
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

const LAST_OBSERVED_BRANCH_KEY = 'ok-last-observed-branch';

const DOC_LINEAGE_EPOCHS_KEY = 'ok-doc-lineage-epochs';

const FORCE_SYNC_INTERVAL_MS = 5_000;

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

export class ProviderPool {
  private readonly _entries = new Map<string, PoolEntry>();
  get entries(): ReadonlyMap<string, PoolEntry> {
    return this._entries;
  }
  private lruOrder: string[] = [];
  private activeDocName: string | null = null;
  private visibleDocNames = new Set<string>();
  private readonly maxSize: number;
  private readonly wsUrl: string;
  private readonly recycleDebounceMs: number;
  private readonly clearDataTimeoutMs: number;
  private flushOnHideEnabled = true;
  private readonly unsyncedWorkListeners = new Set<() => void>();
  private onChange: PoolChangeCallback | null = null;
  private tabIdentity: { principalId: string; tabSessionId: string } | null = null;
  private serverRestartRecoveryState: ServerRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
  private cachedServerInstanceId: string | null = null;
  private pendingServerInstanceKnown: {
    promise: Promise<string>;
    resolve: (id: string) => void;
  } | null = null;
  private recoveryMismatchStaleClaim: string | undefined;
  private readonly handledStaleClaims = new Set<string>();
  private readonly bufferedUpdates = new Map<string, BufferedReplayUpdate>();
  private readonly pendingClears = new Map<string, Promise<void>>();
  private readonly clearFailures = new Set<string>();
  private readonly persistenceFactory: ClientPersistenceFactory;
  private readonly peekStoredEpoch: PeekStoredLineageEpoch;

  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

  private readonly lastObservedBranchKey: string;
  private readonly docLineageEpochsKey: string;

  private readonly storageNamespace: string | null;

  constructor(
    maxSize: number,
    wsUrl: string,
    options?: {
      recycleDebounceMs?: number;
      clearDataTimeoutMs?: number;
      storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
      storageNamespace?: string | null;
      persistenceFactory?: ClientPersistenceFactory;
      peekStoredLineageEpoch?: PeekStoredLineageEpoch;
    },
  ) {
    this.maxSize = maxSize;
    this.wsUrl = wsUrl;
    this.recycleDebounceMs = options?.recycleDebounceMs ?? RECYCLE_DEBOUNCE_MS;
    this.clearDataTimeoutMs = options?.clearDataTimeoutMs ?? CLEAR_DATA_TIMEOUT_MS;
    this.persistenceFactory = options?.persistenceFactory ?? createClientPersistence;
    this.peekStoredEpoch = options?.peekStoredLineageEpoch ?? peekStoredLineageEpoch;
    if (options?.storage !== undefined) {
      this.storage = options.storage;
    } else {
      this.storage =
        typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
    }
    const storageNamespace = options?.storageNamespace ?? null;
    this.storageNamespace = storageNamespace;
    this.lastObservedBranchKey = scopedStorageKey(LAST_OBSERVED_BRANCH_KEY, storageNamespace);
    this.docLineageEpochsKey = scopedStorageKey(DOC_LINEAGE_EPOCHS_KEY, storageNamespace);
  }

  setTabIdentity(identity: { principalId: string; tabSessionId: string }): void {
    this.tabIdentity = identity;
  }

  setExpectedServerInstanceId(id: string | null): void {
    const observed = id !== null && id.length > 0 ? id : null;
    const known =
      this.cachedServerInstanceId !== null && this.cachedServerInstanceId.length > 0
        ? this.cachedServerInstanceId
        : null;

    if (known !== null && observed === known) return;

    if (known !== null && observed !== null) {
      this.handleServerInstanceMismatch(known);
      this.cachedServerInstanceId = observed;
      this.resolvePendingServerInstanceKnown(observed);
      return;
    }

    this.cachedServerInstanceId = id;
    if (observed === null) return;
    this.resolvePendingServerInstanceKnown(observed);
    this.attachDeferredPersistence(observed);
  }

  private resolvePendingServerInstanceKnown(id: string): void {
    if (this.pendingServerInstanceKnown === null) return;
    const pending = this.pendingServerInstanceKnown;
    this.pendingServerInstanceKnown = null;
    pending.resolve(id);
  }

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

  private async validateStoredStateThenAttach(
    entry: ActivePoolEntry,
    serverInstanceId: string,
  ): Promise<void> {
    if (entry.persistenceAttachOwned) return;
    entry.persistenceAttachOwned = true;
    const docName = entry.docName;
    const entryIsCurrent = (): boolean =>
      this._entries.get(docName) === entry &&
      entry.kind === 'active' &&
      entry.persistence === null &&
      !this.pendingClears.has(docName);
    if (!entryIsCurrent()) return;
    let storedEpoch: string | null;
    try {
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
    void this.runCloseAndClearPersistence(docName);
    const reopened = this.open(docName);
    if (reopened !== null && wasActive) this.setActive(docName);
  }

  private attachValidatedPersistence(entry: ActivePoolEntry, serverInstanceId: string): void {
    const docName = entry.docName;
    try {
      const persistence = this.buildPersistence(serverInstanceId, docName, entry.provider.document);
      entry.persistence = persistence;
      this.notify();
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
    for (const entry of Array.from(this._entries.values())) {
      if (entry.kind !== 'active') continue;
      if (entry.persistence !== null) continue;
      if (this._entries.get(entry.docName) !== entry) continue;
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
      void this.validateStoredStateThenAttach(entry, serverInstanceId);
    }
  }

  getServerRestartRecoveryState(): ServerRestartRecoveryState {
    return this.serverRestartRecoveryState;
  }

  observeDiskAck(docName: string, sv: Uint8Array): void {
    const entry = this.entries.get(docName);
    if (!entry || entry.kind !== 'active') return;
    entry.lastDiskAckedSV = mergeStateVectors(entry.lastDiskAckedSV, sv);
  }

  observeDiskAckBatch(svsByDocName: Record<string, Uint8Array>): void {
    for (const [docName, sv] of Object.entries(svsByDocName)) {
      this.observeDiskAck(docName, sv);
    }
  }

  private lastObservedBranch: string | null = null;
  private lastObservedBranchInitialized = false;

  private getOrInitObservedBranch(): string | null {
    if (this.lastObservedBranchInitialized) return this.lastObservedBranch;
    this.lastObservedBranchInitialized = true;
    try {
      const stored = this.storage?.getItem(this.lastObservedBranchKey) ?? null;
      if (stored !== null && stored.length > 0) {
        this.lastObservedBranch = stored;
      }
    } catch {}
    return this.lastObservedBranch;
  }

  private persistObservedBranch(branch: string | null): void {
    this.lastObservedBranch = branch;
    this.lastObservedBranchInitialized = true;
    try {
      if (branch === null || branch.length === 0) {
        this.storage?.removeItem(this.lastObservedBranchKey);
      } else {
        this.storage?.setItem(this.lastObservedBranchKey, branch);
      }
    } catch {}
  }

  private readonly docLineageEpochs = new Map<string, string>();
  private docLineageEpochsEnvelopeConsumed = false;

  private normalizedObservedBranch(): string {
    return this.getOrInitObservedBranch() ?? UNKNOWN_BRANCH_SENTINEL;
  }

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
    } catch {}
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
    if (this.storageNamespace !== null) {
      base.project = projectDigest(this.storageNamespace);
    }
    return base;
  }

  private emitStructuredClientRecoveryEvent(parts: Record<string, string | number>): void {
    console.warn(JSON.stringify(parts));
  }

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

  setObservedBranch(branch: string): void {
    this.persistObservedBranch(branch);
  }

  compareAndUpdateObservedBranch(branch: string): boolean {
    const prior = this.getOrInitObservedBranch();
    this.persistObservedBranch(branch);
    return prior !== null && prior !== branch;
  }

  private onBranchMismatch: (() => void) | null = null;
  private branchMismatchInFlight: Promise<void> | null = null;
  private mismatchInFlight: Promise<void> | null = null;
  setOnBranchMismatch(cb: (() => Promise<void>) | null): void {
    if (cb === null) {
      this.onBranchMismatch = null;
      return;
    }
    this.onBranchMismatch = () => {
      if (this.branchMismatchInFlight !== null) return;
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

  setOnChange(cb: PoolChangeCallback | null): void {
    this.onChange = cb;
  }

  private notify(): void {
    this.onChange?.();
  }

  private evictListeners = new Set<(docName: string) => void>();

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

  private touch(docName: string): void {
    const idx = this.lruOrder.indexOf(docName);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
    this.lruOrder.push(docName);
  }

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
    const protectedCount =
      this.visibleDocNames.size +
      (this.activeDocName !== null && !this.visibleDocNames.has(this.activeDocName) ? 1 : 0);
    return Math.max(this.maxSize, protectedCount);
  }

  private trimToCapacity(): void {
    while (this.entries.size > this.effectiveCapacity() && this.evictLru()) {}
  }

  open(docName: string): PoolEntry | null {
    if (isSystemDoc(docName)) return null;

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
      const reopened = this.entries.get(docName);
      if (reopened !== undefined) return reopened;
    }

    const existing = this.entries.get(docName);
    if (existing) {
      const previousAccessedAt = existing.lastAccessedAt;
      existing.lastAccessedAt = Date.now();
      this.touch(docName);
      this.notify();
      mark('ok/pool/open', {
        docName,
        hit: true,
        lastAccessedAt: previousAccessedAt,
        poolEventId: existing.poolEventId,
      });
      mark.count('ok/pool/open', { hit: true });
      return existing;
    }

    const openStartMs = Date.now();

    if (this.entries.size >= this.effectiveCapacity()) {
      this.evictLru();
    }

    const expectedServerInstanceId = this.cachedServerInstanceId;
    const lineageEpochRecordAtOpen = this.getRecordedLineageEpoch(docName);
    const token = buildAuthToken(
      this.tabIdentity,
      expectedServerInstanceId,
      this.getOrInitObservedBranch(),
      expectedServerInstanceId !== null && expectedServerInstanceId.length > 0
        ? lineageEpochRecordAtOpen
        : null,
    );
    const provider = new HocuspocusProvider({
      url: appendTraceContextToCollabUrl(this.wsUrl),
      name: docName,
      forceSyncInterval: FORCE_SYNC_INTERVAL_MS,
      token,
    });

    const persistenceServerInstanceId = this.cachedServerInstanceId;
    if (this.clearFailures.has(docName)) {
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
    mark('ok/pool/open', { docName, hit: false, poolEventId });
    mark.count('ok/pool/open', { hit: false });

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
      entry.lastServerSyncedSV = captureStateVector(provider.document);
      const syncedLineageEpoch = provider.document.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
      if (typeof syncedLineageEpoch === 'string' && syncedLineageEpoch.length > 0) {
        this.recordLineageEpoch(docName, syncedLineageEpoch);
      }
      if (entry.pendingRecycleTimer) {
        clearTimeout(entry.pendingRecycleTimer);
        entry.pendingRecycleTimer = null;
      }
      entry.serverDrivenCloseReauthAttempts = 0;
      this.markServerRestartRecoverySynced(docName);
      this.notify();

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
          if (entry.kind !== 'active') return;
          entry.pendingRecycleTimer = null;
          if (this.entries.get(docName) !== entry) return;
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

    const onAuthenticationFailed = ({ reason }: { reason: string }): void => {
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
        if (expectedServerInstanceId === null) {
          return;
        }
        this.handleServerInstanceMismatch(expectedServerInstanceId);
        return;
      }
      if (typed === 'branch-mismatch') {
        this.onBranchMismatch?.();
        return;
      }
      if (typed === 'rename-redirect') {
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
        this.deleteLineageEpochRecord(docName);
        const existing = this.entries.get(docName);
        const hadOpenProvider = existing !== undefined && existing.kind === 'active';
        this.onDocDeleted?.({ docName, hadOpenProvider });
        return;
      }
      if (typed === 'doc-lineage-mismatch') {
        if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
        this.deleteLineageEpochRecord(docName);
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-doc-lineage-mismatch',
          ...this.recoveryTelemetryBase(docName),
          via: 'auth-rejection',
          staleEpoch: entry.lineageEpochRecordAtOpen ?? '',
        });
        const wasActive = this.activeDocName === docName;
        void this.runCloseAndClearPersistence(docName);
        const reopened = this.open(docName);
        if (reopened !== null && wasActive) this.setActive(docName);
        return;
      }
      const _never: never = typed;
      void _never;
    };

    const onServerDrivenClose = ({ event }: { event?: { code?: number; reason?: string } }) => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      if (!event?.reason) return;
      if (entry.serverDrivenCloseReauthInFlight) return;
      if (entry.serverDrivenCloseReauthAttempts >= SERVER_DRIVEN_CLOSE_REAUTH_CEILING) {
        if (entry.serverDrivenCloseReauthAttempts === SERVER_DRIVEN_CLOSE_REAUTH_CEILING) {
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
    provider.on('unsyncedChanges', () => this.emitUnsyncedWork());
    this.emitUnsyncedWork();

    const staleClaimAtReplayInstall = this.recoveryMismatchStaleClaim;
    const runReplay = async (): Promise<void> => {
      if (entry.kind !== 'active' || this.entries.get(docName) !== entry) return;
      const branch = this.normalizedObservedBranch();

      let source: { delta: Uint8Array; fullState: Uint8Array | null };
      let tokenBranch = branch;
      let tokenBacked: boolean;
      const buffered = this.bufferedUpdates.get(docName);
      if (buffered !== undefined) {
        if (buffered.branch !== branch) {
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

      if (tokenBacked) {
        let claimed: boolean;
        try {
          claimed = await consumeReplayOutboxEntry({
            branch: tokenBranch,
            docName,
            namespace: this.storageNamespace,
          });
        } catch (err: unknown) {
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

    if (
      persistence === null &&
      persistenceServerInstanceId !== null &&
      persistenceServerInstanceId.length > 0 &&
      pendingClearForDocName === undefined
    ) {
      void this.validateStoredStateThenAttach(entry, persistenceServerInstanceId);
    }

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

  private handleServerInstanceMismatch(staleClaimedServerInstanceId: string): void {
    if (this.handledStaleClaims.has(staleClaimedServerInstanceId)) {
      this.emitStructuredClientBreadcrumb({
        event: 'ok-pool-mismatch-transition-deduped',
        reason: 'claim-already-handled',
        staleClaim: staleClaimedServerInstanceId,
      });
      return;
    }
    this.handledStaleClaims.add(staleClaimedServerInstanceId);
    if (this.cachedServerInstanceId === staleClaimedServerInstanceId) {
      this.cachedServerInstanceId = null;
    }
    if (this.mismatchInFlight !== null) {
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

    const snapshot = Array.from(this.entries.entries());
    this.emitStructuredClientBreadcrumb({
      event: 'ok-pool-mismatch-recycle-begin',
      entryCount: snapshot.length,
      branch: this.normalizedObservedBranch(),
    });
    const startedAt = Date.now();
    const recoveryBranch = this.normalizedObservedBranch();
    const outboxWrites: Promise<void>[] = [];
    const recoveryActiveDocName = this.activeDocName;
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
        mark('ok/pool/buffer-overflow', { docName, bytes: unsynced.byteLength });
        continue;
      }
      if (unsynced.byteLength > 0) {
        const fullState = Y.encodeStateAsUpdate(poolEntry.provider.document);
        const fullStateForBuffer = fullState.byteLength > MAX_BUFFER_BYTES ? null : fullState;
        const buffered: BufferedReplayUpdate = {
          delta: unsynced,
          fullState: fullStateForBuffer,
          branch: recoveryBranch,
          durable: false,
        };
        this.bufferedUpdates.set(docName, buffered);
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

    const toClear: { docName: string; persistence: ClientPersistenceProvider }[] = [];
    for (const [docName, poolEntry] of snapshot) {
      if (poolEntry.kind !== 'active') continue;
      if (poolEntry.persistence === null) continue;
      toClear.push({ docName, persistence: poolEntry.persistence });
    }

    const runClearsAndRecycle = (): Promise<void> => {
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
        this.handledStaleClaims.clear();
      }
    });
    this.mismatchInFlight = inflight;
  }

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
      const ytextClean =
        normalizeBridge(oursYtextBody) === theirsNorm && !addsBlankLines(theirsBody, oursYtextBody);
      const fragClean =
        normalizeBridge(oursFragBody) === theirsNorm && !addsBlankLines(theirsBody, oursFragBody);
      if (ytextClean && fragClean) return true;
      let ours: string;
      if (ytextClean) {
        ours = composeWithDerivedBody(oursFm, oursFragBody).md;
      } else if (fragClean) {
        ours = oursYtext;
      } else {
        this.emitStructuredClientRecoveryEvent({
          event: 'ok-buffer-replay-diverged',
          ...this.recoveryTelemetryBase(docName),
        });
        return false;
      }
      if (ours !== theirs) {
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

  awaitMismatchSettled(): Promise<void> {
    return this.mismatchInFlight ?? Promise.resolve();
  }

  isMismatchRecycleInFlight(): boolean {
    return this.mismatchInFlight !== null;
  }

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

  prewarm(docName: string): PoolEntry | null {
    if (isSystemDoc(docName)) return null;
    const existing = this.entries.get(docName);
    if (existing) {
      return existing;
    }
    const entry = this.open(docName);
    if (!entry) return null;
    const idx = this.lruOrder.indexOf(docName);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
      this.lruOrder.unshift(docName);
    }
    return entry;
  }

  close(docName: string): void {
    const entry = this.entries.get(docName);
    if (!entry) return;

    this.destroyEntry(entry);
    this._entries.delete(docName);
    this.lruOrder = this.lruOrder.filter((n) => n !== docName);
    this.discardBufferedUpdate(docName);

    if (this.activeDocName === docName) {
      this.activeDocName = null;
    }
    this.notify();
  }

  async closeAndClearPersistence(docName: string): Promise<void> {
    try {
      await this.runCloseAndClearPersistence(docName);
    } catch {}
  }

  private runCloseAndClearPersistence(docName: string): Promise<void> {
    const inFlight = this.pendingClears.get(docName);
    if (inFlight !== undefined) {
      return inFlight;
    }
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
    this.clearFailures.delete(docName);
    const entry = this.entries.get(docName);
    if (entry?.kind === 'active' && entry.persistence !== null) {
      const persistence = entry.persistence;
      try {
        this.close(docName);
      } catch (err) {
        console.warn(`[ProviderPool] close before clearData threw for ${docName}:`, err);
      }
      try {
        await this.withClearDataTimeout(docName, persistence.clearData());
      } catch (err) {
        console.warn(`[ProviderPool] clearData on rename failed for ${docName}:`, err);
        this.clearFailures.add(docName);
        throw err;
      }
      return;
    }
    if (entry) {
      try {
        this.close(docName);
      } catch (err) {
        console.warn(`[ProviderPool] close before IDB-by-name delete threw for ${docName}:`, err);
      }
    }

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

  clearBufferedUpdates(): void {
    for (const docName of Array.from(this.bufferedUpdates.keys())) {
      this.discardBufferedUpdate(docName);
    }
  }

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

  clearActive(): void {
    if (this.activeDocName === null) return;
    this.activeDocName = null;
    this.notify();
  }

  getActive(): PoolEntry | null {
    if (!this.activeDocName) return null;
    return this.entries.get(this.activeDocName) ?? null;
  }

  getActiveDocName(): string | null {
    return this.activeDocName;
  }

  has(docName: string): boolean {
    return this.entries.has(docName);
  }

  peek(docName: string): PoolEntry | null {
    return this.entries.get(docName) ?? null;
  }

  setFlushOnHideEnabled(enabled: boolean): void {
    this.flushOnHideEnabled = enabled;
  }

  flushOnHide(): void {
    if (!this.flushOnHideEnabled) return;
    if (this.mismatchInFlight !== null) return;
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'active') continue;
      if (entry.provider.unsyncedChanges > 0) {
        entry.provider.forceSync();
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

  resyncOnVisible(): void {
    if (!this.flushOnHideEnabled) return;
    if (this.mismatchInFlight !== null) return;
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'active') continue;
      if (entry.syncState !== 'synced') continue;
      entry.provider.forceSync();
    }
  }

  hasAnyUnsyncedWork(): boolean {
    for (const entry of this._entries.values()) {
      if (entry.kind === 'active' && entry.provider.unsyncedChanges > 0) return true;
    }
    return false;
  }

  addUnsyncedWorkListener(cb: () => void): () => void {
    this.unsyncedWorkListeners.add(cb);
    return () => {
      this.unsyncedWorkListeners.delete(cb);
    };
  }

  private emitUnsyncedWork(): void {
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

  recycle(docName: string): void {
    this.recycleDisconnectedEntry(docName);
  }

  dispose(): void {
    for (const entry of this._entries.values()) {
      this.destroyEntry(entry);
    }
    this._entries.clear();
    this.lruOrder = [];
    this.activeDocName = null;
    this.visibleDocNames.clear();
    this.onChange = null;
    this.bufferedUpdates.clear();
    this.pendingClears.clear();
    this.clearFailures.clear();
    this.handledStaleClaims.clear();
    this.docLineageEpochs.clear();
    this.docLineageEpochsEnvelopeConsumed = false;
    this.onBranchMismatch = null;
    this.branchMismatchInFlight = null;
    this.mismatchInFlight = null;
    this.onRenameRedirect = null;
    this.onDocDeleted = null;
    this.evictListeners.clear();
    this.serverRestartRecoveryState = IDLE_SERVER_RESTART_RECOVERY;
    this.cachedServerInstanceId = null;
    this.pendingServerInstanceKnown = null;
    this.tabIdentity = null;
    this.recoveryMismatchStaleClaim = undefined;
    this.unsyncedWorkListeners.clear();
    this.flushOnHideEnabled = true;
  }

  private evictLru(): boolean {
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
    if (entry.kind === 'tearing-down') return;

    const observerCleanup = entry.observerCleanup;
    const observerFireCounterCleanup = entry.observerFireCounterCleanup;
    const persistence = entry.persistence;
    const pendingRecycleTimer = entry.pendingRecycleTimer;
    const docName = entry.docName;

    const torn = entry as unknown as TearingDownPoolEntry;
    torn.kind = 'tearing-down';
    torn.persistence = null;
    torn.observerCleanup = null;
    torn.observerFireCounterCleanup = null;
    torn.pendingRecycleTimer = null;
    torn.serverDrivenCloseReauthInFlight = false;
    torn.serverDrivenCloseReauthAttempts = 0;

    if (pendingRecycleTimer) clearTimeout(pendingRecycleTimer);

    invalidateSyncPromise(docName);
    this.fireEvict(docName);
    try {
      observerCleanup?.();
    } catch (err) {
      console.warn(`[ProviderPool] observer cleanup threw for ${docName}:`, err);
    }
    try {
      observerFireCounterCleanup?.();
    } catch (err) {
      console.warn(`[ProviderPool] observer-fire-counter cleanup threw for ${docName}:`, err);
    }
    clearObserverFireCounter(docName);

    if (persistence !== null) {
      const pendingPersistenceDestroy = persistence.destroy();
      pendingPersistenceDestroy.catch((err) => {
        console.warn(`[ProviderPool] persistence destroy failed for ${docName}:`, err);
      });
    }

    try {
      torn.provider.destroy();
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
      const reopened = this.open(docName);
      if (reopened) this.setActive(docName);
      return;
    }

    this.notify();
  }
}
