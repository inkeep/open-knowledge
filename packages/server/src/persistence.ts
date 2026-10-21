import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Extension } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import {
  addsBlankLines,
  BridgeInvariantViolationError,
  type ConfigValidationError,
  DOCUMENT_OPEN_BYTE_LIMIT,
  fnv1aDigest,
  formatFileSize,
  fragmentHoldsPendingContent,
  normalizeBridge,
  type Principal,
  pathspecArgs,
  pendingContentLines,
  prependFrontmatter,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { atomicTempPath } from '@inkeep/open-knowledge-core/server';
import {
  composeCommitSubject,
  formatOkActor,
  formatWipSubject,
  type OkActorEntry,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { LINEAGE_EPOCH_KEY } from './auth-token-schema.ts';
import { type DeriveLossDetectOptions, detectPairedIntakeLoss } from './bridge-loss-detector.ts';
import { getMsSinceLastUserTx, isDocQuiescent } from './bridge-quiescence.ts';
import { assertBridgeInvariant, createDocCanonicalizer } from './bridge-watchdog.ts';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isManagedArtifactDoc,
  isMermaidDoc,
  isPersistenceExcludedDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import {
  type ConfigPersistenceCtx,
  configDocAbsPath,
  loadConfigDoc,
  type StoreConfigDocOutcome,
  storeConfigDoc,
} from './config-persistence.ts';
import type { ConflictAuthority } from './conflict-authority.ts';
import {
  type FreezingLifecycleStatus,
  isRemovalLifecycleStatus,
  type LifecycleView,
  type RemovalLifecycleStatus,
} from './conflict-kinds.ts';
import { isWithinContentDir, safeContentPath } from './content-path.ts';
import type { ContributorEntry } from './contributor-tracker.ts';
import {
  contributorCount,
  hasContributor,
  recordContributor,
  restoreContributorEntry,
  restoreContributors,
  swapContributors,
} from './contributor-tracker.ts';
import {
  type DerivedDocumentIndexPersistencePort,
  isDerivedDocumentIndexClosedError,
} from './derived-document-index.ts';
import { resolveDirectoryRoot, resolveNativePath } from './directory-root.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';
import type { FileObservation } from './disk-receipts.ts';
import { displayPathFor } from './display-path.ts';
import {
  assertNeverStorePublishOutcome,
  type DeferredStoreDiscardCause,
  type DeferredStoreOutcome,
  type DeferredStoreSettlement,
  DocumentDurabilityState,
  type HeldSaveReason,
  OK_DOC_REMOVED,
  OK_PATH_UNRESOLVABLE,
  OK_STORE_HELD,
  OK_STORE_REFUSED,
  OK_WRITE_DROPPED,
  type StoreFailure,
  type StoreFailureRemoval,
  type StoreIntakeMerge,
  type StorePublishOutcome,
  type WriteDropCause,
  writtenThroughOf,
} from './document-durability-state.ts';
import { refuseStaleExternalWrite } from './external-change.ts';
import { contentHash, registerWrite } from './file-watcher.ts';
import { resolvesIntoPrivateState } from './fs-safety.ts';
import {
  type ObservedFileRead,
  tracedAppendFileSync,
  tracedMkdir,
  tracedReadObservedSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFile,
} from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import {
  LOSS_EVENT_CHECKPOINT_WRITE,
  LOSS_EVENT_DETECTOR_TRIP,
  LOSS_EVENT_PERSISTENCE_HOLD,
  LOSS_EVENT_REPAIR_REBUILD,
  type LossCaptureRing,
} from './loss-capture.ts';
import {
  loadManagedArtifactDoc,
  type ManagedArtifactCtx,
  type ManagedArtifactDrop,
  managedArtifactContributorAttribution,
  managedArtifactTimelinePaths,
  type StoreManagedArtifactOutcome,
  storeManagedArtifactDoc,
  storeManagedArtifactWroteFile,
} from './managed-artifact-persistence.ts';
import { mdManager, schema } from './md-manager.ts';
import type { MergeHistoryRecorder } from './merge-history.ts';
import {
  loadMermaidDoc,
  type MermaidPersistenceCtx,
  type StoreMermaidOutcome,
  storeMermaidDoc,
} from './mermaid-persistence.ts';
import {
  incrementDeferredStoreFailures,
  incrementGitAutoSaveFailure,
  incrementGitWriterCommitFailure,
  incrementHeldSave,
  incrementManagedArtifactReconcileCheckpointCreated,
  incrementManagedArtifactReconcileDeduped,
  incrementPersistenceDeferHold,
  incrementPersistenceDiskWrite,
  incrementPersistenceDuplicationBaselineMissing,
  incrementPersistenceDuplicationBaselineRefusals,
  incrementPersistenceDuplicationReset,
  incrementPersistenceDuplicationResetCheckpointCreated,
  incrementPersistenceDuplicationResetDeduped,
  incrementPersistenceDuplicationSpared,
  incrementPersistenceForceFlushDuringBurst,
  incrementPersistenceReconcileLoss,
  incrementPersistenceReconcileLossCheckpointCreated,
  incrementPersistenceReconcileLossDeduped,
  incrementPersistenceReconciliationFailures,
  incrementPersistenceSanityCheckSerializeFailures,
  incrementPersistenceSkipNonQuiescent,
  incrementPersistenceStoreRemovedDoc,
  incrementPersistenceStoreSuperseded,
  incrementStoreDiskCompare,
  incrementStoreDiskCompareReadRetries,
  incrementStoreRestatRefused,
  type StorePendingReason,
} from './metrics.ts';
import { toPosix } from './path-utils.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { assertProjectContentScope, NestedProjectScopeError } from './project-content-scope.ts';
import {
  backfillRenameLogCommitSha,
  getOrLoadRenameLogIndex,
  pendingRenameLogEntries,
} from './rename-log.ts';
import { type SaveHold, visibleHoldCause } from './save-hold.ts';
import { getConvergedFragmentWitness, OBSERVER_SYNC_ORIGIN } from './server-observers.ts';
import type { ShadowRef, WriterIdentity } from './shadow-repo.ts';
import {
  buildWipTree,
  commitWip,
  commitWipFromTree,
  FILE_SYSTEM_WRITER,
  GIT_UPSTREAM_WRITER,
  SERVICE_WRITER,
  saveInMemoryCheckpoint,
  shadowGit,
} from './shadow-repo.ts';
import {
  assertNeverDiskCompare,
  COMPARE_READ_RETRY_DELAYS_MS,
  compareDiskBeforeReplace,
  type DiskCompareOutcome,
  restatFile,
  StoreRestatFailedError,
  StoreRestatRefusedError,
  statObservation,
} from './store-compare.ts';
import { getMeter, setActiveSpanAttributes, withSpan } from './telemetry.ts';

const log = getLogger('persistence');

type StoreSettlement = SaveHold | 'resolved' | 'neutral';

function assertNeverStoreOutcome(outcome: never): never {
  throw new Error(`unhandled store outcome: ${String(outcome)}`);
}

function configSettlement(outcome: StoreConfigDocOutcome, retry: boolean): StoreSettlement {
  if (typeof outcome === 'object') return outcome;
  switch (outcome) {
    case 'persisted':
    case 'reconciled':
    case 'reverted':
      return 'resolved';
    case 'no-op':
      return retry ? 'resolved' : 'neutral';
    case 'write-failed':
      return 'neutral';
    default:
      return assertNeverStoreOutcome(outcome);
  }
}

function managedArtifactSettlement(
  outcome: StoreManagedArtifactOutcome,
  retry: boolean,
): StoreSettlement {
  if (typeof outcome === 'object') return outcome;
  switch (outcome) {
    case 'persisted':
    case 'merged':
    case 'both-kept':
    case 'kept-live':
    case 'stash-fallback':
    case 'applied':
      return 'resolved';
    case 'no-op':
    case 'outside-taken-in':
    case 'dropped-legacy-name':
    case 'dropped-unresolvable':
    case 'dropped-container-gone':
      return retry ? 'resolved' : 'neutral';
    case 'unchanged':
    case 'write-failed':
    case 'dropped-intake-landed':
      return 'neutral';
    default:
      return assertNeverStoreOutcome(outcome);
  }
}

function enginelessSettlement(outcome: StoreMermaidOutcome, retry: boolean): StoreSettlement {
  if (typeof outcome === 'object') return outcome;
  switch (outcome) {
    case 'persisted':
    case 'kept-live':
      return 'resolved';
    case 'no-op':
      return retry ? 'resolved' : 'neutral';
    case 'write-failed':
      return 'neutral';
    default:
      return assertNeverStoreOutcome(outcome);
  }
}
const compareLog = getLogger('store-compare');

const MAX_STORE_COMPARE_RUNS = 3;

const consumedCompareReadFaults = new Map<string, number>();

function compareReaderFor(documentName: string): (path: string) => ObservedFileRead {
  const fault =
    process.env.NODE_ENV === 'test' ? process.env.OK_TEST_COMPARE_READ_FAULT : undefined;
  if (fault === undefined) return tracedReadObservedSync;
  const [docName, code, count] = fault.split(':');
  if (docName !== documentName || code === undefined) return tracedReadObservedSync;
  return (path) => {
    const consumed = consumedCompareReadFaults.get(fault) ?? 0;
    if (consumed >= Number(count ?? '1')) return tracedReadObservedSync(path);
    consumedCompareReadFaults.set(fault, consumed + 1);
    const err = new Error(`OK_TEST_COMPARE_READ_FAULT: simulated ${code} reading ${path}`);
    throw Object.assign(err, { code });
  };
}

interface StoreRunControl {
  agentTriggered: boolean | undefined;
  rerun: 'base-moved' | 'disk-changed' | null;
}

type StoreIntakeResult =
  | { readonly kind: 'taken-in'; readonly merge?: StoreIntakeMerge }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failed'; readonly error: unknown };

type StoreDiskIntake = (
  docName: string,
  absPath: string,
  content: string,
) => Promise<StoreIntakeResult>;

const STORE_PENDING_DESCRIPTIONS: Readonly<Record<StorePendingReason, string>> = {
  'pending-unreadable': 'its file could not be read for the compare before the write',
  'pending-exhausted': 'its file kept changing while it was being saved',
  'pending-base-moved': 'its acknowledged version kept moving while it was being saved',
  'pending-no-intake': 'its file changed and this persistence has no intake to merge it',
  'pending-intake-failed': 'its file changed and merging the outside version into it failed',
  'pending-intake-failed-no-base':
    'its file changed and taking the outside version in failed, with no agreed version to merge against',
  'pending-conflict': 'its file changed and could not be merged, so a conflict was raised',
};

const OUTSIDE_STORE_HOLDS: Readonly<
  Record<SaveHold['cause'], { readonly reason: HeldSaveReason; readonly description: string }>
> = {
  unreadable: {
    reason: 'pending-unreadable',
    description: STORE_PENDING_DESCRIPTIONS['pending-unreadable'],
  },
  'keeps-changing': {
    reason: 'pending-exhausted',
    description: STORE_PENDING_DESCRIPTIONS['pending-exhausted'],
  },
  'edits-changing': {
    reason: 'pending-exhausted',
    description: 'its edits kept changing while it was being saved',
  },
  'no-history-or-backup': {
    reason: 'pending-no-history-or-backup',
    description:
      'its file changed outside and that version could be saved neither to history nor to the backup folder',
  },
  'not-utf8': {
    reason: 'pending-not-utf8',
    description: 'its file changed outside to bytes that are not UTF-8 text',
  },
};

const OUTSIDE_STORE_DROPS: Readonly<
  Record<ManagedArtifactDrop, { readonly cause: WriteDropCause; readonly description: string }>
> = {
  'dropped-legacy-name': { cause: 'legacy-name', description: 'this name has no file of its own' },
  'dropped-unresolvable': {
    cause: 'unresolvable',
    description: 'its file path could not be resolved',
  },
  'dropped-container-gone': {
    cause: 'container-gone',
    description: 'its skill folder is gone (deleted or moved)',
  },
  'dropped-intake-landed': {
    cause: 'intake-landed',
    description: 'an outside change to its file was being taken in when the save ran',
  },
};

function assertNeverStoreIntake(intake: never): never {
  throw new Error(`unhandled store intake result: ${(intake as { kind: string }).kind}`);
}

class StoreHeldPendingError extends Error {
  readonly reason: StorePendingReason;
  readonly code = OK_STORE_HELD;
  readonly causeCode: string | undefined;
  readonly noBase: boolean;

  constructor(docName: string, reason: StorePendingReason, noBase: boolean, cause?: unknown) {
    super(`${docName} was not saved: ${STORE_PENDING_DESCRIPTIONS[reason]}`, { cause });
    this.name = 'StoreHeldPendingError';
    this.reason = reason;
    this.noBase = noBase;
    this.causeCode = cause === undefined ? undefined : errnoCode(cause);
  }
}

export class DocumentOpenSizeLimitError extends Error {
  readonly docName: string;
  readonly size: number;
  readonly limit: number;

  constructor(docName: string, size: number, limit = DOCUMENT_OPEN_BYTE_LIMIT) {
    super(
      `Document "${docName}" is ${formatFileSize(size)}; OpenKnowledge opens documents up to ${formatFileSize(limit)}.`,
    );
    this.name = 'DocumentOpenSizeLimitError';
    this.docName = docName;
    this.size = size;
    this.limit = limit;
  }
}

/**
 * Derives a `WriterIdentity` from a Hocuspocus transaction origin, handling the three origin
 * shapes it surfaces. Origins are `LocalTransactionOrigin` object refs, not strings
 * (precedent #1). Exported so the dispatch table is unit-testable without a server.
 */
export function resolveWriterFromOrigin(
  origin: unknown,
  getPrincipal?: () => Principal | null,
): WriterIdentity | null {
  if (!origin || typeof origin !== 'object') return null;
  const o = origin as Record<string, unknown>;

  if (o.source === 'local') {
    const ctx = o.context as Record<string, unknown> | undefined;
    if (!ctx) return null;

    if (typeof ctx.session_id === 'string') {
      const sessionId = ctx.session_id;
      return {
        id: `agent-${sessionId}`,
        name: `Agent (${sessionId.slice(0, 8)})`,
        email: `agent-${sessionId}@openknowledge.local`,
      };
    }

    if (ctx.origin === 'file-watcher') return FILE_SYSTEM_WRITER;
    if (ctx.origin === 'upstream-import' || ctx.origin === 'git-upstream') {
      return GIT_UPSTREAM_WRITER;
    }
    return SERVICE_WRITER;
  }

  if (o.source === 'connection') {
    const conn = o.connection as Record<string, unknown> | undefined;
    const ctx = conn?.context as Record<string, unknown> | undefined;
    if (typeof ctx?.principalId === 'string') {
      const principalId = ctx.principalId as string;
      const loaded = getPrincipal?.();
      if (loaded && loaded.id === principalId && loaded.display_name && loaded.display_email) {
        return {
          id: loaded.id,
          name: loaded.display_name,
          email: loaded.display_email,
        };
      }
      return {
        id: principalId,
        name: 'Local User',
        email: `${principalId}@openknowledge.local`,
      };
    }
    return SERVICE_WRITER;
  }

  return null;
}

export class DuplicationBaselineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicationBaselineUnavailableError';
  }
}

const DEFERRED_STORE_ERROR_CLASSES = [
  'disk-write',
  'serialize',
  'reconcile',
  'parse-fallback',
  'traced-rename',
  'duplication-baseline-unavailable',
  'store-held-pending',
  'unknown',
] as const;
type DeferredStoreErrorClass = (typeof DEFERRED_STORE_ERROR_CLASSES)[number];

const ERRNO_FS_CODES = new Set([
  'EACCES',
  'EBADF',
  'EBUSY',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
  'ETXTBSY',
  'EXDEV',
]);

export function classifyDeferredStoreError(err: unknown): DeferredStoreErrorClass {
  if (err === null || typeof err !== 'object') return 'unknown';
  if (err instanceof DuplicationBaselineUnavailableError) {
    return 'duplication-baseline-unavailable';
  }
  if (err instanceof StoreHeldPendingError) return 'store-held-pending';
  const e = err as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.startsWith('symlink-escape:')) return 'disk-write';
  if (typeof e.code === 'string' && ERRNO_FS_CODES.has(e.code)) {
    if (message.includes('rename')) return 'traced-rename';
    return 'disk-write';
  }
  if (err instanceof BridgeInvariantViolationError) return 'serialize';
  return 'unknown';
}

export interface PersistenceOptions {
  contentDir: string;
  assertContentPath?: (path: string) => void;
  projectDir: string;
  durabilityState?: DocumentDurabilityState;
  conflicts?: Pick<ConflictAuthority, 'dissolveReconcile' | 'fileOf' | 'raise'>;
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  wipRef?: string;
  shadowRef?: ShadowRef;
  contentRoot?: string;
  derivedDocumentIndex?: DerivedDocumentIndexPersistencePort;
  getCurrentBranch?: () => string | null;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  getPrincipal?: () => Principal | null;
  onAgentCommit?: () => void;
  onFlushCommit?: () => void;
  capturePublicationReceipt?: (
    document: Y.Doc,
    documentName: string,
    snapshotSV: Uint8Array,
  ) => (() => void) | undefined;
  onDiskFlush?: (
    docName: string,
    sv: Uint8Array,
    persistedMarkdown: string,
    previousMarkdown: string | null,
  ) => void;
  applyDiskContentToDoc?: (
    document: Y.Doc,
    content: string,
    resolveEmbed?: (basename: string, sourcePath: string) => string | null,
    sourcePath?: string,
    resolveSize?: (basename: string, sourcePath: string) => number | null,
    detect?: DeriveLossDetectOptions,
  ) => void;
  configHomedirOverride?: string;
  onConfigRejected?: (docName: string, error: ConfigValidationError) => void;
  onConfigPersisted?: (docName: string) => void;
  onManagedSkillPersisted?: (docName: string) => void;
  mdManager?: MarkdownManager;
  getLossRing?: () => Pick<LossCaptureRing, 'record'> | undefined;
  isRecentlyRemoved?: (docName: string) => boolean;
  lifecycleOf?: (document: Y.Doc, docName: string) => LifecycleView | null;
  ephemeral?: boolean;
  ingestDiskAtStore: StoreDiskIntake | null;
  mergeHistory: MergeHistoryRecorder | null;
}

export function captureDocSnapshotForPersistence(document: Y.Doc): {
  readonly sv: Uint8Array;
  readonly json: JSONContent;
} {
  return {
    sv: Y.encodeStateVector(document),
    json: yXmlFragmentToProseMirrorRootNode(document.getXmlFragment('default'), schema).toJSON(),
  };
}

export function normalizedSourceForm(rawYText: string): string {
  const { frontmatter, body } = stripFrontmatter(rawYText);
  return normalizeBridge(prependFrontmatter(frontmatter, body));
}
function connectionCount(document: Y.Doc): number {
  const probe = (document as Y.Doc & { getConnectionsCount?: () => number }).getConnectionsCount;
  if (typeof probe !== 'function') return 0;
  try {
    const n = probe.call(document);
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const PATH_CANNOT_EXIST_CODES = new Set(['ENOENT', 'ENOTDIR']);

type DocumentFileProbe = { readonly onDisk: boolean } | { readonly error: unknown };

function classifyProbeError(
  err: unknown,
): { readonly onDisk: false } | { readonly error: unknown } {
  const code = errnoCode(err);
  if (code !== undefined && PATH_CANNOT_EXIST_CODES.has(code)) return { onDisk: false };
  return { error: err };
}

function probeDocumentFileOnDisk(path: string): DocumentFileProbe {
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry === undefined) return { onDisk: false };
    if (!entry.isSymbolicLink()) return { onDisk: true };
  } catch (err) {
    return classifyProbeError(err);
  }
  try {
    realpathSync(path);
    return { onDisk: true };
  } catch (err) {
    return classifyProbeError(err);
  }
}

function toStoreFailure(err: unknown): StoreFailure {
  if (err instanceof StoreHeldPendingError) {
    return {
      code: OK_STORE_HELD,
      message: err.message,
      held: {
        reason: err.reason,
        ...(err.causeCode === undefined ? {} : { causeCode: err.causeCode }),
        ...(err.noBase ? { noBase: true as const } : {}),
      },
    };
  }
  let code: string | undefined;
  try {
    const c = (err as NodeJS.ErrnoException | null)?.code;
    if (typeof c === 'string') code = c;
  } catch {}
  let message = 'unknown store error';
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {}
  return { code, message };
}

export interface PersistenceQueueDepths {
  readonly branchDeferred: number;
  readonly quiescenceDeferred: number;
}

export interface PersistenceHandle {
  extension: Extension;
  readonly durabilityState: DocumentDurabilityState;
  flushDeferredStores: (mode?: 'within-branch' | 'discard-stale') => Promise<void>;
  discardDeferredStore: (docName: string, cause: DeferredStoreDiscardCause) => void;
  flushPendingGitCommit: () => Promise<void>;
  flushContributors: () => Promise<void>;
  waitForPendingCommits: () => Promise<void>;
  getQueueDepths: () => PersistenceQueueDepths;
  forceStore: (document: Y.Doc, documentName: string) => Promise<void>;
  forgetObservedFile: (docName: string) => void;
  readonly configPersistenceCtx: ConfigPersistenceCtx;
  readonly managedArtifactCtx: ManagedArtifactCtx;
  readonly mermaidPersistenceCtx: MermaidPersistenceCtx;
  retryHeldSave: (document: Y.Doc, documentName: string) => Promise<void>;
  isHeldSaveDue: (documentName: string) => boolean;
  hasHeldSave: (documentName: string) => boolean;
}

export function createPersistenceExtension(options: PersistenceOptions): PersistenceHandle {
  const durabilityState = options?.durabilityState ?? new DocumentDurabilityState();
  const contentDir = resolveDirectoryRoot(resolve(options?.contentDir ?? process.cwd()), {
    root: 'content',
    component: 'persistence',
  });
  const projectDir = resolveDirectoryRoot(resolve(options?.projectDir ?? process.cwd()), {
    root: 'project',
    component: 'persistence',
  });
  const shadowRef = options?.shadowRef;
  const contentRoot = options?.contentRoot || toPosix(relative(projectDir, contentDir)) || '.';
  const derivedDocumentIndex = options?.derivedDocumentIndex;
  const getPrincipal = options?.getPrincipal;
  const onAgentCommit = options?.onAgentCommit;
  const onFlushCommit = options?.onFlushCommit;
  const onDiskFlush = options?.onDiskFlush;
  const onConfigPersisted = options?.onConfigPersisted;
  const onManagedSkillPersisted = options?.onManagedSkillPersisted;
  const mgr = options?.mdManager ?? mdManager;
  const ephemeral = options?.ephemeral ?? false;
  const frozenStatusOf = (
    document: Y.Doc,
    documentName: string,
  ): FreezingLifecycleStatus | null => {
    const view = options?.lifecycleOf?.(document, documentName);
    if (view === undefined) {
      const status = document.getMap('lifecycle').get('status');
      return isRemovalLifecycleStatus(status) ? status : null;
    }
    return view === null ? null : view.status;
  };

  const configLkgCache = new Map<string, string>();
  const configPersistenceCtx: ConfigPersistenceCtx = {
    projectDir,
    contentDir,
    lkgCache: configLkgCache,
    homedirOverride: options?.configHomedirOverride,
    onConfigRejected: options?.onConfigRejected,
    ephemeral,
    agreedDisk: new Map<string, string>(),
    history: options.mergeHistory,
  };

  const managedArtifactLkgCache = new Map<string, string>();
  const managedArtifactCtx: ManagedArtifactCtx = {
    projectDir,
    homedirOverride: options?.configHomedirOverride,
    lkgCache: managedArtifactLkgCache,
    setReconciledBase: (docName, content) => durabilityState.setReconciledBase(docName, content),
    getReconciledBase: (docName) => durabilityState.getReconciledBase(docName),
    beforeReconcileDivergence: (document, docName, liveContent, diskContent) =>
      checkpointBeforeManagedArtifactReconcile(document, docName, liveContent, diskContent),
    history: options.mergeHistory,
  };

  const mermaidLkgCache = new Map<string, string>();
  const mermaidPersistenceCtx: MermaidPersistenceCtx = {
    assertContentPath: options?.assertContentPath,
    contentDir,
    home: options?.configHomedirOverride ?? homedir(),
    lkgCache: mermaidLkgCache,
    receipts: {
      get: (docName) => durabilityState.getReceipt(docName),
      recordAgreed: (docName, content, observation) =>
        durabilityState.recordReceiptAgreed(docName, content, observation),
      recordOwnWrite: (docName, content, observation) =>
        durabilityState.recordReceiptOwnWrite(docName, content, observation),
    },
    history: options.mergeHistory,
  };

  const tripwireResetFailedDocs = new Set<string>();
  const docsWithSettledWrite = new Set<string>();
  const docsWithFileObservedOnDisk = new Set<string>();
  const applyDiskContent = options?.applyDiskContentToDoc ?? applyDiskContentToDoc;
  let pendingDeferredStoreFlushMode: 'within-branch' | 'discard-stale' | null = null;

  const QUIESCENCE_MAX_DEFER = 8;
  const persistenceDeferCounts = new Map<string, number>();
  const frozenStoreBaselines = new Map<string, string>();

  const gitEnabled = options?.gitEnabled ?? true;
  const commitDebounceMs = options?.commitDebounceMs ?? 15_000;
  const wipRef = options?.wipRef ?? 'refs/wip/main';
  const getCurrentBranch = options?.getCurrentBranch;

  let gitCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveGitFailures = 0;
  let commitInFlight: Promise<void> | null = null;
  let pendingAfterCommit = false;
  let deferredStoreDrainInFlight: Promise<void> | null = null;
  const deferredStores = new Map<
    string,
    {
      branch: string;
      document: Y.Doc;
      lastTransactionOrigin: unknown;
      settlement: DeferredStoreSettlement;
    }
  >();

  async function commitToWipRef(): Promise<void> {
    ensureHistograms();
    const started = Date.now();
    return withSpan('persistence.commitToWipRef', undefined, async () => {
      const result = await commitToWipRefInner();
      return result;
    }).finally(() => {
      commitDurationHist?.record((Date.now() - started) / 1000);
    });
  }

  async function commitToWipRefInner(): Promise<void> {
    const shadow = shadowRef?.current;
    if (shadow) {
      const snapshot = swapContributors();
      const claimableRenames = pendingRenameLogEntries(getOrLoadRenameLogIndex(shadow.gitDir));
      const branch = getCurrentBranch?.() ?? 'main';

      if (snapshot.size === 0) {
        const serviceActorEntry: OkActorEntry = {
          v: 1,
          writer_id: SERVICE_WRITER.id,
          principal: null,
          agent_session: null,
          agent_type: null,
          client_name: null,
          client_version: null,
          label: null,
          display_name: SERVICE_WRITER.name,
          color_seed: SERVICE_WRITER.id,
          docs: [],
        };
        const serviceMessage = `${formatWipSubject([])}\n\n${formatOkActor(serviceActorEntry)}`;
        try {
          const sha = await commitWip(shadow, SERVICE_WRITER, contentRoot, serviceMessage, branch);
          consecutiveGitFailures = 0;
          log.info(
            { sha: sha.slice(0, 8), writer: SERVICE_WRITER.id },
            `[persistence] Shadow WIP commit: ${sha.slice(0, 8)} on refs/wip/${SERVICE_WRITER.id}`,
          );
          try {
            backfillRenameLogCommitSha(
              shadow.gitDir,
              SERVICE_WRITER.id,
              sha,
              getOrLoadRenameLogIndex(shadow.gitDir),
              claimableRenames,
            );
          } catch (err) {
            log.warn({ err }, '[rename-log] service-writer backfill failed');
          }
        } catch (e) {
          consecutiveGitFailures++;
          incrementGitAutoSaveFailure();
          log.error(
            { err: e, attempt: consecutiveGitFailures },
            `[persistence] Shadow commit failed (attempt ${consecutiveGitFailures})`,
          );
          if (consecutiveGitFailures >= 3) {
            log.error(
              { err: e, attempt: consecutiveGitFailures },
              '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
            );
          }
        }
        return;
      }

      // Per-writer fan-out (precedent #25): build tree once, commit per writer.
      let treeSha: string;
      try {
        treeSha = await buildWipTree(shadow, contentRoot);
      } catch (e) {
        restoreContributors(snapshot);
        consecutiveGitFailures++;
        incrementGitAutoSaveFailure();
        log.error(
          { err: e, attempt: consecutiveGitFailures },
          `[persistence] Shadow WIP tree build failed (attempt ${consecutiveGitFailures})`,
        );
        return;
      }

      let anySuccess = false;
      for (const [writerId, entry] of snapshot as Map<string, ContributorEntry>) {
        const writer: WriterIdentity = {
          id: writerId,
          name: entry.displayName,
          email: `${writerId}@openknowledge.local`,
        };
        const docs = [...entry.docs];
        const a = entry.actor;
        const summaries = [...entry.summaries];
        const previousPaths = [...entry.previousPaths];
        const actorEntry: OkActorEntry = {
          v: 1,
          writer_id: writerId,
          principal: a?.principalId ?? null,
          agent_session: writerId.startsWith('agent-') ? writerId.slice(6) : null,
          agent_type: a?.agentType ?? null,
          client_name: a?.clientName ?? null,
          client_version: a?.clientVersion ?? null,
          label: a?.label ?? null,
          display_name: entry.displayName,
          color_seed: entry.colorSeed,
          docs,
          ...(summaries.length > 0 ? { summaries } : {}),
          ...(previousPaths.length > 0 ? { previous_paths: previousPaths } : {}),
        };
        const baseSubject = entry.subjectOverride ?? formatWipSubject(docs);
        const subject = composeCommitSubject(baseSubject, summaries);
        const writerMessage = `${subject}\n\n${formatOkActor(actorEntry)}`;
        try {
          const sha = await commitWipFromTree(shadow, writer, treeSha, writerMessage, branch);
          anySuccess = true;
          try {
            onFlushCommit?.();
          } catch (err) {
            log.warn({ err }, '[persistence] onFlushCommit callback failed (non-fatal)');
          }
          log.info(
            { sha: sha.slice(0, 8), writer: writerId, tree: treeSha.slice(0, 8) },
            `[persistence] Shadow WIP commit: ${sha.slice(0, 8)} on refs/wip/${writerId}`,
          );
          try {
            backfillRenameLogCommitSha(
              shadow.gitDir,
              writerId,
              sha,
              getOrLoadRenameLogIndex(shadow.gitDir),
              claimableRenames,
            );
          } catch (err) {
            log.warn({ err }, '[rename-log] backfill failed; will retry next commit');
          }
          if (writerId.startsWith('agent-')) {
            onAgentCommit?.();
          }
        } catch (e) {
          restoreContributorEntry(writerId, entry);
          incrementGitWriterCommitFailure();
          log.error(
            { err: e, writer: writerId },
            `[persistence] Per-writer shadow commit failed for ${writerId}`,
          );
        }
      }

      if (anySuccess) {
        consecutiveGitFailures = 0;
      } else {
        consecutiveGitFailures++;
        incrementGitAutoSaveFailure();
        if (consecutiveGitFailures >= 3) {
          log.error(
            { attempt: consecutiveGitFailures },
            '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
          );
        }
      }
      return;
    }

    const sg = shadowGit({
      gitDir: resolve(projectDir, '.git'),
      workTree: projectDir,
    });
    const tmpIndex = resolve(projectDir, '.git/index-wip');
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      try {
        const headTree = (await sg.raw('rev-parse', 'HEAD^{tree}')).trim();
        await sg.env(env).raw('read-tree', headTree);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('unknown revision') || msg.includes('bad revision')) {
          log.info({}, '[persistence] Empty repo — starting with empty index');
        } else {
          log.error(
            { err: e },
            '[persistence] Failed to read HEAD tree, falling back to empty index',
          );
        }
      }

      await sg.env(env).raw('add', ...pathspecArgs([contentRoot]));
      const treeSha = (await sg.env(env).raw('write-tree')).trim();

      let parentSha: string | null = null;
      try {
        parentSha = (await sg.raw('rev-parse', wipRef)).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
          throw e;
        }
      }

      const args = ['commit-tree', treeSha, '-m', `WIP auto-save ${new Date().toISOString()}`];
      if (parentSha) args.push('-p', parentSha);

      const commitSha = (await sg.raw(...args)).trim();
      await sg.raw('update-ref', wipRef, commitSha);
      consecutiveGitFailures = 0;
      log.info(
        { sha: commitSha.slice(0, 8), wipRef },
        `[persistence] Git commit: ${commitSha.slice(0, 8)} on ${wipRef}`,
      );
    } catch (e) {
      consecutiveGitFailures++;
      incrementGitAutoSaveFailure();
      log.error(
        { err: e, attempt: consecutiveGitFailures },
        `[persistence] Git commit failed (attempt ${consecutiveGitFailures})`,
      );
      if (consecutiveGitFailures >= 3) {
        log.error(
          { err: e, attempt: consecutiveGitFailures },
          '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
        );
      }
    } finally {
      try {
        tracedUnlinkSync(tmpIndex);
      } catch {}
    }
  }

  function computeCommitDelay(failures: number): number {
    if (failures <= 0) return commitDebounceMs;
    const exponent = Math.min(failures, 5);
    const multiplier = 2 ** exponent;
    const jitter = Math.random() * 0.25 * commitDebounceMs;
    return commitDebounceMs * multiplier + jitter;
  }

  function scheduleGitCommit(): void {
    if (!gitEnabled) return;
    if (durabilityState.isBatchInProgress()) return;
    if (gitCommitTimer) clearTimeout(gitCommitTimer);
    gitCommitTimer = setTimeout(() => {
      gitCommitTimer = null;
      if (commitInFlight) {
        pendingAfterCommit = true;
        return;
      }
      commitInFlight = commitToWipRef().finally(() => {
        commitInFlight = null;
        if (pendingAfterCommit) {
          pendingAfterCommit = false;
          scheduleGitCommit();
        }
      });
    }, computeCommitDelay(consecutiveGitFailures));
  }

  async function flushPendingGitCommit(): Promise<void> {
    if (commitInFlight && (gitCommitTimer || pendingAfterCommit)) {
      pendingAfterCommit = true;
      await commitInFlight;
      return flushPendingGitCommit();
    }
    if (gitCommitTimer) {
      clearTimeout(gitCommitTimer);
      gitCommitTimer = null;
      commitInFlight = commitToWipRef().finally(() => {
        commitInFlight = null;
        if (pendingAfterCommit) {
          pendingAfterCommit = false;
          scheduleGitCommit();
        }
      });
    }
    if (commitInFlight) await commitInFlight;
  }

  async function _awaitPendingCommit(): Promise<void> {
    if (commitInFlight) await commitInFlight;
  }

  /**
   * Under the Y.Text-is-truth contract (precedent #38) Y.Text holds the user's intended source-form
   * bytes; fragment must catch up so future edits start from a consistent base.
   */
  function canonicalizeForEphemeralBaseline(rawBytes: string, documentName: string): string | null {
    try {
      const { frontmatter, body } = stripFrontmatter(rawBytes);
      const parseOpts = options?.resolveEmbed
        ? {
            resolveEmbed: options.resolveEmbed,
            resolveSize: options?.resolveSize,
            sourcePath: documentName,
          }
        : undefined;
      const json = mgr.parseWithFallback(body, parseOpts);
      const canonicalBody = mgr.serialize(json);
      return normalizeBridge(prependFrontmatter(frontmatter, canonicalBody));
    } catch (err) {
      log.debug(
        { err, documentName },
        '[g8] ephemeral canonical baseline failed; falling through to write',
      );
      return null;
    }
  }

  function reconcileFragmentNow(document: Y.Doc, body: string, documentName: string): void {
    void options?.getLossRing?.()?.record({
      event: LOSS_EVENT_REPAIR_REBUILD,
      docName: documentName,
      writerId: null,
      direction: 'b',
      site: PERSISTENCE_PREWRITE_SITE,
      connections: connectionCount(document),
    });
    try {
      const xmlFragment = document.getXmlFragment('default');
      const parseOpts = options?.resolveEmbed
        ? {
            resolveEmbed: options.resolveEmbed,
            resolveSize: options?.resolveSize,
            sourcePath: documentName,
          }
        : undefined;
      const parsedJson = mdManager.parseWithFallback(body, parseOpts);
      const pmNode = schema.nodeFromJSON(parsedJson);
      document.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(document, xmlFragment, pmNode, meta);
      }, OBSERVER_SYNC_ORIGIN);
    } catch (err) {
      incrementPersistenceReconciliationFailures();
      log.warn(
        { err, documentName },
        `[persistence] reconcileFragmentNow failed for ${documentName}`,
      );
    }
  }

  const PERSISTENCE_PREWRITE_SITE = 'persistence-prewrite';
  const PERSISTENCE_DUPLICATION_SITE = 'persistence-duplication-reset';
  const MANAGED_ARTIFACT_RECONCILE_SITE = 'managed-artifact-reconcile';

  const lastFloorCheckpointPayload = new WeakMap<Y.Doc, string>();

  function recordDeferHold(documentName: string, pendingLines: readonly string[]): void {
    incrementPersistenceDeferHold();
    void options?.getLossRing?.()?.record({
      event: LOSS_EVENT_PERSISTENCE_HOLD,
      docName: documentName,
      writerId: null,
      direction: 'b',
      site: PERSISTENCE_PREWRITE_SITE,
      lostLen: pendingLines.reduce((n, line) => n + line.length, 0),
    });
  }

  function checkpointBeforeReconcile(
    document: Y.Doc,
    documentName: string,
    fragmentMarkdown: string,
    ytextMarkdown: string,
    witnessAvailable: boolean,
  ): void {
    incrementPersistenceReconcileLoss();
    if (lastFloorCheckpointPayload.get(document) === fragmentMarkdown) {
      incrementPersistenceReconcileLossDeduped();
      return;
    }
    lastFloorCheckpointPayload.set(document, fragmentMarkdown);
    const atRisk = pendingContentLines(fragmentMarkdown, ytextMarkdown, '');
    const lostLen = atRisk.reduce((n, line) => n + line.length, 0);
    const ring = options?.getLossRing?.();
    const shadow = shadowRef?.current;
    if (!shadow) {
      void ring?.record({
        event: LOSS_EVENT_CHECKPOINT_WRITE,
        docName: documentName,
        writerId: null,
        direction: 'b',
        site: PERSISTENCE_PREWRITE_SITE,
        lostLen,
        witnessAvailable,
      });
      return;
    }
    const branch = getCurrentBranch?.() ?? 'main';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'persistence-reconcile-loss',
        docName: documentName,
        contents: fragmentMarkdown,
        label: `Before persistence fragment rebuild @ ${new Date().toISOString()}`,
        branch,
        metadata: { atRiskLines: atRisk.length, witnessAvailable },
      })
        .then((sha) => {
          incrementPersistenceReconcileLossCheckpointCreated();
          void ring?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName: documentName,
            writerId: null,
            direction: 'b',
            site: PERSISTENCE_PREWRITE_SITE,
            lostLen,
            witnessAvailable,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'persistence-reconcile-loss-checkpoint-created',
              docName: documentName,
              sha,
              kind: 'persistence-reconcile-loss',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          if (lastFloorCheckpointPayload.get(document) === fragmentMarkdown) {
            lastFloorCheckpointPayload.delete(document);
          }
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { documentName, err: e },
            '[persistence] reconcile-loss checkpoint write failed',
          );
          void ring?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName: documentName,
            writerId: null,
            direction: 'b',
            site: PERSISTENCE_PREWRITE_SITE,
            lostLen,
            witnessAvailable,
          });
        });
    });
  }

  const lastDuplicationCheckpointPayload = new WeakMap<Y.Doc, string>();

  type TripwireDiskRead =
    | { kind: 'ok'; content: string }
    | { kind: 'missing' }
    | { kind: 'unavailable'; reason: 'escape' | 'read-failed' };

  function readTripwireDiskContent(documentName: string): TripwireDiskRead {
    const requestedDiskPath = safeContentPath(documentName, contentDir);
    if (!existsSync(requestedDiskPath)) return { kind: 'missing' };
    let canonical: string | null = null;
    try {
      canonical = resolveNativePath(requestedDiskPath);
    } catch (realpathErr) {
      log.warn(
        { err: realpathErr, documentName },
        `[persistence] Tripwire baseline read failed (realpath) for ${documentName}`,
      );
      return { kind: 'unavailable', reason: 'read-failed' };
    }
    if (
      !isWithinContentDir(canonical, contentDir) ||
      resolvesIntoPrivateState(requestedDiskPath, canonical, contentDir)
    ) {
      log.warn(
        { docName: documentName, originalPath: requestedDiskPath, canonical, contentDir },
        `[persistence] symlink-escape on tripwire reset: ${requestedDiskPath} → ${canonical}, skipping tripwire baseline read`,
      );
      return { kind: 'unavailable', reason: 'escape' };
    }
    try {
      return { kind: 'ok', content: readFileSync(canonical, 'utf-8') };
    } catch (readErr) {
      log.warn(
        { err: readErr, documentName, canonical },
        `[persistence] Tripwire baseline read failed (readFileSync) for ${documentName}`,
      );
      return { kind: 'unavailable', reason: 'read-failed' };
    }
  }

  function checkpointBeforeDuplicationReset(
    document: Y.Doc,
    documentName: string,
    liveMarkdown: string,
    copies: number,
    fragmentChildren: number,
  ): void {
    incrementPersistenceDuplicationReset();
    const ring = options?.getLossRing?.();
    const shadow = shadowRef?.current;
    if (!shadow) {
      void ring?.record({
        event: LOSS_EVENT_CHECKPOINT_WRITE,
        docName: documentName,
        writerId: null,
        direction: 'b',
        site: PERSISTENCE_DUPLICATION_SITE,
        lostLen: liveMarkdown.length,
      });
      return;
    }
    if (lastDuplicationCheckpointPayload.get(document) === liveMarkdown) {
      incrementPersistenceDuplicationResetDeduped();
      return;
    }
    lastDuplicationCheckpointPayload.set(document, liveMarkdown);
    const branch = getCurrentBranch?.() ?? 'main';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'persistence-duplication-reset',
        docName: documentName,
        contents: liveMarkdown,
        label: `Before duplication reset @ ${new Date().toISOString()}`,
        branch,
        metadata: { copies, fragmentChildren },
      })
        .then((sha) => {
          incrementPersistenceDuplicationResetCheckpointCreated();
          void ring?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName: documentName,
            writerId: null,
            direction: 'b',
            site: PERSISTENCE_DUPLICATION_SITE,
            lostLen: liveMarkdown.length,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'persistence-duplication-reset-checkpoint-created',
              docName: documentName,
              sha,
              kind: 'persistence-duplication-reset',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          if (lastDuplicationCheckpointPayload.get(document) === liveMarkdown) {
            lastDuplicationCheckpointPayload.delete(document);
          }
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { documentName, err: e },
            '[persistence] duplication-reset checkpoint write failed',
          );
        });
    });
  }

  const lastManagedReconcileCheckpointPayload = new WeakMap<Y.Doc, string>();

  function checkpointBeforeManagedArtifactReconcile(
    document: Y.Doc,
    documentName: string,
    liveContent: string,
    diskContent: string,
  ): DeriveLossDetectOptions | undefined {
    const ring = options?.getLossRing?.();
    const detect: DeriveLossDetectOptions = {
      baselineFullMd: diskContent,
      report: (obs) => {
        try {
          const dropped = detectPairedIntakeLoss(obs);
          if (dropped.length === 0) return;
          void ring?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName: documentName,
            writerId: FILE_SYSTEM_WRITER.id,
            direction: 'b',
            site: MANAGED_ARTIFACT_RECONCILE_SITE,
            lostLen: dropped.reduce((n, s) => n + s.length, 0),
            digest: fnv1aDigest(dropped.join('\n')),
          });
        } catch (detectErr) {
          log.warn(
            { documentName, err: detectErr },
            '[persistence] managed-artifact reconcile loss detection failed',
          );
        }
      },
    };

    const paths = managedArtifactTimelinePaths(documentName);
    const shadow = shadowRef?.current;
    if (!shadow || !paths.managed || !paths.versioned) {
      void ring?.record({
        event: LOSS_EVENT_CHECKPOINT_WRITE,
        docName: documentName,
        writerId: null,
        direction: 'b',
        site: MANAGED_ARTIFACT_RECONCILE_SITE,
        lostLen: liveContent.length,
      });
      return detect;
    }
    if (lastManagedReconcileCheckpointPayload.get(document) === liveContent) {
      incrementManagedArtifactReconcileDeduped();
      return detect;
    }
    lastManagedReconcileCheckpointPayload.set(document, liveContent);
    const branch = getCurrentBranch?.() ?? 'main';
    const anchorDocName = paths.docKey;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'managed-artifact-reconcile',
        docName: anchorDocName,
        contents: liveContent,
        label: `Before artifact reconcile @ ${new Date().toISOString()}`,
        branch,
        metadata: { diskBytes: diskContent.length, discardedBytes: liveContent.length },
      })
        .then((sha) => {
          incrementManagedArtifactReconcileCheckpointCreated();
          void ring?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName: documentName,
            writerId: null,
            direction: 'b',
            site: MANAGED_ARTIFACT_RECONCILE_SITE,
            lostLen: liveContent.length,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'managed-artifact-reconcile-checkpoint-created',
              docName: documentName,
              sha,
              kind: 'managed-artifact-reconcile',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          if (lastManagedReconcileCheckpointPayload.get(document) === liveContent) {
            lastManagedReconcileCheckpointPayload.delete(document);
          }
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { documentName, err: e },
            '[persistence] managed-artifact reconcile checkpoint write failed',
          );
        });
    });
    return detect;
  }

  let loadDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  let storeDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  let commitDurationHist: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
  function ensureHistograms(): void {
    if (loadDurationHist) return;
    const meter = getMeter();
    loadDurationHist = meter.createHistogram('ok.persistence.load.duration', {
      description: 'Duration of persistence.onLoadDocument in seconds',
      unit: 's',
    });
    storeDurationHist = meter.createHistogram('ok.persistence.store.duration', {
      description: 'Duration of persistence.onStoreDocument in seconds',
      unit: 's',
    });
    commitDurationHist = meter.createHistogram('ok.persistence.git_commit.duration', {
      description: 'Duration of commitToWipRef drain in seconds',
      unit: 's',
    });
  }

  const abandonmentsRecorded = new WeakSet<object>();

  function recordPathFault(
    documentName: string,
    err: unknown,
    callerAwaitingFlush: boolean,
    containmentEscape = false,
  ): void {
    persistenceDeferCounts.delete(documentName);
    if (typeof err === 'object' && err !== null) abandonmentsRecorded.add(err);
    if (!callerAwaitingFlush) return;
    const errno = errnoCode(err);
    const pathIsUnrepairable = containmentEscape || errno === 'ELOOP';
    durabilityState.recordStoreFailure(
      documentName,
      pathIsUnrepairable
        ? {
            code: OK_PATH_UNRESOLVABLE,
            message: `the path for ${documentName} could not be resolved inside the content directory${
              errno === undefined ? '' : ` (${errno})`
            }`,
          }
        : toStoreFailure(err),
    );
  }

  function refuseRemovedDocPublish(
    documentName: string,
    base: string | undefined,
    candidate: string,
    callerAwaitingFlush: boolean,
    frozen?: { status: RemovalLifecycleStatus; removal: StoreFailureRemoval | undefined },
  ): void {
    incrementPersistenceStoreRemovedDoc();
    console.warn(
      JSON.stringify({
        event: 'persistence-store-removed-doc',
        'doc.name': documentName,
        reason:
          frozen?.status ??
          (options?.isRecentlyRemoved?.(documentName) ? 'recently-removed' : 'file-absent'),
        baseBytes: base?.length ?? null,
        candidateBytes: candidate.length,
      }),
    );
    if (callerAwaitingFlush) {
      durabilityState.recordStoreFailure(
        documentName,
        frozen?.removal?.kind === 'path-occupied'
          ? {
              code: OK_DOC_REMOVED,
              message: `${documentName} was ${frozen.status === 'renamed' ? 'renamed' : 'deleted'} on disk and the file now at its path has not been loaded into it, so the store was refused rather than overwriting that file`,
              removal: frozen.removal,
            }
          : frozen?.removal?.kind === 'renamed'
            ? {
                code: OK_DOC_REMOVED,
                message: `${documentName} was renamed to ${frozen.removal.renamedTo} on disk, so the store was refused rather than recreating the file under its old name`,
                removal: frozen.removal,
              }
            : {
                code: OK_DOC_REMOVED,
                message: `${documentName} is no longer on disk, so the store was refused rather than recreating the removed file`,
              },
      );
    }
    persistenceDeferCounts.delete(documentName);
  }

  function frozenPathOccupied(documentName: string): boolean {
    try {
      return existsSync(safeContentPath(documentName, contentDir));
    } catch {
      return false;
    }
  }

  function holdMeetsFileWithNoAgreedVersion(documentName: string): boolean {
    return (
      durabilityState.getReconciledBase(documentName) === undefined &&
      (docsWithFileObservedOnDisk.has(documentName) || frozenPathOccupied(documentName))
    );
  }

  function frozenRemovalOf(
    document: Y.Doc,
    documentName: string,
    status: RemovalLifecycleStatus,
  ): StoreFailureRemoval | undefined {
    if (frozenPathOccupied(documentName)) return { kind: 'path-occupied' };
    const newPath = document.getMap('lifecycle').get('newPath');
    if (status !== 'renamed' || typeof newPath !== 'string' || newPath === '') return undefined;
    const carry = durabilityState.renameCarryOf(documentName);
    return { kind: 'renamed', renamedTo: newPath, ...(carry ? { carry } : {}) };
  }

  function documentHadFileOnDisk(documentName: string, base: string | undefined): boolean {
    return base !== undefined || docsWithFileObservedOnDisk.has(documentName);
  }

  function resolveStorePathPresence(
    documentName: string,
    path: string,
    base: string | undefined,
    candidate: string,
    callerAwaitingFlush: boolean,
  ): 'on-disk' | 'refused' {
    const probe = probeDocumentFileOnDisk(path);
    if ('error' in probe) {
      recordPathFault(documentName, probe.error, callerAwaitingFlush);
      log.error(
        { err: probe.error, documentName, path },
        `[persistence] Could not determine whether ${path} still exists; store abandoned`,
      );
      throw probe.error;
    }
    if (probe.onDisk) return 'on-disk';
    refuseRemovedDocPublish(documentName, base, candidate, callerAwaitingFlush);
    return 'refused';
  }

  function holdStorePending(
    documentName: string,
    reason: StorePendingReason,
    cause?: unknown,
    noBase = holdMeetsFileWithNoAgreedVersion(documentName),
  ): never {
    const held = new StoreHeldPendingError(documentName, reason, noBase, cause);
    incrementStoreDiskCompare(reason);
    compareLog.warn(
      { documentName, reason, code: held.causeCode, err: cause },
      `[store-compare] ${held.message}; the save stays pending and the file is untouched`,
    );
    durabilityState.markStoreRefused(documentName);
    persistenceDeferCounts.delete(documentName);
    throw held;
  }

  async function storeDocumentNow(store: {
    document: Y.Doc;
    documentName: string;
    lastTransactionOrigin: unknown;
  }): Promise<void> {
    let agentTriggered: boolean | undefined;
    for (let run = 1; ; run++) {
      const control: StoreRunControl = { agentTriggered, rerun: null };
      await storeDocumentRun(store, control);
      if (control.rerun === null) return;
      agentTriggered = control.agentTriggered;
      if (run >= MAX_STORE_COMPARE_RUNS) {
        const reason = control.rerun === 'base-moved' ? 'pending-base-moved' : 'pending-exhausted';
        try {
          holdStorePending(store.documentName, reason);
        } catch (held) {
          durabilityState.recordStoreFailure(store.documentName, toStoreFailure(held));
          throw held;
        }
      }
    }
  }

  async function storeDocumentRun(
    {
      document,
      documentName,
      lastTransactionOrigin,
    }: {
      document: Y.Doc;
      documentName: string;
      lastTransactionOrigin: unknown;
    },
    control: StoreRunControl,
  ): Promise<void> {
    ensureHistograms();
    const started = Date.now();
    let inFlightFlushValue: string | undefined;
    return withSpan(
      'persistence.onStoreDocument',
      { attributes: { 'doc.name': documentName } },
      async () => {
        const lifecycleStatus = frozenStatusOf(document, documentName);
        if (!isRemovalLifecycleStatus(lifecycleStatus)) frozenStoreBaselines.delete(documentName);
        if (lifecycleStatus !== null) {
          log.info(
            { documentName, lifecycleStatus },
            `[persistence] Skipped store for ${documentName}: lifecycle=${lifecycleStatus}`,
          );
          if (isRemovalLifecycleStatus(lifecycleStatus)) {
            const callerAwaitingFlush =
              control.agentTriggered ?? durabilityState.consumeAgentWriteStore(documentName);
            const base = durabilityState.getReconciledBase(documentName);
            const candidate = document.getText('source').toString();
            const baseline = base ?? frozenStoreBaselines.get(documentName);
            if (baseline === undefined) frozenStoreBaselines.set(documentName, candidate);
            if (callerAwaitingFlush || (baseline !== undefined && candidate !== baseline)) {
              refuseRemovedDocPublish(documentName, base, candidate, callerAwaitingFlush, {
                status: lifecycleStatus,
                removal: frozenRemovalOf(document, documentName, lifecycleStatus),
              });
            }
          }
          persistenceDeferCounts.delete(documentName);
          tripwireResetFailedDocs.delete(documentName);
          return;
        }

        const quiescent = isDocQuiescent(document);
        if (!quiescent) {
          const deferCount = persistenceDeferCounts.get(documentName) ?? 0;
          if (deferCount < QUIESCENCE_MAX_DEFER) {
            const ageMs = getMsSinceLastUserTx(document);
            console.warn(
              JSON.stringify({
                event: 'persistence-skip-non-quiescent',
                'doc.name': documentName,
                wallClockMsSinceLastTransaction: ageMs ?? null,
                deferCount,
              }),
            );
            incrementPersistenceSkipNonQuiescent();
            persistenceDeferCounts.set(documentName, deferCount + 1);
            if (control.agentTriggered) durabilityState.markAgentWriteStore(documentName);
            return;
          }
          console.warn(
            JSON.stringify({
              event: 'persistence-force-flush-during-burst',
              'doc.name': documentName,
              wallClockMsSinceLastTransaction: getMsSinceLastUserTx(document) ?? null,
              deferCount,
            }),
          );
          incrementPersistenceForceFlushDuringBurst();
        }

        const agentTriggeredStore =
          control.agentTriggered ?? durabilityState.consumeAgentWriteStore(documentName);
        control.agentTriggered = agentTriggeredStore;

        const { sv: stateVectorAtRead, json } = captureDocSnapshotForPersistence(document);
        const ytextSnapshot = document.getText('source').toString();
        let publicationReceipt: (() => void) | undefined;
        try {
          publicationReceipt = options?.capturePublicationReceipt?.(
            document,
            documentName,
            stateVectorAtRead,
          );
        } catch (err) {
          log.warn(
            { err, documentName },
            '[persistence] capturePublicationReceipt callback failed',
          );
        }
        const storeAttempt = durabilityState.beginStoreAttempt(documentName);

        const { frontmatter, body } = stripFrontmatter(ytextSnapshot);
        const markdown = prependFrontmatter(frontmatter, body);

        let normalizeEqual: boolean;
        let fragmentMarkdown: string | null = null;
        try {
          const fragmentBody = mgr.serialize(json);
          fragmentMarkdown = prependFrontmatter(frontmatter, fragmentBody);
          normalizeEqual = assertBridgeInvariant(markdown, fragmentMarkdown, {
            site: 'persistence',
            docName: documentName,
            suppressDevThrow: true,
            canonicalizeBody: createDocCanonicalizer(mgr, {
              resolveEmbed: options?.resolveEmbed,
              resolveSize: options?.resolveSize,
              docName: documentName,
            }),
          });
        } catch (err) {
          incrementPersistenceSanityCheckSerializeFailures();
          console.warn(
            JSON.stringify({
              event: 'persistence-sanity-check-serialize-failed',
              'doc.name': documentName,
              'error.type': err instanceof Error ? err.constructor.name : typeof err,
              timestamp: new Date().toISOString(),
            }),
          );
          log.warn(
            { err, documentName },
            `[persistence] Sanity-check serialize failed for ${documentName}; proceeding with ytext bytes`,
          );
          fragmentMarkdown = null;
          normalizeEqual = false;
        }
        if (!normalizeEqual) {
          const witness =
            fragmentMarkdown === null ? undefined : getConvergedFragmentWitness(document);
          if (
            fragmentMarkdown !== null &&
            witness !== undefined &&
            fragmentHoldsPendingContent(fragmentMarkdown, markdown, witness)
          ) {
            recordDeferHold(documentName, pendingContentLines(fragmentMarkdown, markdown, witness));
          } else {
            if (fragmentMarkdown !== null) {
              checkpointBeforeReconcile(
                document,
                documentName,
                fragmentMarkdown,
                markdown,
                witness !== undefined,
              );
            }
            reconcileFragmentNow(document, body, documentName);
          }
        }

        const currentBase = durabilityState.getReconciledBase(documentName);
        const normalizedMarkdown = normalizedSourceForm(ytextSnapshot);
        let markdownSemanticallyUnchanged =
          currentBase !== undefined &&
          (agentTriggeredStore
            ? markdown === currentBase
            : normalizedMarkdown === normalizeBridge(currentBase) &&
              !addsBlankLines(currentBase, markdown));
        if (
          !markdownSemanticallyUnchanged &&
          !agentTriggeredStore &&
          ephemeral &&
          currentBase !== undefined
        ) {
          const canonicalBase = canonicalizeForEphemeralBaseline(currentBase, documentName);
          if (canonicalBase !== null && normalizedMarkdown === canonicalBase) {
            markdownSemanticallyUnchanged = true;
          }
        }
        if (markdownSemanticallyUnchanged) {
          if (contributorCount() > 0) scheduleGitCommit();
          durabilityState.clearStoreRefused(documentName);
          persistenceDeferCounts.delete(documentName);
          return;
        }

        if (currentBase === undefined && normalizeBridge(markdown) === '') {
          log.warn(
            { documentName },
            `[persistence] Skipped phantom write for ${documentName}: empty Y.Doc with no reconciled base`,
          );
          persistenceDeferCounts.delete(documentName);
          return;
        }

        const writer = resolveWriterFromOrigin(lastTransactionOrigin, getPrincipal);
        if (writer && writer.id !== SERVICE_WRITER.id) {
          if (!hasContributor(writer.id)) {
            recordContributor(documentName, writer.id, writer.name, writer.id);
          }
        }

        let duplicationBaseline: string;
        if (currentBase === undefined) {
          const baselineRead = readTripwireDiskContent(documentName);
          if (baselineRead.kind === 'unavailable') {
            log.warn(
              { documentName, reason: baselineRead.reason },
              `[persistence] Tripwire baseline unavailable for ${documentName}; refusing store (fail-closed)`,
            );
            incrementPersistenceDuplicationBaselineRefusals();
            durabilityState.markStoreRefused(documentName);
            const refusal = new DuplicationBaselineUnavailableError(
              `duplication tripwire baseline unavailable for ${documentName}; store refused (fail-closed)`,
            );
            switch (baselineRead.reason) {
              case 'escape':
                recordPathFault(documentName, refusal, agentTriggeredStore, true);
                break;
              case 'read-failed':
                if (agentTriggeredStore) {
                  durabilityState.recordStoreFailure(documentName, {
                    code: OK_STORE_REFUSED,
                    message: refusal.message,
                  });
                }
                break;
              default: {
                const unhandled: never = baselineRead.reason;
                throw new Error(`unhandled tripwire baseline failure reason: ${String(unhandled)}`);
              }
            }
            throw refusal;
          }
          if (baselineRead.kind === 'missing' && documentHadFileOnDisk(documentName, undefined)) {
            incrementPersistenceDuplicationBaselineMissing();
            log.warn(
              { documentName },
              `[persistence] Tripwire has no baseline for ${documentName}: acknowledged base absent and file missing from disk; duplication check skipped`,
            );
          }
          duplicationBaseline = baselineRead.kind === 'ok' ? baselineRead.content : '';
        } else {
          duplicationBaseline = currentBase;
        }
        {
          const classification = classifyDuplication(markdown, duplicationBaseline);
          if (classification.kind === 'block' && docsWithSettledWrite.has(documentName)) {
            incrementPersistenceDuplicationSpared();
            console.warn(
              JSON.stringify({
                event: 'ok-persistence-duplication-spared',
                'doc.name': documentName,
                candidateBytes: markdown.length,
                baseBytes: duplicationBaseline.length,
                fragmentChildren: document.getXmlFragment('default').length,
                copies: classification.copies,
                reason: classification.reason,
              }),
            );
          } else if (classification.kind === 'block') {
            if (tripwireResetFailedDocs.has(documentName)) {
              log.warn(
                { documentName },
                `[persistence] Tripwire breaker active — skipping duplicate store for ${documentName}`,
              );
              return;
            }
            const fragmentChildren = document.getXmlFragment('default').length;
            console.warn(
              JSON.stringify({
                event: 'ok-persistence-duplication-blocked',
                'doc.name': documentName,
                candidateBytes: markdown.length,
                baseBytes: duplicationBaseline.length,
                fragmentChildren,
                copies: classification.copies,
                reason: classification.reason,
              }),
            );
            try {
              let diskContent: string;
              if (currentBase === undefined) {
                diskContent = duplicationBaseline;
              } else {
                const resetRead = readTripwireDiskContent(documentName);
                diskContent = resetRead.kind === 'ok' ? resetRead.content : currentBase;
              }
              checkpointBeforeDuplicationReset(
                document,
                documentName,
                markdown,
                classification.copies,
                fragmentChildren,
              );
              const lossRing = options?.getLossRing?.();
              const detect: DeriveLossDetectOptions = {
                baselineFullMd: diskContent,
                report: (obs) => {
                  try {
                    const dropped = detectPairedIntakeLoss(obs);
                    if (dropped.length === 0) return;
                    void lossRing?.record({
                      event: LOSS_EVENT_DETECTOR_TRIP,
                      docName: documentName,
                      writerId: FILE_SYSTEM_WRITER.id,
                      direction: 'b',
                      site: PERSISTENCE_DUPLICATION_SITE,
                      lostLen: dropped.reduce((n, s) => n + s.length, 0),
                      digest: fnv1aDigest(dropped.join('\n')),
                    });
                  } catch (detectErr) {
                    log.warn(
                      { documentName, err: detectErr },
                      '[persistence] duplication-reset loss detection failed',
                    );
                  }
                },
              };
              document.transact(() => {
                applyDiskContent(document, diskContent, undefined, undefined, undefined, detect);
              }, FILE_WATCHER_ORIGIN);
              tripwireResetFailedDocs.delete(documentName);
            } catch (err) {
              tripwireResetFailedDocs.add(documentName);
              log.error(
                { err, documentName },
                `[persistence] Tripwire reset failed for ${documentName}`,
              );
            }
            persistenceDeferCounts.delete(documentName);
            return;
          }
        }

        inFlightFlushValue = normalizeBridge(markdown);
        durabilityState.beginInFlightFlush(documentName, inFlightFlushValue);

        let requestedPath: string;
        try {
          requestedPath = safeContentPath(documentName, contentDir);
          options?.assertContentPath?.(requestedPath);
        } catch (error) {
          if (error instanceof NestedProjectScopeError && markdown === currentBase) {
            persistenceDeferCounts.delete(documentName);
            return;
          }
          recordPathFault(documentName, error, agentTriggeredStore);
          throw error;
        }
        if (
          documentHadFileOnDisk(documentName, currentBase) &&
          resolveStorePathPresence(
            documentName,
            requestedPath,
            currentBase,
            markdown,
            agentTriggeredStore,
          ) === 'refused'
        ) {
          return;
        }
        await tracedMkdir(dirname(requestedPath), { recursive: true });

        let canonicalPath: string;
        try {
          canonicalPath = await realpath(requestedPath);
        } catch (e) {
          const code = errnoCode(e);
          if (code === 'ENOENT') {
            let isBrokenSymlink = false;
            try {
              isBrokenSymlink = lstatSync(requestedPath).isSymbolicLink();
            } catch (lstatErr) {
              if (errnoCode(lstatErr) !== 'ENOENT') {
                log.warn(
                  { err: lstatErr, path: requestedPath },
                  '[persistence] lstat failed during broken-symlink check',
                );
              }
            }
            if (isBrokenSymlink) {
              log.warn(
                { docName: documentName, reason: 'broken-symlink' },
                '[persistence] broken-symlink fallback',
              );
            }
            canonicalPath = requestedPath;
          } else if (code === 'ELOOP') {
            recordPathFault(documentName, e, agentTriggeredStore);
            log.error(
              { docName: documentName, path: requestedPath, err: e },
              `[persistence] Symlink cycle at ${requestedPath}`,
            );
            throw new Error(`Symlink cycle detected at ${requestedPath}`);
          } else {
            recordPathFault(documentName, e, agentTriggeredStore);
            log.error(
              { docName: documentName, path: requestedPath, err: e },
              `[persistence] Could not canonicalize ${requestedPath}; store abandoned`,
            );
            throw e;
          }
        }

        const checkedPath =
          canonicalPath === requestedPath
            ? join(await realpath(dirname(requestedPath)), basename(requestedPath))
            : canonicalPath;
        const outsideContent = !isWithinContentDir(checkedPath, contentDir);
        if (outsideContent || resolvesIntoPrivateState(requestedPath, checkedPath, contentDir)) {
          const msg = `symlink-escape: ${requestedPath} resolves to ${checkedPath} ${outsideContent ? `outside ${contentDir}` : 'inside private repository state'}`;
          log.error(
            {
              docName: documentName,
              originalPath: requestedPath,
              canonical: checkedPath,
              contentDir,
            },
            `[persistence] ${msg}`,
          );
          const escapeErr = new Error(msg);
          recordPathFault(documentName, escapeErr, agentTriggeredStore, true);
          throw escapeErr;
        }

        if (
          process.env.NODE_ENV === 'test' &&
          process.env.OK_TEST_STORE_DIVERGENCE === documentName
        ) {
          await tracedWriteFile(canonicalPath, '# NATIVE\n\nnative-divergence-injected\n', 'utf-8');
        }

        if (
          documentHadFileOnDisk(documentName, currentBase) &&
          resolveStorePathPresence(
            documentName,
            canonicalPath,
            currentBase,
            markdown,
            agentTriggeredStore,
          ) === 'refused'
        ) {
          return;
        }

        const tmpPath = atomicTempPath(canonicalPath);
        let storedObservation: FileObservation | undefined;
        try {
          if (process.env.NODE_ENV === 'test' && process.env.OK_TEST_STORE_FAULT === documentName) {
            const faultErr = new Error(
              `OK_TEST_STORE_FAULT: simulated disk failure for ${documentName}`,
            ) as NodeJS.ErrnoException;
            faultErr.code = 'ENOSPC';
            throw faultErr;
          }
          await tracedWriteFile(tmpPath, markdown, 'utf-8');
          const discardTemp = (reason: string): void => {
            try {
              tracedUnlinkSync(tmpPath);
            } catch (cleanupErr) {
              if (errnoCode(cleanupErr) !== 'ENOENT') {
                log.warn(
                  { err: cleanupErr, docName: documentName, path: tmpPath },
                  `[persistence] could not remove the temp file after ${reason}`,
                );
              }
            }
          };
          const readForCompare = compareReaderFor(documentName);
          let compared: DiskCompareOutcome;
          for (let attempt = 0; ; attempt++) {
            if (
              documentHadFileOnDisk(documentName, currentBase) &&
              resolveStorePathPresence(
                documentName,
                canonicalPath,
                currentBase,
                markdown,
                agentTriggeredStore,
              ) === 'refused'
            ) {
              discardTemp('refusing the publish');
              return;
            }
            compared = compareDiskBeforeReplace(
              {
                path: canonicalPath,
                receiptHash: durabilityState.getReceipt(documentName)?.hash,
                baseHash: currentBase === undefined ? undefined : contentHash(currentBase),
                candidateHash: contentHash(markdown),
              },
              readForCompare,
            );
            const retryDelayMs = COMPARE_READ_RETRY_DELAYS_MS[attempt];
            if (
              compared.kind !== 'unreadable' ||
              !compared.transient ||
              retryDelayMs === undefined
            ) {
              break;
            }
            incrementStoreDiskCompareReadRetries();
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
          if (
            (compared.kind === 'drift' ||
              (compared.kind === 'match' && !compared.alreadyCandidate)) &&
            durabilityState.getReconciledBase(documentName) !== currentBase &&
            durabilityState.getReceipt(documentName)?.via !== 'own-write'
          ) {
            discardTemp('the acknowledged base moved during the store');
            compareLog.debug(
              { documentName },
              `[store-compare] ${documentName}: an intake moved the acknowledged version while the store ran; storing again from a fresh snapshot`,
            );
            control.rerun = 'base-moved';
            return;
          }
          let comparedObservation: FileObservation | null;
          switch (compared.kind) {
            case 'match':
              incrementStoreDiskCompare('match');
              comparedObservation = compared.observation;
              break;
            case 'drift':
              incrementStoreDiskCompare('drift');
              if (currentBase !== undefined) {
                durabilityState.setReconciledBase(documentName, currentBase, compared.observation);
              }
              comparedObservation = compared.observation;
              break;
            case 'absent':
              incrementStoreDiskCompare('absent');
              if (documentHadFileOnDisk(documentName, currentBase)) {
                discardTemp('the file vanished before the publish');
                control.rerun = 'disk-changed';
                return;
              }
              comparedObservation = null;
              break;
            case 'unreadable':
              discardTemp('an unreadable pre-write compare');
              return holdStorePending(documentName, 'pending-unreadable', compared.error);
            case 'changed': {
              discardTemp('finding an outside change before the publish');
              if (
                refuseStaleExternalWrite(
                  durabilityState,
                  document,
                  documentName,
                  compared.text,
                  options?.conflicts,
                  markdown,
                )
              ) {
                incrementStoreDiskCompare('stale-refused');
                if (agentTriggeredStore) {
                  durabilityState.recordStaleExternalWriteFreeze(documentName);
                }
                persistenceDeferCounts.delete(documentName);
                return;
              }
              incrementStoreDiskCompare('changed');
              const ingest = options.ingestDiskAtStore;
              if (ingest === null) return holdStorePending(documentName, 'pending-no-intake');
              compareLog.info(
                {
                  documentName,
                  diskBytes: Buffer.byteLength(compared.text, 'utf8'),
                  candidateBytes: Buffer.byteLength(markdown, 'utf8'),
                },
                `[store-compare] ${documentName} changed on disk since the last agreed version; merging it before the write`,
              );
              const intake = await ingest(documentName, canonicalPath, compared.text);
              switch (intake.kind) {
                case 'taken-in':
                  if (agentTriggeredStore && intake.merge !== undefined) {
                    durabilityState.recordStoreIntake(
                      documentName,
                      intake.merge,
                      writtenThroughOf(document),
                    );
                  }
                  persistenceDeferCounts.delete(documentName);
                  control.rerun = 'disk-changed';
                  return;
                case 'conflict':
                  return holdStorePending(documentName, 'pending-conflict');
                case 'failed':
                  return holdStorePending(
                    documentName,
                    currentBase === undefined
                      ? 'pending-intake-failed-no-base'
                      : 'pending-intake-failed',
                    intake.error,
                    currentBase === undefined,
                  );
                default:
                  return assertNeverStoreIntake(intake);
              }
            }
            default:
              return assertNeverDiskCompare(compared);
          }
          let outcome: StorePublishOutcome;
          try {
            outcome = durabilityState.tryPublishStore(storeAttempt, () => {
              assertProjectContentScope(canonicalPath, contentDir);
              options?.assertContentPath?.(canonicalPath);
              if (
                process.env.NODE_ENV === 'test' &&
                process.env.OK_TEST_STORE_RESTAT_RACE === documentName
              ) {
                delete process.env.OK_TEST_STORE_RESTAT_RACE;
                tracedAppendFileSync(canonicalPath, '\nrestat-race-injected\n', 'utf-8');
              }
              const restat = restatFile(canonicalPath, comparedObservation);
              if (restat.kind === 'failed') {
                throw new StoreRestatFailedError(documentName, restat.error);
              }
              if (restat.kind === 'moved') throw new StoreRestatRefusedError(documentName);
              storedObservation = statObservation(tmpPath);
              tracedRenameSync(tmpPath, canonicalPath);
            });
          } catch (publishErr) {
            if (publishErr instanceof StoreRestatFailedError) {
              discardTemp('a failed re-stat');
              return holdStorePending(documentName, 'pending-unreadable', publishErr.cause);
            }
            if (!(publishErr instanceof StoreRestatRefusedError)) throw publishErr;
            discardTemp('a refused re-stat');
            incrementStoreRestatRefused();
            compareLog.warn(
              { documentName },
              `[store-compare] ${documentName} changed between the compare and the rename; the write was refused and the store runs again`,
            );
            persistenceDeferCounts.delete(documentName);
            control.rerun = 'disk-changed';
            return;
          }
          if (outcome !== 'published') {
            try {
              tracedUnlinkSync(tmpPath);
            } catch (cleanupErr) {
              if (errnoCode(cleanupErr) !== 'ENOENT') {
                log.warn(
                  { err: cleanupErr, docName: documentName, path: tmpPath },
                  '[persistence] could not remove the temp file after dropping the refused publish',
                );
              }
            }
            persistenceDeferCounts.delete(documentName);
            if (outcome === 'reentrant') {
              console.warn(
                JSON.stringify({
                  event: 'persistence-store-reentrant-refused',
                  'doc.name': documentName,
                  generation: storeAttempt.generation,
                  baseBytes: currentBase?.length ?? null,
                  candidateBytes: markdown.length,
                }),
              );
              return;
            }
            if (outcome === 'stale') {
              incrementPersistenceStoreSuperseded();
              console.warn(
                JSON.stringify({
                  event: 'persistence-store-superseded',
                  'doc.name': documentName,
                  generation: storeAttempt.generation,
                  baseBytes: currentBase?.length ?? null,
                  candidateBytes: markdown.length,
                }),
              );
              return;
            }
            return assertNeverStorePublishOutcome(outcome);
          }
          registerWrite(canonicalPath, contentHash(markdown));
          durabilityState.clearStoreFailure(documentName);
          incrementPersistenceDiskWrite();
          try {
            publicationReceipt?.();
          } catch (err) {
            log.warn(
              { err, documentName },
              '[persistence] capturePublicationReceipt receipt completion failed',
            );
          }
          try {
            onDiskFlush?.(documentName, stateVectorAtRead, markdown, currentBase ?? null);
          } catch (flushErr) {
            log.warn(
              { err: flushErr, documentName },
              `[persistence] onDiskFlush callback failed for ${documentName}`,
            );
          }
        } catch (e) {
          try {
            tracedUnlinkSync(tmpPath);
          } catch {}
          persistenceDeferCounts.delete(documentName);
          if (!(typeof e === 'object' && e !== null && abandonmentsRecorded.has(e))) {
            durabilityState.recordStoreFailure(documentName, toStoreFailure(e));
          }
          log.error({ err: e, documentName }, `[persistence] Failed to save ${documentName}`);
          throw e;
        }
        log.info(
          { filePath: canonicalPath, bytes: markdown.length },
          `[persistence] Wrote ${canonicalPath} (${markdown.length} bytes)`,
        );

        durabilityState.recordSuccessfulStore(
          documentName,
          markdown,
          agentTriggeredStore && currentBase !== undefined && currentBase !== markdown
            ? currentBase
            : undefined,
          storedObservation,
        );
        docsWithSettledWrite.add(documentName);
        docsWithFileObservedOnDisk.add(documentName);
        tripwireResetFailedDocs.delete(documentName);
        durabilityState.clearStoreRefused(documentName);
        persistenceDeferCounts.delete(documentName);

        derivedDocumentIndex?.recordDurableStore(documentName, markdown).catch((err: unknown) => {
          if (isDerivedDocumentIndexClosedError(err)) {
            log.debug(
              { err, documentName },
              '[derived-index] coordinator closed; skipping durable-store projection',
            );
            return;
          }
          log.warn(
            { err, documentName },
            '[derived-index] durable-store projection failed; disk write remains authoritative',
          );
        });

        setActiveSpanAttributes({ 'persistence.bytes': markdown.length });
        scheduleGitCommit();
      },
    ).finally(() => {
      if (inFlightFlushValue !== undefined) {
        durabilityState.finishInFlightFlush(documentName, inFlightFlushValue);
      }
      storeDurationHist?.record((Date.now() - started) / 1000);
    });
  }

  function deferStore({
    document,
    documentName,
    lastTransactionOrigin,
  }: {
    document: Y.Doc;
    documentName: string;
    lastTransactionOrigin: unknown;
  }): void {
    deferredStores.set(documentName, {
      branch: durabilityState.getActiveBranch(),
      document,
      lastTransactionOrigin,
      settlement:
        deferredStores.get(documentName)?.settlement ??
        durabilityState.openDeferredStore(documentName),
    });
  }

  function discardDeferredStores(): void {
    for (const entry of deferredStores.values()) {
      entry.settlement.settle({ kind: 'discarded', cause: { kind: 'branch-switch' } });
    }
    deferredStores.clear();
  }

  function discardDeferredStore(documentName: string, cause: DeferredStoreDiscardCause): void {
    deferredStores.get(documentName)?.settlement.settle({ kind: 'discarded', cause });
    deferredStores.delete(documentName);
  }

  const isStoreHeld = (documentName: string): boolean =>
    durabilityState.areStoresHeld(documentName);

  function hasUnheldDeferredStores(): boolean {
    for (const documentName of deferredStores.keys()) {
      if (!isStoreHeld(documentName)) return true;
    }
    return false;
  }

  async function flushDeferredStores(mode: 'within-branch' | 'discard-stale' = 'within-branch') {
    if (mode === 'discard-stale') discardDeferredStores();
    if (deferredStoreDrainInFlight) {
      pendingDeferredStoreFlushMode =
        pendingDeferredStoreFlushMode === 'discard-stale' || mode === 'discard-stale'
          ? 'discard-stale'
          : 'within-branch';
      return deferredStoreDrainInFlight;
    }

    deferredStoreDrainInFlight = (async () => {
      let drainMode = mode;
      while (true) {
        if (drainMode === 'discard-stale') discardDeferredStores();
        const entries = [...deferredStores.entries()].filter(([name]) => !isStoreHeld(name));
        for (const [documentName] of entries) deferredStores.delete(documentName);

        if (drainMode !== 'discard-stale') {
          for (const [documentName, entry] of entries) {
            if (entry.branch !== durabilityState.getActiveBranch()) {
              entry.settlement.settle({ kind: 'discarded', cause: { kind: 'branch-switch' } });
              continue;
            }
            let outcome: DeferredStoreOutcome = { kind: 'completed' };
            try {
              await storeDocumentNow({
                document: entry.document,
                documentName,
                lastTransactionOrigin: entry.lastTransactionOrigin,
              });
            } catch (err) {
              outcome = { kind: 'failed', failure: toStoreFailure(err) };
              const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
              let rawMessage = '';
              try {
                rawMessage = String((err as { message?: unknown } | null)?.message ?? '');
              } catch {
                rawMessage = '';
              }
              const errorMessageHash = fnv1aDigest(rawMessage);
              let errorClass: DeferredStoreErrorClass;
              try {
                errorClass = classifyDeferredStoreError(err);
              } catch (classifyErr) {
                const rawClassifyMessage = String(
                  (classifyErr as { message?: unknown } | null)?.message ?? '',
                );
                console.warn(
                  JSON.stringify({
                    event: 'deferred-store-classifier-failed',
                    'doc.name': documentName,
                    classifyErrorHash: fnv1aDigest(rawClassifyMessage),
                    errorMessageHash,
                    ...(verbose ? { classifyErrorMessage: rawClassifyMessage } : {}),
                    timestamp: new Date().toISOString(),
                  }),
                );
                errorClass = 'unknown';
              }
              incrementDeferredStoreFailures();
              console.warn(
                JSON.stringify({
                  event: 'deferred-store-failed',
                  'doc.name': documentName,
                  errorClass,
                  errorMessageHash,
                  ...(verbose ? { errorMessage: rawMessage } : {}),
                  timestamp: new Date().toISOString(),
                }),
              );
              log.error(
                { err, documentName },
                `[persistence] Deferred store failed for ${documentName}`,
              );
            } finally {
              entry.settlement.settle(outcome);
            }
          }
        }

        const nextMode = pendingDeferredStoreFlushMode;
        pendingDeferredStoreFlushMode = null;
        if (!hasUnheldDeferredStores() && nextMode === null) break;
        drainMode = nextMode ?? 'within-branch';
      }
    })().finally(() => {
      deferredStoreDrainInFlight = null;
    });

    return deferredStoreDrainInFlight;
  }

  const extension: Extension = {
    async onLoadDocument({ document, documentName, context: _context }) {
      docsWithSettledWrite.delete(documentName);
      docsWithFileObservedOnDisk.delete(documentName);
      frozenStoreBaselines.delete(documentName);
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        loadConfigDoc(document, documentName, configPersistenceCtx);
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        loadManagedArtifactDoc(document, documentName, managedArtifactCtx);
        return;
      }
      options?.assertContentPath?.(safeContentPath(documentName, contentDir));
      if (
        isMermaidDoc(documentName) ||
        isExcalidrawDoc(documentName) ||
        isEditableTextDoc(documentName)
      ) {
        loadMermaidDoc(document, documentName, mermaidPersistenceCtx);
        return;
      }
      ensureHistograms();
      const started = Date.now();
      return withSpan(
        'persistence.onLoadDocument',
        { attributes: { 'doc.name': documentName } },
        async () => {
          log.info(
            { documentName, connections: document.getConnectionsCount?.() ?? '?' },
            `[persistence] onLoadDocument called for ${documentName} (connections: ${document.getConnectionsCount?.() ?? '?'})`,
          );
          const filePath = safeContentPath(documentName, contentDir);
          options?.assertContentPath?.(filePath);
          if (!existsSync(filePath)) return;
          docsWithFileObservedOnDisk.add(documentName);

          let canonical: string;
          try {
            canonical = resolveNativePath(filePath);
          } catch (e) {
            const code = errnoCode(e);
            if (code === 'ELOOP') {
              log.warn(
                { path: filePath },
                `[persistence] Symlink cycle on load: ${filePath}, refusing`,
              );
              return;
            }
            log.warn(
              { path: filePath, code },
              `[persistence] Could not resolve ${filePath} on load (${code}), refusing`,
            );
            return;
          }
          if (
            !isWithinContentDir(canonical, contentDir) ||
            resolvesIntoPrivateState(filePath, canonical, contentDir)
          ) {
            log.warn(
              { path: filePath, canonical },
              `[persistence] symlink-escape on load: ${filePath} → ${canonical}, refusing`,
            );
            return;
          }

          const fileSize = statSync(canonical).size;
          if (fileSize > DOCUMENT_OPEN_BYTE_LIMIT) {
            log.warn(
              { documentName, fileSize, limit: DOCUMENT_OPEN_BYTE_LIMIT },
              '[persistence] Document exceeds open byte limit; refusing to load',
            );
            throw new DocumentOpenSizeLimitError(documentName, fileSize);
          }

          const raw = readFileSync(filePath, 'utf-8');
          const currentBase = durabilityState.getReconciledBase(documentName);
          const staleExternalWrite = refuseStaleExternalWrite(
            durabilityState,
            document,
            documentName,
            raw,
            options?.conflicts,
          );
          let contentToLoad = raw;
          if (staleExternalWrite) {
            const retainedContent =
              durabilityState.getStaleExternalWrite(documentName)?.retainedContent ?? currentBase;
            if (retainedContent === undefined) {
              throw new Error(
                `Missing acknowledged content for stale external write: ${documentName}`,
              );
            }
            contentToLoad = retainedContent;
          }

          const xmlFragment = document.getXmlFragment('default');
          log.info(
            { documentName, fragmentLength: xmlFragment.length },
            `[persistence] onLoadDocument ${documentName}: fragment.length=${xmlFragment.length} before update`,
          );

          if (xmlFragment.length === 0) {
            document.transact(() => {
              applyDiskContentToDoc(
                document,
                contentToLoad,
                options?.resolveEmbed,
                documentName,
                options?.resolveSize,
              );
              document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
            }, FILE_WATCHER_ORIGIN);
            log.info(
              { filePath, children: xmlFragment.length },
              `[persistence] Loaded ${filePath} into Y.Doc (${xmlFragment.length} children)`,
            );
            xmlFragment.observeDeep(() => {
              log.info(
                { documentName, fragmentLength: xmlFragment.length },
                `[persistence] MUTATION on ${documentName}: fragment.length=${xmlFragment.length}`,
              );
            });
          } else {
            log.info(
              { documentName, children: xmlFragment.length },
              `[persistence] Skipped load for ${documentName} — fragment already has ${xmlFragment.length} children`,
            );
          }

          if (!staleExternalWrite) {
            if (durabilityState.checkReceiptAtLoad(documentName, raw) === 'changed') {
              compareLog.info(
                { documentName },
                `[store-compare] ${documentName} changed on disk since its last agreed version; loaded the disk version`,
              );
            }
            durabilityState.setReconciledBase(documentName, raw);
          }
        },
      ).finally(() => {
        loadDurationHist?.record((Date.now() - started) / 1000);
      });
    },

    /*
     * STOP: Do NOT add additional `Y.encodeStateVector(document)` calls
     * anywhere in this function. The only sanctioned capture is via
     * `captureDocSnapshotForPersistence` at the top of the body — its
     * co-capture of `{sv, json}` is what guarantees the disk-ack
     * watermark reflects the exact doc state that lands on disk. A
     * second SV captured later (e.g., after the `await tracedWriteFile`
     * that stages the temp file) would include updates from the async
     * write window, falsely advancing the watermark past content that's
     * NOT durably persisted, and clients would drop those bytes from
     * the recycle buffer → unsynced-edit loss on server-restart.
     */
    async onStoreDocument({
      document,
      documentName,
      lastTransactionOrigin,
      lastContext: _lastContext,
    }) {
      if (isSystemDoc(documentName)) return;
      if (
        isConfigDoc(documentName) ||
        isManagedArtifactDoc(documentName) ||
        isEnginelessDoc(documentName)
      ) {
        await storeOutsideContentPipeline(document, documentName, lastTransactionOrigin);
        return;
      }
      if (durabilityState.isBatchInProgress() || isStoreHeld(documentName)) {
        deferStore({ document, documentName, lastTransactionOrigin });
        return;
      }
      return storeDocumentNow({
        document,
        documentName,
        lastTransactionOrigin,
      });
    },
  };

  async function waitForPendingCommits(): Promise<void> {
    if (commitInFlight) await commitInFlight;
  }

  async function flushContributors(): Promise<void> {
    while (commitInFlight) {
      await commitInFlight;
    }
    if (contributorCount() === 0) return;
    commitInFlight = commitToWipRef().finally(() => {
      commitInFlight = null;
      if (pendingAfterCommit) {
        pendingAfterCommit = false;
        scheduleGitCommit();
      }
    });
    await commitInFlight;
  }

  function getQueueDepths(): PersistenceQueueDepths {
    return {
      branchDeferred: deferredStores.size,
      quiescenceDeferred: persistenceDeferCounts.size,
    };
  }

  function isEnginelessDoc(documentName: string): boolean {
    return (
      isMermaidDoc(documentName) || isExcalidrawDoc(documentName) || isEditableTextDoc(documentName)
    );
  }

  const heldSaves = new Map<string, SaveHold>();

  function surfaceHeldSave(documentName: string, hold: SaveHold, causeChanged: boolean): void {
    const cause = visibleHoldCause(hold);
    if (cause === null) return;
    if (!isConfigDoc(documentName)) {
      options.mergeHistory?.noticeHeld(documentName, cause);
      return;
    }
    if (!causeChanged) return;
    const file = displayPathFor(
      configDocAbsPath(documentName, configPersistenceCtx),
      projectDir,
      configPersistenceCtx.homedirOverride ?? homedir(),
    );
    options.onConfigRejected?.(documentName, { code: 'SAVE_HELD', cause, file });
  }

  function settleHeldSave(documentName: string, settlement: StoreSettlement): void {
    if (settlement === 'neutral') return;
    if (settlement === 'resolved') {
      durabilityState.clearStoreRefused(documentName);
      heldSaves.delete(documentName);
      if (!isConfigDoc(documentName)) options.mergeHistory?.clearHeld(documentName);
      return;
    }
    incrementHeldSave();
    durabilityState.markStoreRefused(documentName);
    const previous = heldSaves.get(documentName);
    heldSaves.set(documentName, settlement);
    const causeChanged = previous?.cause !== settlement.cause;
    if (causeChanged && settlement.cause === 'not-utf8') {
      log.warn(
        { documentName },
        '[persistence] the file changed outside to bytes that are not valid UTF-8, so the save is held; it is tried again when the file changes',
      );
    }
    surfaceHeldSave(documentName, settlement, causeChanged);
  }

  function isHeldSaveDue(documentName: string): boolean {
    if (!durabilityState.isStoreRefused(documentName)) return false;
    const hold = heldSaves.get(documentName);
    if (hold?.cause !== 'not-utf8') return true;
    return restatFile(hold.path, hold.observation).kind !== 'same';
  }

  async function storeOutsideContentPipeline(
    document: Y.Doc,
    documentName: string,
    lastTransactionOrigin: unknown,
  ): Promise<void> {
    const retry = lastTransactionOrigin === null;
    if (isConfigDoc(documentName)) {
      const outcome = await storeConfigDoc(
        document,
        documentName,
        lastTransactionOrigin,
        configPersistenceCtx,
      );
      settleHeldSave(documentName, configSettlement(outcome, retry));
      if (outcome === 'persisted' || outcome === 'reconciled') {
        try {
          onConfigPersisted?.(documentName);
        } catch (err) {
          log.warn({ err, documentName }, '[persistence] onConfigPersisted callback failed');
        }
      }
      return;
    }
    const agentTriggered = durabilityState.consumeAgentWriteStore(documentName);
    if (isManagedArtifactDoc(documentName)) {
      const outcome = await storeManagedArtifactDoc(
        document,
        documentName,
        lastTransactionOrigin,
        managedArtifactCtx,
      );
      if (agentTriggered) recordOutsideStoreForAgentWrite(document, documentName, outcome);
      settleHeldSave(documentName, managedArtifactSettlement(outcome, retry));
      if (storeManagedArtifactWroteFile(outcome)) {
        const writer = resolveWriterFromOrigin(lastTransactionOrigin, getPrincipal);
        if (writer && writer.id !== SERVICE_WRITER.id && !writer.id.startsWith('agent-')) {
          const attribution = managedArtifactContributorAttribution(documentName);
          if (attribution) {
            recordContributor(
              attribution.docKey,
              writer.id,
              writer.name,
              writer.id,
              attribution.subject,
            );
            scheduleGitCommit();
          }
        }
        try {
          onManagedSkillPersisted?.(documentName);
        } catch (err) {
          log.warn({ err, documentName }, '[persistence] onManagedSkillPersisted callback failed');
        }
      }
      return;
    }
    options?.assertContentPath?.(safeContentPath(documentName, contentDir));
    const outcome = await storeMermaidDoc(
      document,
      documentName,
      lastTransactionOrigin,
      mermaidPersistenceCtx,
    );
    if (agentTriggered) recordOutsideStoreForAgentWrite(document, documentName, outcome);
    settleHeldSave(documentName, enginelessSettlement(outcome, retry));
  }

  function recordOutsideStoreForAgentWrite(
    document: Y.Doc,
    documentName: string,
    outcome: StoreMermaidOutcome | StoreManagedArtifactOutcome,
  ): void {
    if (typeof outcome === 'object') {
      const hold = OUTSIDE_STORE_HOLDS[outcome.cause];
      durabilityState.recordStoreFailure(documentName, {
        code: OK_STORE_HELD,
        message: `${documentName} was not saved: ${hold.description}`,
        held: { reason: hold.reason },
      });
      return;
    }
    switch (outcome) {
      case 'persisted':
      case 'no-op':
      case 'unchanged':
        return;
      case 'applied':
      case 'outside-taken-in':
        durabilityState.recordStoreIntake(documentName, 'clean', writtenThroughOf(document));
        return;
      case 'dropped-legacy-name':
      case 'dropped-unresolvable':
      case 'dropped-container-gone':
      case 'dropped-intake-landed': {
        const drop = OUTSIDE_STORE_DROPS[outcome];
        durabilityState.recordStoreFailure(documentName, {
          code: OK_WRITE_DROPPED,
          message: `${documentName} was not saved: ${drop.description}`,
          dropped: drop.cause,
        });
        return;
      }
      case 'merged':
      case 'both-kept':
        durabilityState.recordStoreIntake(documentName, outcome, writtenThroughOf(document));
        return;
      case 'kept-live':
      case 'stash-fallback':
        durabilityState.recordStoreIntake(documentName, 'kept-live', writtenThroughOf(document));
        return;
      case 'write-failed':
        durabilityState.recordStoreFailure(documentName, {
          message: `${documentName} was not saved: its file could not be written`,
        });
        return;
      default:
        assertNeverStoreOutcome(outcome);
    }
  }

  async function retryHeldSave(document: Y.Doc, documentName: string): Promise<void> {
    if (
      !isConfigDoc(documentName) &&
      !isManagedArtifactDoc(documentName) &&
      !isEnginelessDoc(documentName)
    ) {
      return;
    }
    await storeOutsideContentPipeline(document, documentName, null);
  }

  async function forceStore(document: Y.Doc, documentName: string): Promise<void> {
    if (isPersistenceExcludedDoc(documentName)) {
      return;
    }
    if (durabilityState.isBatchInProgress() || isStoreHeld(documentName)) {
      deferStore({ document, documentName, lastTransactionOrigin: null });
      return;
    }
    return storeDocumentNow({ document, documentName, lastTransactionOrigin: null });
  }

  function forgetObservedFile(docName: string): void {
    docsWithFileObservedOnDisk.delete(docName);
  }

  return {
    extension,
    durabilityState,
    flushDeferredStores,
    discardDeferredStore,
    flushPendingGitCommit,
    flushContributors,
    waitForPendingCommits,
    getQueueDepths,
    forceStore,
    forgetObservedFile,
    configPersistenceCtx,
    managedArtifactCtx,
    mermaidPersistenceCtx,
    retryHeldSave,
    isHeldSaveDue,
    hasHeldSave: (documentName) => heldSaves.has(documentName),
  };
}
