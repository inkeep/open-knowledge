import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentCliCommandName, type ReconcileMergeOutcome } from '@inkeep/open-knowledge-core';
import { atomicTempPath } from '@inkeep/open-knowledge-core/server';
import { type Doc, getState } from 'yjs';
import { type DiskReceipt, DiskReceiptLog, type FileObservation } from './disk-receipts.ts';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  incrementInFlightFlushExpired,
  incrementReceiptAtLoad,
  incrementStaleExternalWriteRefused,
  type ReceiptAtLoad,
  type StorePendingReason,
} from './metrics.ts';
import { contentHash } from './version-hash.ts';

export interface WrittenThrough {
  readonly clientId: number;
  readonly clock: number;
}

export function writtenThroughOf(document: Doc): WrittenThrough {
  return { clientId: document.clientID, clock: getState(document.store, document.clientID) };
}

export function editWasCarried(
  write: WrittenThrough | undefined,
  carried: WrittenThrough | null,
): boolean {
  return (
    write !== undefined &&
    carried !== null &&
    write.clientId === carried.clientId &&
    write.clock <= carried.clock
  );
}

export type RenameCarryAnswer =
  | { readonly kind: 'settled'; readonly carried: WrittenThrough | null }
  | { readonly kind: 'unsettled' }
  | { readonly kind: 'stopped' };

export type HeldSaveReason =
  | StorePendingReason
  | 'pending-unsettled'
  | 'pending-rename'
  | 'pending-no-history-or-backup'
  | 'pending-not-utf8';

export type StoreIntakeMerge = ReconcileMergeOutcome | 'disk-replaced';

const STORE_INTAKE_RECORDS_KEPT = 8;

const STORE_INTAKE_STRENGTH: Readonly<Record<StoreIntakeMerge, number>> = {
  clean: 0,
  merged: 1,
  'kept-live': 2,
  'both-kept': 3,
  'disk-replaced': 4,
};

interface StoreIntakeRecord {
  readonly merge: StoreIntakeMerge;
  readonly through: WrittenThrough;
}

type RenameCarry =
  | {
      readonly state: 'pending';
      ended: boolean;
      readonly answer: PromiseWithResolvers<RenameCarryAnswer>;
    }
  | { readonly state: 'settled'; readonly carried: WrittenThrough | null };

export interface StoreFailure {
  code?: string;
  message: string;
  removal?: StoreFailureRemoval;
  held?: {
    readonly reason: HeldSaveReason;
    readonly causeCode?: string;
    readonly noBase?: true;
  };
  dropped?: WriteDropCause;
}

export type WriteDropCause = 'legacy-name' | 'unresolvable' | 'container-gone' | 'intake-landed';

export type StoreFailureRemoval =
  | { kind: 'renamed'; renamedTo: string; carry?: Promise<RenameCarryAnswer> }
  | { kind: 'path-occupied' }
  | { kind: 'deleted-outside' };

export interface StoreAttemptToken {
  readonly docName: string;
  readonly generation: number;
}

export type StorePublishOutcome = 'published' | 'stale' | 'reentrant';

export type DeferredStoreDiscardCause =
  | { readonly kind: 'branch-switch' }
  | {
      readonly kind: 'renamed-outside';
      readonly to: string;
      readonly carry?: Promise<RenameCarryAnswer>;
    }
  | { readonly kind: 'deleted-outside' }
  | { readonly kind: 'shutdown' };

export type DeferredStoreOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly failure: StoreFailure }
  | { readonly kind: 'discarded'; readonly cause: DeferredStoreDiscardCause };

export type DeferredStoreWait = DeferredStoreOutcome | { readonly kind: 'unsettled' };

export interface DeferredStoreSettlement {
  settle(outcome: DeferredStoreOutcome): void;
}

export function assertNeverStorePublishOutcome(outcome: never): never {
  throw new Error(`[StorePublishOutcome] unhandled variant: ${JSON.stringify(outcome)}`);
}

export function assertNeverDeferredStoreWait(wait: never): never {
  throw new Error(`[DeferredStoreWait] unhandled variant: ${JSON.stringify(wait)}`);
}

export const OK_DOC_REMOVED = 'OK_DOC_REMOVED';
export const OK_PATH_UNRESOLVABLE = 'OK_PATH_UNRESOLVABLE';
export const OK_STORE_REFUSED = 'OK_STORE_REFUSED';
export const OK_STORE_HELD = 'OK_STORE_HELD';
export const OK_STORE_DISCARDED = 'OK_STORE_DISCARDED';
export const OK_DOC_MOVED = 'OK_DOC_MOVED';
export const OK_SERVER_STOPPED = 'OK_SERVER_STOPPED';
export const OK_WRITE_REPLACED = 'OK_WRITE_REPLACED';
export const OK_WRITE_DROPPED = 'OK_WRITE_DROPPED';

const IN_FLIGHT_FLUSH_TTL_MS = 60_000;

export const WRITE_WAIT_BUDGET_MS = 20_000;

export const DISPLACED_VERSION_TTL_MS = 30 * 60_000;
export const DISPLACED_VERSION_LIMIT = 8;

interface PendingFlush {
  value: string;
  at: number;
}

interface DisplacedVersion {
  hash: string;
  at: number;
}

export interface StaleExternalWriteConflict {
  docName: string;
  file: string;
  diskHash: string;
  diskContent: string;
  retainedContent?: string;
  detectedAt: string;
}

interface PersistedDocumentDurability {
  docName: string;
  acknowledgedContent: string;
  displacedVersions: DisplacedVersion[];
  staleExternalWrite?: StaleExternalWriteConflict;
}

interface PersistedDocumentDurabilityState {
  version: 1;
  branches: Record<string, PersistedDocumentDurability[]>;
}

interface CachedDurabilityDocument {
  acknowledgedContent: string;
  displacedVersions: DisplacedVersion[] | undefined;
  staleExternalWrite: StaleExternalWriteConflict | undefined;
  expiresAt: number;
  serialized: string;
}

function nextDisplacedExpiry(versions: readonly DisplacedVersion[]): number {
  return versions.reduce(
    (next, entry) => Math.min(next, entry.at + DISPLACED_VERSION_TTL_MS),
    Number.POSITIVE_INFINITY,
  );
}

function snapshotParts(branches: ReadonlyMap<string, string[]>): string[] {
  const parts = ['{"version":1,"branches":{'];
  for (const [branch, documents] of Object.entries(Object.fromEntries(branches))) {
    if (parts.length > 1) parts.push(',');
    parts.push(JSON.stringify(branch), ':[');
    for (const [index, document] of documents.entries()) {
      if (index > 0) parts.push(',');
      parts.push(document);
    }
    parts.push(']');
  }
  parts.push('}}');
  return parts;
}

function isThenable(
  value: unknown,
): value is { then: (onFulfilled: () => void, onRejected: (cause: unknown) => void) => unknown } {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function logRefusedPublishRejection(token: StoreAttemptToken, cause: unknown): void {
  let reason: string;
  try {
    reason = cause instanceof Error ? String(cause.message) : String(cause);
  } catch {
    reason = 'unserializable rejection reason';
  }
  console.warn(
    JSON.stringify({
      event: 'persistence-store-publish-async-rejected',
      'doc.name': token.docName,
      generation: token.generation,
      error: reason,
    }),
  );
}

function sameStaleConflict(
  previous: StaleExternalWriteConflict | undefined,
  current: StaleExternalWriteConflict | undefined,
): boolean {
  return (
    previous?.docName === current?.docName &&
    previous?.file === current?.file &&
    previous?.diskHash === current?.diskHash &&
    previous?.diskContent === current?.diskContent &&
    previous?.retainedContent === current?.retainedContent &&
    previous?.detectedAt === current?.detectedAt
  );
}

export interface DocumentDurabilityStateOptions {
  persistencePath?: string;
  fileForDocName?: (docName: string) => string;
  onStaleExternalWriteChange?: () => void;
  onStoreRefused?: (docName: string) => void;
  hasResolvedExtension?: (docName: string) => boolean;
  receipts?: DiskReceiptLog;
}

export class DocumentDurabilityStateError extends Error {
  readonly kind: 'unreadable' | 'corrupt' | 'incompatible';
  readonly path: string;

  constructor(path: string, kind: 'unreadable' | 'corrupt' | 'incompatible', cause?: unknown) {
    const code =
      cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined;
    const recovery =
      kind === 'unreadable'
        ? code === 'EACCES' || code === 'EPERM'
          ? 'Check the snapshot and parent-directory permissions for the account running OpenKnowledge, then retry.'
          : code === 'EISDIR'
            ? 'The snapshot path must be a regular file, not a directory. Preserve that directory and restore the snapshot file to this path.'
            : 'Check the filesystem or mount and restore read access to this path, then retry.'
        : kind === 'incompatible'
          ? 'This build does not support the snapshot schema. Preserve the file and restore a compatible backup or contact support to identify a compatible build.'
          : 'Restore this snapshot from a known-good backup, or contact support to recover its protected edits.';
    super(
      `Cannot safely open this project: its stale-write recovery snapshot is ${kind}${code ? ` [${code}]` : ''} (${path}). The snapshot has been preserved because it may contain the only copy of protected edits. ${recovery} Run ${currentCliCommandName()} bug-report from the project directory to collect diagnostics without starting the server. Do not delete it to bypass recovery.`,
      { cause },
    );
    this.name = 'DocumentDurabilityStateError';
    this.kind = kind;
    this.path = path;
  }
}

function restoreEntry<T>(map: Map<string, T>, key: string, previous: T | undefined): void {
  if (previous === undefined) map.delete(key);
  else map.set(key, previous);
}

function isDisplacedVersion(value: unknown): value is DisplacedVersion {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.hash === 'string' && typeof entry.at === 'number';
}

function isStaleConflict(value: unknown): value is StaleExternalWriteConflict {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.docName === 'string' &&
    typeof entry.file === 'string' &&
    typeof entry.diskHash === 'string' &&
    typeof entry.diskContent === 'string' &&
    typeof entry.detectedAt === 'string' &&
    (entry.retainedContent === undefined || typeof entry.retainedContent === 'string')
  );
}

function parsePersistedState(value: unknown): PersistedDocumentDurabilityState | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  if (
    root.version !== 1 ||
    !root.branches ||
    typeof root.branches !== 'object' ||
    Array.isArray(root.branches)
  )
    return null;
  const branches = new Map<string, PersistedDocumentDurability[]>();
  for (const [branch, documents] of Object.entries(root.branches)) {
    if (!Array.isArray(documents)) return null;
    const parsed: PersistedDocumentDurability[] = [];
    for (const value of documents) {
      if (!value || typeof value !== 'object') return null;
      const document = value as Record<string, unknown>;
      if (
        typeof document.docName !== 'string' ||
        typeof document.acknowledgedContent !== 'string' ||
        !Array.isArray(document.displacedVersions) ||
        !document.displacedVersions.every(isDisplacedVersion) ||
        (document.staleExternalWrite !== undefined &&
          (!isStaleConflict(document.staleExternalWrite) ||
            document.staleExternalWrite.docName !== document.docName ||
            document.staleExternalWrite.diskHash !==
              contentHash(document.staleExternalWrite.diskContent)))
      ) {
        return null;
      }
      parsed.push({
        docName: document.docName,
        acknowledgedContent: document.acknowledgedContent,
        displacedVersions: document.displacedVersions,
        ...(document.staleExternalWrite ? { staleExternalWrite: document.staleExternalWrite } : {}),
      });
    }
    branches.set(branch, parsed);
  }
  return { version: 1, branches: Object.fromEntries(branches) };
}

export class DocumentDurabilityState {
  private readonly reconciledBaseByBranch = new Map<string, Map<string, string>>();
  private readonly displacedVersionsByBranch = new Map<string, Map<string, DisplacedVersion[]>>();
  private readonly staleExternalWritesByBranch = new Map<
    string,
    Map<string, StaleExternalWriteConflict>
  >();
  private readonly inFlightFlushByDoc = new Map<string, PendingFlush[]>();
  private readonly storeAttemptGenerations = new Map<string, number>();
  private readonly publishedStoreGenerations = new Map<string, number>();
  private readonly documentsWithPublishInFlight = new Set<string>();
  private readonly agentWriteStores = new Set<string>();
  private readonly refusedStoreDocNames = new Set<string>();
  private readonly storeFailures = new Map<string, StoreFailure>();
  private readonly storeIntakes = new Map<string, StoreIntakeRecord[]>();
  private readonly staleExternalWriteFreezes = new Set<string>();
  private readonly persistencePath: string | undefined;
  private readonly fileForDocName: (docName: string) => string;
  private readonly onStaleExternalWriteChange: (() => void) | undefined;
  private readonly onStoreRefused: ((docName: string) => void) | undefined;
  private readonly hasResolvedExtension: ((docName: string) => boolean) | undefined;
  private readonly receipts: DiskReceiptLog;
  private cachedDocumentsByBranch = new Map<string, Map<string, CachedDurabilityDocument>>();
  private lastPersistedParts = snapshotParts(new Map());
  private nextDisplacedExpiryAt = Number.POSITIVE_INFINITY;
  private activeBranch: string;
  private batchInProgress = false;
  private readonly batchHolders = new Set<string>();
  private readonly heldStores = new Set<string>();
  private readonly renameCarries = new Map<string, RenameCarry>();
  private writeAdmissionHolds = 0;
  private readonly writeAdmissionWaiters = new Set<() => void>();
  private readonly writeWaitDeadline = new AsyncLocalStorage<number>();
  private readonly deferredStoreOutcomes = new Map<string, Promise<DeferredStoreOutcome>>();

  constructor(initialBranch = 'main', options: DocumentDurabilityStateOptions = {}) {
    this.activeBranch = initialBranch;
    this.persistencePath = options.persistencePath;
    this.fileForDocName = options.fileForDocName ?? ((docName) => `${docName}.md`);
    this.onStaleExternalWriteChange = options.onStaleExternalWriteChange;
    this.onStoreRefused = options.onStoreRefused;
    this.hasResolvedExtension = options.hasResolvedExtension;
    this.receipts = options.receipts ?? new DiskReceiptLog();
    this.reconciledBaseByBranch.set(initialBranch, new Map());
    this.restore();
  }

  switchReconciledBaseScope(branch: string): void {
    this.persist();
    const carried = new Map(this.reconciledBaseByBranch.get(this.activeBranch) ?? []);
    const target = this.reconciledBaseByBranch.get(branch);
    if (target) {
      const branchScoped = new Set([
        ...(this.displacedVersionsByBranch.get(branch)?.keys() ?? []),
        ...(this.staleExternalWritesByBranch.get(branch)?.keys() ?? []),
      ]);
      for (const docName of branchScoped) {
        const own = target.get(docName);
        if (own !== undefined) carried.set(docName, own);
      }
    }
    this.activeBranch = branch;
    this.reconciledBaseByBranch.set(branch, carried);
  }

  getActiveBranch(): string {
    return this.activeBranch;
  }

  getReconciledBase(docName: string): string | undefined {
    return this.reconciledBaseByBranch.get(this.activeBranch)?.get(docName);
  }

  getReceipt(docName: string): DiskReceipt | undefined {
    return this.receipts.get(docName);
  }

  isRecentOwnWrite(docName: string, hash: string): boolean {
    return this.receipts.isRecentOwnWrite(docName, hash);
  }

  checkReceiptAtLoad(docName: string, diskContent: string): ReceiptAtLoad {
    const receipt = this.receipts.get(docName);
    const outcome: ReceiptAtLoad =
      receipt === undefined
        ? 'missing'
        : receipt.hash === contentHash(diskContent)
          ? 'unchanged'
          : 'changed';
    incrementReceiptAtLoad(outcome);
    return outcome;
  }

  refreshReceiptWithoutBase(docName: string, diskContent: string): void {
    if (this.getReconciledBase(docName) !== undefined) return;
    if (this.receipts.get(docName) === undefined) return;
    this.receipts.recordAgreed(docName, diskContent);
  }

  recordReceiptAgreed(docName: string, content: string, observation?: FileObservation): void {
    this.receipts.recordAgreed(docName, content, observation);
  }

  recordReceiptOwnWrite(docName: string, content: string, observation?: FileObservation): void {
    this.receipts.recordOwnWrite(docName, content, observation);
  }

  setReconciledBase(docName: string, content: string, observation?: FileObservation): void {
    this.receipts.recordAgreed(docName, content, observation);
    let bases = this.reconciledBaseByBranch.get(this.activeBranch);
    if (!bases) {
      bases = new Map();
      this.reconciledBaseByBranch.set(this.activeBranch, bases);
    }
    if (bases.get(docName) === content && Date.now() < this.nextDisplacedExpiryAt) return;
    const persist = this.isPersistedDocument(docName);
    if (!persist) {
      bases.set(docName, content);
      return;
    }
    this.mutateDocument(docName, () => bases.set(docName, content));
  }

  restoreReconciledBase(docName: string, previous: string | undefined): void {
    if (previous !== undefined) {
      this.setReconciledBase(docName, previous);
      return;
    }
    this.receipts.forget(docName);
    const bases = this.reconciledBaseByBranch.get(this.activeBranch);
    if (!bases?.has(docName)) return;
    if (!this.isPersistedDocument(docName)) {
      bases.delete(docName);
      return;
    }
    this.mutateDocument(docName, () => bases.delete(docName));
  }

  recordSuccessfulStore(
    docName: string,
    content: string,
    displacedContent?: string,
    observation?: FileObservation,
  ): void {
    this.receipts.recordOwnWrite(docName, content, observation);
    if (displacedContent === undefined) {
      this.setReconciledBase(docName, content);
      return;
    }
    const at = Date.now();
    const hash = contentHash(displacedContent);
    this.mutateDocument(docName, () => {
      let bases = this.reconciledBaseByBranch.get(this.activeBranch);
      if (!bases) {
        bases = new Map();
        this.reconciledBaseByBranch.set(this.activeBranch, bases);
      }
      let versions = this.displacedVersionsByBranch.get(this.activeBranch);
      if (!versions) {
        versions = new Map();
        this.displacedVersionsByBranch.set(this.activeBranch, versions);
      }
      const retained = (versions.get(docName) ?? []).filter(
        (entry) => entry.at > at - DISPLACED_VERSION_TTL_MS && entry.hash !== hash,
      );
      retained.push({ hash, at });
      bases.set(docName, content);
      versions.set(docName, retained.slice(-DISPLACED_VERSION_LIMIT));
    });
  }

  /**
   * STOP: at the moment of this call the doc must already be outside the staleness sweep's
   * candidate set — either not loaded, or holding a frozen lifecycle status. The sweep iterates
   * loaded documents and continues on an excluded or frozen doc before it reads
   * inFlightFlushCount, which is what makes dropping the in-flight flush records here inert for
   * it. Call this with the doc still loaded and unfrozen and the sweep can force a store for a
   * doc whose own write is still physically outstanding. The reconcile guard, the other reader,
   * reads that same base and returns early without it.
   */
  deleteReconciledBase(docName: string): void {
    this.receipts.forget(docName);
    this.refusedStoreDocNames.delete(docName);
    this.storeFailures.delete(docName);
    this.storeIntakes.delete(docName);
    const persist = this.isPersistedDocument(docName);
    if (!persist) {
      this.reconciledBaseByBranch.get(this.activeBranch)?.delete(docName);
      this.inFlightFlushByDoc.delete(docName);
      return;
    }
    this.mutateDocument(
      docName,
      () => {
        this.reconciledBaseByBranch.get(this.activeBranch)?.delete(docName);
        this.inFlightFlushByDoc.delete(docName);
        this.displacedVersionsByBranch.get(this.activeBranch)?.delete(docName);
        this.staleExternalWritesByBranch.get(this.activeBranch)?.delete(docName);
      },
      persist,
    );
  }

  private freshDisplacedVersions(docName: string): DisplacedVersion[] {
    const perDoc = this.displacedVersionsByBranch.get(this.activeBranch);
    const entries = perDoc?.get(docName);
    if (!perDoc || !entries) return [];
    const cutoff = Date.now() - DISPLACED_VERSION_TTL_MS;
    const fresh = entries.filter((entry) => entry.at > cutoff);
    if (fresh.length === entries.length) return entries;
    this.mutateDocument(docName, () => {
      if (fresh.length === 0) perDoc.delete(docName);
      else perDoc.set(docName, fresh);
    });
    return fresh;
  }

  recordDisplacedVersion(docName: string, content: string): void {
    const hash = contentHash(content);
    const retained = this.freshDisplacedVersions(docName).filter((entry) => entry.hash !== hash);
    retained.push({ hash, at: Date.now() });
    let perDoc = this.displacedVersionsByBranch.get(this.activeBranch);
    if (!perDoc) {
      perDoc = new Map();
      this.displacedVersionsByBranch.set(this.activeBranch, perDoc);
    }
    this.mutateDocument(docName, () =>
      perDoc.set(docName, retained.slice(-DISPLACED_VERSION_LIMIT)),
    );
  }

  clearDisplacedVersions(docName: string): void {
    if (!this.displacedVersionsByBranch.get(this.activeBranch)?.has(docName)) return;
    this.mutateDocument(docName, () =>
      this.displacedVersionsByBranch.get(this.activeBranch)?.delete(docName),
    );
  }

  isDisplacedVersion(docName: string, content: string): boolean {
    const entries = this.freshDisplacedVersions(docName);
    if (entries.length === 0) return false;
    const hash = contentHash(content);
    return entries.some((entry) => entry.hash === hash);
  }

  recordStaleExternalWrite(
    docName: string,
    diskContent: string,
    retainedContent?: string,
  ): StaleExternalWriteConflict {
    let conflicts = this.staleExternalWritesByBranch.get(this.activeBranch);
    if (!conflicts) {
      conflicts = new Map();
      this.staleExternalWritesByBranch.set(this.activeBranch, conflicts);
    }
    const diskHash = contentHash(diskContent);
    const existing = conflicts.get(docName);
    if (
      existing?.diskHash === diskHash &&
      (retainedContent === undefined || retainedContent === existing.retainedContent)
    )
      return existing;
    const isNewConflict = existing?.diskHash !== diskHash;
    const candidateContent = retainedContent ?? existing?.retainedContent;
    const conflict = {
      docName,
      file: this.fileForDocName(docName),
      diskHash,
      diskContent,
      ...(candidateContent === undefined ? {} : { retainedContent: candidateContent }),
      detectedAt: existing?.diskHash === diskHash ? existing.detectedAt : new Date().toISOString(),
    };
    this.mutateDocument(docName, () => conflicts.set(docName, conflict));
    if (isNewConflict) incrementStaleExternalWriteRefused();
    return conflict;
  }

  staleExternalWriteMatches(docName: string, diskContent: string): boolean {
    const conflict = this.staleExternalWritesByBranch.get(this.activeBranch)?.get(docName);
    return conflict !== undefined && conflict.diskHash === contentHash(diskContent);
  }

  listStaleExternalWrites(): StaleExternalWriteConflict[] {
    return [...(this.staleExternalWritesByBranch.get(this.activeBranch)?.values() ?? [])].map(
      (conflict) => this.withResolvedFile(conflict),
    );
  }

  getStaleExternalWrite(docName: string): StaleExternalWriteConflict | undefined {
    const conflict = this.staleExternalWritesByBranch.get(this.activeBranch)?.get(docName);
    return conflict === undefined ? undefined : this.withResolvedFile(conflict);
  }

  private withResolvedFile(conflict: StaleExternalWriteConflict): StaleExternalWriteConflict {
    if (this.hasResolvedExtension && !this.hasResolvedExtension(conflict.docName)) return conflict;
    const resolved = this.fileForDocName(conflict.docName);
    return resolved === conflict.file ? conflict : { ...conflict, file: resolved };
  }

  clearStaleExternalWrite(docName: string): void {
    const conflicts = this.staleExternalWritesByBranch.get(this.activeBranch);
    const previous = conflicts?.get(docName);
    if (!previous) return;
    this.mutateDocument(docName, () => conflicts?.delete(docName));
  }

  restoreStaleExternalWrite(conflict: StaleExternalWriteConflict, branch: string): void {
    let conflicts = this.staleExternalWritesByBranch.get(branch);
    if (!conflicts) {
      conflicts = new Map();
      this.staleExternalWritesByBranch.set(branch, conflicts);
    }
    if (conflicts.has(conflict.docName)) return;
    this.mutateDocument(conflict.docName, () => conflicts.set(conflict.docName, conflict));
  }

  private mutateDocument<T>(docName: string, mutate: () => T, persist = true): T {
    const bases = this.reconciledBaseByBranch.get(this.activeBranch) ?? new Map<string, string>();
    const versions =
      this.displacedVersionsByBranch.get(this.activeBranch) ??
      new Map<string, DisplacedVersion[]>();
    const conflicts =
      this.staleExternalWritesByBranch.get(this.activeBranch) ??
      new Map<string, StaleExternalWriteConflict>();
    const base = bases.get(docName);
    const displaced = versions.get(docName);
    const conflict = conflicts.get(docName);
    const inFlight = this.inFlightFlushByDoc.get(docName);
    let result: T;
    try {
      result = mutate();
      if (persist) this.persist();
    } catch (cause) {
      restoreEntry(bases, docName, base);
      restoreEntry(versions, docName, displaced);
      restoreEntry(conflicts, docName, conflict);
      restoreEntry(this.inFlightFlushByDoc, docName, inFlight);
      this.reconciledBaseByBranch.set(this.activeBranch, bases);
      this.displacedVersionsByBranch.set(this.activeBranch, versions);
      this.staleExternalWritesByBranch.set(this.activeBranch, conflicts);
      throw cause;
    }
    if (conflict !== conflicts.get(docName)) this.onStaleExternalWriteChange?.();
    return result;
  }

  private isPersistedDocument(docName: string): boolean {
    return (
      this.displacedVersionsByBranch.get(this.activeBranch)?.has(docName) === true ||
      this.staleExternalWritesByBranch.get(this.activeBranch)?.has(docName) === true
    );
  }

  private restore(): void {
    if (!this.persistencePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistencePath, 'utf-8');
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return;
      throw new DocumentDurabilityStateError(this.persistencePath, 'unreadable', cause);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new DocumentDurabilityStateError(this.persistencePath, 'corrupt', cause);
    }
    if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version !== 1) {
      throw new DocumentDurabilityStateError(this.persistencePath, 'incompatible');
    }
    const persisted = parsePersistedState(parsed);
    if (!persisted) {
      throw new DocumentDurabilityStateError(this.persistencePath, 'corrupt');
    }
    const cutoff = Date.now() - DISPLACED_VERSION_TTL_MS;
    const persistedBranches = new Map<string, string[]>();
    for (const [branch, documents] of Object.entries(persisted.branches)) {
      const bases = new Map<string, string>();
      const displaced = new Map<string, DisplacedVersion[]>();
      const conflicts = new Map<string, StaleExternalWriteConflict>();
      const cached = new Map<string, CachedDurabilityDocument>();
      const serializedDocuments: string[] = [];
      for (const document of documents) {
        if (document.staleExternalWrite) {
          try {
            this.fileForDocName(document.docName);
          } catch (cause) {
            throw new DocumentDurabilityStateError(this.persistencePath, 'corrupt', cause);
          }
        }
        const serialized = JSON.stringify(document);
        serializedDocuments.push(serialized);
        const expiresAt = nextDisplacedExpiry(document.displacedVersions);
        this.nextDisplacedExpiryAt = Math.min(this.nextDisplacedExpiryAt, expiresAt);
        const freshDisplaced = document.displacedVersions.filter((entry) => entry.at > cutoff);
        if (freshDisplaced.length === 0 && !document.staleExternalWrite) continue;
        bases.set(document.docName, document.acknowledgedContent);
        if (freshDisplaced.length > 0) {
          displaced.set(document.docName, freshDisplaced);
        }
        if (document.staleExternalWrite) {
          conflicts.set(document.docName, document.staleExternalWrite);
        }
        if (freshDisplaced.length === document.displacedVersions.length) {
          cached.set(document.docName, {
            acknowledgedContent: document.acknowledgedContent,
            displacedVersions: displaced.get(document.docName),
            staleExternalWrite: document.staleExternalWrite
              ? { ...document.staleExternalWrite }
              : undefined,
            expiresAt,
            serialized,
          });
        }
      }
      persistedBranches.set(branch, serializedDocuments);
      this.reconciledBaseByBranch.set(branch, bases);
      if (displaced.size > 0) this.displacedVersionsByBranch.set(branch, displaced);
      if (conflicts.size > 0) this.staleExternalWritesByBranch.set(branch, conflicts);
      if (cached.size > 0) this.cachedDocumentsByBranch.set(branch, cached);
    }
    if (!this.reconciledBaseByBranch.has(this.activeBranch)) {
      this.reconciledBaseByBranch.set(this.activeBranch, new Map());
    }
    this.lastPersistedParts = snapshotParts(persistedBranches);
  }

  private pruneExpiredDisplacedVersions(cutoff: number): void {
    this.nextDisplacedExpiryAt = Number.POSITIVE_INFINITY;
    for (const [branch, documents] of this.displacedVersionsByBranch) {
      for (const [docName, entries] of documents) {
        const fresh = entries.filter((entry) => entry.at > cutoff);
        if (fresh.length === 0) documents.delete(docName);
        else if (fresh.length !== entries.length) documents.set(docName, fresh);
        for (const entry of fresh) {
          this.nextDisplacedExpiryAt = Math.min(
            this.nextDisplacedExpiryAt,
            entry.at + DISPLACED_VERSION_TTL_MS,
          );
        }
      }
      if (documents.size === 0) this.displacedVersionsByBranch.delete(branch);
    }
  }

  private persist(): void {
    const cutoff = Date.now() - DISPLACED_VERSION_TTL_MS;
    if (!this.persistencePath) {
      this.pruneExpiredDisplacedVersions(cutoff);
      return;
    }
    const branches = new Map<string, string[]>();
    const nextCache = new Map<string, Map<string, CachedDurabilityDocument>>();
    const branchNames = new Set([
      ...this.displacedVersionsByBranch.keys(),
      ...this.staleExternalWritesByBranch.keys(),
    ]);
    for (const branch of branchNames) {
      const docNames = new Set([
        ...(this.displacedVersionsByBranch.get(branch)?.keys() ?? []),
        ...(this.staleExternalWritesByBranch.get(branch)?.keys() ?? []),
      ]);
      const documents: string[] = [];
      const cachedDocuments = new Map<string, CachedDurabilityDocument>();
      for (const docName of docNames) {
        const acknowledgedContent = this.reconciledBaseByBranch.get(branch)?.get(docName);
        if (acknowledgedContent === undefined) continue;
        const versions = this.displacedVersionsByBranch.get(branch)?.get(docName);
        const staleExternalWrite = this.staleExternalWritesByBranch.get(branch)?.get(docName);
        const cached = this.cachedDocumentsByBranch.get(branch)?.get(docName);
        if (
          cached &&
          cached.acknowledgedContent === acknowledgedContent &&
          cached.displacedVersions === versions &&
          sameStaleConflict(cached.staleExternalWrite, staleExternalWrite) &&
          cached.expiresAt > cutoff + DISPLACED_VERSION_TTL_MS
        ) {
          documents.push(cached.serialized);
          cachedDocuments.set(docName, cached);
          continue;
        }
        const displacedVersions = (versions ?? []).filter((entry) => entry.at > cutoff);
        if (displacedVersions.length === 0 && !staleExternalWrite) continue;
        const document: PersistedDocumentDurability = {
          docName,
          acknowledgedContent,
          displacedVersions,
          ...(staleExternalWrite ? { staleExternalWrite } : {}),
        };
        const serialized = JSON.stringify(document);
        documents.push(serialized);
        cachedDocuments.set(docName, {
          acknowledgedContent,
          displacedVersions: versions,
          staleExternalWrite: staleExternalWrite ? { ...staleExternalWrite } : undefined,
          expiresAt: nextDisplacedExpiry(displacedVersions),
          serialized,
        });
      }
      if (documents.length > 0) {
        branches.set(branch, documents);
        nextCache.set(branch, cachedDocuments);
      }
    }
    const parts = snapshotParts(branches);
    if (
      parts.length === this.lastPersistedParts.length &&
      parts.every((part, index) => part === this.lastPersistedParts[index])
    ) {
      this.cachedDocumentsByBranch = nextCache;
      this.pruneExpiredDisplacedVersions(cutoff);
      return;
    }
    const serialized = parts.join('');
    tracedMkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporaryPath = atomicTempPath(this.persistencePath);
    try {
      tracedWriteFileSync(temporaryPath, serialized, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      tracedRenameSync(temporaryPath, this.persistencePath);
      this.lastPersistedParts = parts;
      this.cachedDocumentsByBranch = nextCache;
    } catch (cause) {
      try {
        if (existsSync(temporaryPath)) tracedUnlinkSync(temporaryPath);
      } catch (cleanupError) {
        getLogger('document-durability-state').warn(
          {
            err: cleanupError,
            writeError: cause instanceof Error ? cause.message : String(cause),
            temporaryPath,
          },
          'Unable to remove failed recovery snapshot temporary file',
        );
      }
      throw cause;
    }
    this.pruneExpiredDisplacedVersions(cutoff);
  }

  private freshInFlightFlushes(docName: string): PendingFlush[] {
    const pending = this.inFlightFlushByDoc.get(docName);
    if (!pending) return [];
    const now = Date.now();
    const fresh = pending.filter((entry) => now - entry.at <= IN_FLIGHT_FLUSH_TTL_MS);
    if (fresh.length === pending.length) return pending;
    incrementInFlightFlushExpired(pending.length - fresh.length);
    if (fresh.length === 0) this.inFlightFlushByDoc.delete(docName);
    else this.inFlightFlushByDoc.set(docName, fresh);
    return fresh;
  }

  beginInFlightFlush(docName: string, normalizedMarkdown: string): void {
    const fresh = this.freshInFlightFlushes(docName);
    fresh.push({ value: normalizedMarkdown, at: Date.now() });
    this.inFlightFlushByDoc.set(docName, fresh);
  }

  peekInFlightFlush(docName: string): string | undefined {
    const pending = this.freshInFlightFlushes(docName);
    return pending[pending.length - 1]?.value;
  }

  inFlightFlushCount(docName: string): number {
    return this.freshInFlightFlushes(docName).length;
  }

  hasInFlightFlush(docName: string, normalizedMarkdown: string): boolean {
    return this.freshInFlightFlushes(docName).some((entry) => entry.value === normalizedMarkdown);
  }

  finishInFlightFlush(docName: string, expectedNormalizedMarkdown: string): void {
    const pending = this.freshInFlightFlushes(docName);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]?.value !== expectedNormalizedMarkdown) continue;
      pending.splice(i, 1);
      if (pending.length === 0) this.inFlightFlushByDoc.delete(docName);
      return;
    }
  }

  beginStoreAttempt(docName: string): StoreAttemptToken {
    const generation = (this.storeAttemptGenerations.get(docName) ?? 0) + 1;
    this.storeAttemptGenerations.set(docName, generation);
    return { docName, generation };
  }

  /**
   * STOP: `publish` must complete the disk write synchronously before returning — a
   * `'published'` return promises the caller the bytes are already on disk, and the call
   * site's post-publish bookkeeping (writeTracker registration, recordSuccessfulStore) runs
   * on that promise. The call site must pass a synchronous rename (`tracedRenameSync`), never
   * the async `tracedRename`: a callback that returns before the rename lands advances the
   * published watermark over content that is not durably persisted. A thenable return throws,
   * with a rejection handler attached first so its in-flight work cannot crash the process. A
   * nested `tryPublishStore` for the same document while a publish is in flight returns
   * `'reentrant'` before its callback runs — distinct from `'stale'` — and the in-flight
   * attempt owns the document's publish gate and completes normally: a `'reentrant'` result
   * is not a superseded drop, the in-flight capture is the one that lands.
   */
  tryPublishStore(token: StoreAttemptToken, publish: () => void): StorePublishOutcome {
    if (this.documentsWithPublishInFlight.has(token.docName)) return 'reentrant';
    const publishedAtEntry = this.publishedStoreGenerations.get(token.docName) ?? 0;
    if (token.generation <= publishedAtEntry) return 'stale';
    this.documentsWithPublishInFlight.add(token.docName);
    try {
      const outcome: unknown = publish();
      if (isThenable(outcome)) {
        try {
          outcome.then(
            () => {},
            (cause: unknown) => logRefusedPublishRejection(token, cause),
          );
        } catch {}
        throw new TypeError(
          `tryPublishStore: the publish callback must complete synchronously, but it returned a thenable (${token.docName} generation ${token.generation})`,
        );
      }
      this.publishedStoreGenerations.set(token.docName, token.generation);
      return 'published';
    } finally {
      this.documentsWithPublishInFlight.delete(token.docName);
    }
  }

  holdStores(docName: string): void {
    this.heldStores.add(docName);
  }

  releaseStores(docName: string): void {
    this.heldStores.delete(docName);
  }

  areStoresHeld(docName: string): boolean {
    return this.heldStores.has(docName);
  }

  beginRenameCarry(docName: string): Promise<RenameCarryAnswer> {
    const current = this.renameCarries.get(docName);
    if (current?.state === 'pending') {
      current.ended = false;
      return current.answer.promise;
    }
    const answer = Promise.withResolvers<RenameCarryAnswer>();
    this.renameCarries.set(docName, { state: 'pending', ended: false, answer });
    return answer.promise;
  }

  renameCarryOf(docName: string): Promise<RenameCarryAnswer> | undefined {
    const current = this.renameCarries.get(docName);
    if (current === undefined) return undefined;
    return current.state === 'pending'
      ? current.answer.promise
      : Promise.resolve({ kind: 'settled', carried: current.carried });
  }

  settleRenameCarry(docName: string, carried: WrittenThrough | null): void {
    const current = this.renameCarries.get(docName);
    if (current?.state !== 'pending') return;
    current.answer.resolve({ kind: 'settled', carried });
    if (current.ended) this.renameCarries.delete(docName);
    else this.renameCarries.set(docName, { state: 'settled', carried });
  }

  abandonRenameCarry(docName: string): void {
    this.settleRenameCarry(docName, null);
  }

  endRenameCarry(docName: string): void {
    const current = this.renameCarries.get(docName);
    if (current?.state === 'pending') current.ended = true;
    else this.renameCarries.delete(docName);
  }

  endAllRenameCarries(): void {
    for (const current of this.renameCarries.values()) {
      if (current.state === 'pending') current.answer.resolve({ kind: 'stopped' });
    }
    this.renameCarries.clear();
  }

  async awaitRenameCarry(
    docName: string,
    carry: Promise<RenameCarryAnswer> | undefined,
    timeoutMs = WRITE_WAIT_BUDGET_MS,
  ): Promise<RenameCarryAnswer> {
    if (carry === undefined) return { kind: 'settled', carried: null };
    const bound = this.remainingWriteWait(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), bound);
    });
    try {
      const answer = await Promise.race([carry, expired]);
      if (answer !== 'expired') return answer;
      getLogger('document-durability-state').warn(
        { docName, waitedMs: bound },
        `[durability] the rename carry of ${docName} did not settle within the write's wait; the wait expired`,
      );
      return { kind: 'unsettled' };
    } finally {
      clearTimeout(timer);
    }
  }

  holdBatch(owner: string): void {
    this.batchHolders.add(owner);
    this.batchInProgress = true;
  }

  releaseBatch(owner: string): boolean {
    if (!this.batchHolders.delete(owner) || this.batchHolders.size > 0) return false;
    this.batchInProgress = false;
    return true;
  }

  setBatchInProgress(value: boolean): void {
    this.batchInProgress = value;
  }

  isBatchInProgress(): boolean {
    return this.batchInProgress;
  }

  holdWriteAdmission(): () => void {
    this.writeAdmissionHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writeAdmissionHolds--;
      if (this.writeAdmissionHolds > 0) return;
      const waiters = [...this.writeAdmissionWaiters];
      this.writeAdmissionWaiters.clear();
      for (const wake of waiters) wake();
    };
  }

  isWriteAdmissionHeld(): boolean {
    return this.writeAdmissionHolds > 0;
  }

  runWithinWriteWaitBudget<T>(fn: () => T, budgetMs = WRITE_WAIT_BUDGET_MS): T {
    return this.writeWaitDeadline.run(Date.now() + budgetMs, fn);
  }

  private remainingWriteWait(timeoutMs: number): number {
    const deadline = this.writeWaitDeadline.getStore();
    if (deadline === undefined) return timeoutMs;
    return Math.max(0, Math.min(timeoutMs, deadline - Date.now()));
  }

  async whenWriteAdmitted(timeoutMs = WRITE_WAIT_BUDGET_MS): Promise<boolean> {
    if (!this.isWriteAdmissionHeld()) return true;
    const bound = this.remainingWriteWait(timeoutMs);
    if (bound === 0) return false;
    let wake: () => void = () => {};
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      wake();
    }, bound);
    try {
      while (this.isWriteAdmissionHeld() && !timedOut) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          this.writeAdmissionWaiters.add(resolve);
        });
        this.writeAdmissionWaiters.delete(wake);
      }
      return !this.isWriteAdmissionHeld();
    } finally {
      clearTimeout(timer);
    }
  }

  openDeferredStore(docName: string): DeferredStoreSettlement {
    const { promise, resolve } = Promise.withResolvers<DeferredStoreOutcome>();
    this.deferredStoreOutcomes.set(docName, promise);
    return {
      settle: (outcome) => {
        if (this.deferredStoreOutcomes.get(docName) === promise) {
          this.deferredStoreOutcomes.delete(docName);
        }
        resolve(outcome);
      },
    };
  }

  async awaitDeferredStoreOutcome(
    docName: string,
    timeoutMs = WRITE_WAIT_BUDGET_MS,
  ): Promise<DeferredStoreWait | undefined> {
    const pending = this.deferredStoreOutcomes.get(docName);
    if (pending === undefined) return undefined;
    if (!this.isWriteAdmissionHeld() && !this.heldStores.has(docName)) return undefined;
    const unsettled = { kind: 'unsettled' } as const;
    const bound = this.remainingWriteWait(timeoutMs);
    if (bound === 0) return unsettled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof unsettled>((resolve) => {
      timer = setTimeout(() => resolve(unsettled), bound);
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  markAgentWriteStore(docName: string): void {
    this.agentWriteStores.add(docName);
  }

  consumeAgentWriteStore(docName: string): boolean {
    return this.agentWriteStores.delete(docName);
  }

  markStoreRefused(docName: string): void {
    this.refusedStoreDocNames.add(docName);
    this.onStoreRefused?.(docName);
  }

  clearStoreRefused(docName: string): void {
    this.refusedStoreDocNames.delete(docName);
  }

  isStoreRefused(docName: string): boolean {
    return this.refusedStoreDocNames.has(docName);
  }

  getRefusedStoreDocNames(): string[] {
    return [...this.refusedStoreDocNames];
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

  recordStoreIntake(docName: string, merge: StoreIntakeMerge, through: WrittenThrough): void {
    const records = this.storeIntakes.get(docName) ?? [];
    records.push({ merge, through });
    if (records.length > STORE_INTAKE_RECORDS_KEPT) {
      records.splice(0, records.length - STORE_INTAKE_RECORDS_KEPT);
    }
    this.storeIntakes.set(docName, records);
  }

  readStoreIntake(
    docName: string,
    write: WrittenThrough | undefined,
  ): StoreIntakeMerge | undefined {
    let strongest: StoreIntakeMerge | undefined;
    for (const record of this.storeIntakes.get(docName) ?? []) {
      if (!editWasCarried(write, record.through)) continue;
      if (
        strongest === undefined ||
        STORE_INTAKE_STRENGTH[record.merge] > STORE_INTAKE_STRENGTH[strongest]
      ) {
        strongest = record.merge;
      }
    }
    return strongest;
  }

  recordStaleExternalWriteFreeze(docName: string): void {
    this.staleExternalWriteFreezes.add(docName);
  }

  takeStaleExternalWriteFreeze(docName: string): boolean {
    return this.staleExternalWriteFreezes.delete(docName);
  }
}
