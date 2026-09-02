import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
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
  pendingContentLines,
  prependFrontmatter,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
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
import { type ConfigPersistenceCtx, loadConfigDoc, storeConfigDoc } from './config-persistence.ts';
import { frozenDocLifecycleStatus } from './conflict-errors.ts';
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
import type { DerivedDocumentIndexPersistencePort } from './derived-document-index.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';
import { DocumentDurabilityState, type StoreFailure } from './document-durability-state.ts';
import { contentHash, registerWrite } from './file-watcher.ts';
import { tracedMkdir, tracedRename, tracedUnlinkSync, tracedWriteFile } from './fs-traced.ts';
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
  managedArtifactContributorAttribution,
  managedArtifactTimelinePaths,
  storeManagedArtifactDoc,
} from './managed-artifact-persistence.ts';
import { mdManager, schema } from './md-manager.ts';
import {
  loadMermaidDoc,
  type MermaidPersistenceCtx,
  storeMermaidDoc,
} from './mermaid-persistence.ts';
import {
  incrementDeferredStoreFailures,
  incrementGitAutoSaveFailure,
  incrementGitWriterCommitFailure,
  incrementManagedArtifactReconcileCheckpointCreated,
  incrementManagedArtifactReconcileDeduped,
  incrementPersistenceDeferHold,
  incrementPersistenceDiskWrite,
  incrementPersistenceDivergenceRealign,
  incrementPersistenceDivergenceRealignCheckpointCreated,
  incrementPersistenceDivergenceRealignDeduped,
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
} from './metrics.ts';
import { toPosix } from './path-utils.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { backfillRenameLogCommitSha, getOrLoadRenameLogIndex } from './rename-log.ts';
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
import { getMeter, setActiveSpanAttributes, withSpan } from './telemetry.ts';

const log = getLogger('persistence');

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
 * Derive a WriterIdentity from a Hocuspocus transaction origin.
 *
 * Called from onStoreDocument to determine which writer triggered the store.
 * Handles the three origin shapes Hocuspocus surfaces:
 *   - local  + context.session_id  → per-session agent writer
 *   - local  + context.origin      → classified service writer
 *   - connection + principalId     → human-browser principal writer
 *
 * precedent #1 — origins are LocalTransactionOrigin object refs, not strings.
 * Exported for unit-testing the dispatch table without spinning up a server.
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

const DEFERRED_STORE_ERROR_CLASSES = [
  'disk-write',
  'serialize',
  'reconcile',
  'parse-fallback',
  'traced-rename',
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
  projectDir: string;
  durabilityState?: DocumentDurabilityState;
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
  ephemeral?: boolean;
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

function toStoreFailure(err: unknown): StoreFailure {
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
  flushPendingGitCommit: () => Promise<void>;
  flushContributors: () => Promise<void>;
  waitForPendingCommits: () => Promise<void>;
  getQueueDepths: () => PersistenceQueueDepths;
  forceStore: (document: Y.Doc, documentName: string) => Promise<void>;
  readonly configPersistenceCtx: ConfigPersistenceCtx;
  readonly managedArtifactCtx: ManagedArtifactCtx;
}

export function createPersistenceExtension(options?: PersistenceOptions): PersistenceHandle {
  const durabilityState = options?.durabilityState ?? new DocumentDurabilityState();
  const contentDirRaw = options?.contentDir ?? process.cwd();
  let contentDir: string;
  try {
    contentDir = realpathSync(contentDirRaw);
  } catch {
    contentDir = contentDirRaw;
  }
  const projectDir = options?.projectDir ?? process.cwd();
  const shadowRef = options?.shadowRef;
  const contentRoot = options?.contentRoot ?? (toPosix(relative(projectDir, contentDir)) || '.');
  const derivedDocumentIndex = options?.derivedDocumentIndex;
  const getPrincipal = options?.getPrincipal;
  const onAgentCommit = options?.onAgentCommit;
  const onFlushCommit = options?.onFlushCommit;
  const onDiskFlush = options?.onDiskFlush;
  const onConfigPersisted = options?.onConfigPersisted;
  const onManagedSkillPersisted = options?.onManagedSkillPersisted;
  const mgr = options?.mdManager ?? mdManager;
  const ephemeral = options?.ephemeral ?? false;

  const configLkgCache = new Map<string, string>();
  const configPersistenceCtx: ConfigPersistenceCtx = {
    projectDir,
    contentDir,
    lkgCache: configLkgCache,
    homedirOverride: options?.configHomedirOverride,
    onConfigRejected: options?.onConfigRejected,
    ephemeral,
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
  };

  const mermaidLkgCache = new Map<string, string>();
  const mermaidPersistenceCtx: MermaidPersistenceCtx = {
    contentDir,
    lkgCache: mermaidLkgCache,
  };

  const tripwireResetFailedDocs = new Set<string>();
  const docsWithSettledWrite = new Set<string>();
  const applyDiskContent = options?.applyDiskContentToDoc ?? applyDiskContentToDoc;
  let pendingDeferredStoreFlushMode: 'within-branch' | 'discard-stale' | null = null;

  const QUIESCENCE_MAX_DEFER = 8;
  const persistenceDeferCounts = new Map<string, number>();

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

      await sg.env(env).raw('add', contentRoot);
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
    if (gitCommitTimer) {
      clearTimeout(gitCommitTimer);
      gitCommitTimer = null;
      commitInFlight ||= commitToWipRef().finally(() => {
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
   * Re-derive XmlFragment from `parse(ytext.body)` after the persistence
   * sanity check detected divergence. Under the Y.Text-is-truth contract
   * (precedent #38) Y.Text holds the user's intended source-form bytes;
   * fragment must catch up so future edits start from a consistent base.
   *
   * Synchronous: parse + structural diff + transact all run before the
   * caller's next statement. The work is bounded by doc size (parseWithFallback
   * is O(N), updateYFragment is O(N)), and the caller (storeDocumentNow)
   * already accepts that cost — the alternative (microtask deferral) would
   * leave fragment stale until the microtask drains, opening a window where
   * another transaction could merge against the stale fragment.
   *
   * The reconciliation transacts under `OBSERVER_SYNC_ORIGIN`. Both
   * Observer A and Observer B self-skip on this origin (their callbacks
   * read `transaction.origin === OBSERVER_SYNC_ORIGIN` and `return`),
   * so this nested transact does NOT cascade through the dispatch
   * settlement — it's an Observer-B-style write of the fragment side.
   * The OBSERVER_SYNC_ORIGIN's `skipStoreHooks: true` also prevents this
   * helper from re-triggering `onStoreDocument`, avoiding a feedback loop.
   *
   * The reconciliation is best-effort: a `parseWithFallback` failure (already
   * returns paragraph fallback rather than throwing) means fragment will
   * have the fallback content, which still preserves Observer A's baseline
   * tracking. Any throw deeper down logs but does not propagate — the disk
   * write that triggered this reconciliation is what matters for durability.
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
  const PERSISTENCE_REALIGN_SITE = 'persistence-divergence-realign';
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

  const lastRealignCheckpointPayload = new WeakMap<Y.Doc, string>();

  function checkpointBeforeDivergenceRealign(
    document: Y.Doc,
    documentName: string,
    liveMarkdown: string,
    diskContent: string,
  ): void {
    incrementPersistenceDivergenceRealign();
    const ring = options?.getLossRing?.();
    const shadow = shadowRef?.current;
    if (!shadow) {
      void ring?.record({
        event: LOSS_EVENT_CHECKPOINT_WRITE,
        docName: documentName,
        writerId: null,
        direction: 'b',
        site: PERSISTENCE_REALIGN_SITE,
        lostLen: liveMarkdown.length,
      });
      return;
    }
    if (lastRealignCheckpointPayload.get(document) === liveMarkdown) {
      incrementPersistenceDivergenceRealignDeduped();
      return;
    }
    lastRealignCheckpointPayload.set(document, liveMarkdown);
    const branch = getCurrentBranch?.() ?? 'main';
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'persistence-divergence-realign',
        docName: documentName,
        contents: liveMarkdown,
        label: `Before divergence realign @ ${new Date().toISOString()}`,
        branch,
        metadata: { diskBytes: diskContent.length, discardedBytes: liveMarkdown.length },
      })
        .then((sha) => {
          incrementPersistenceDivergenceRealignCheckpointCreated();
          void ring?.record({
            event: LOSS_EVENT_CHECKPOINT_WRITE,
            docName: documentName,
            writerId: null,
            direction: 'b',
            site: PERSISTENCE_REALIGN_SITE,
            lostLen: liveMarkdown.length,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'persistence-divergence-realign-checkpoint-created',
              docName: documentName,
              sha,
              kind: 'persistence-divergence-realign',
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          if (lastRealignCheckpointPayload.get(document) === liveMarkdown) {
            lastRealignCheckpointPayload.delete(document);
          }
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn(
            { documentName, err: e },
            '[persistence] divergence-realign checkpoint write failed',
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

  async function storeDocumentNow({
    document,
    documentName,
    lastTransactionOrigin,
  }: {
    document: Y.Doc;
    documentName: string;
    lastTransactionOrigin: unknown;
  }): Promise<void> {
    ensureHistograms();
    const started = Date.now();
    let inFlightFlushValue: string | undefined;
    return withSpan(
      'persistence.onStoreDocument',
      { attributes: { 'doc.name': documentName } },
      async () => {
        const agentTriggeredStore = durabilityState.consumeAgentWriteStore(documentName);

        const lifecycleStatus = frozenDocLifecycleStatus(document);
        if (lifecycleStatus !== null) {
          log.info(
            { documentName, lifecycleStatus },
            `[persistence] Skipped store for ${documentName}: lifecycle=${lifecycleStatus}`,
          );
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

        const { sv: stateVectorAtRead, json } = captureDocSnapshotForPersistence(document);
        const ytextSnapshot = document.getText('source').toString();

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
          normalizedMarkdown === normalizeBridge(currentBase) &&
          !addsBlankLines(currentBase, markdown);
        if (!markdownSemanticallyUnchanged && ephemeral && currentBase !== undefined) {
          const canonicalBase = canonicalizeForEphemeralBaseline(currentBase, documentName);
          if (canonicalBase !== null && normalizedMarkdown === canonicalBase) {
            markdownSemanticallyUnchanged = true;
          }
        }
        if (markdownSemanticallyUnchanged) {
          if (contributorCount() > 0) scheduleGitCommit();
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

        if (currentBase !== undefined) {
          const classification = classifyDuplication(markdown, currentBase);
          if (classification.kind === 'block' && docsWithSettledWrite.has(documentName)) {
            incrementPersistenceDuplicationSpared();
            console.warn(
              JSON.stringify({
                event: 'ok-persistence-duplication-spared',
                'doc.name': documentName,
                candidateBytes: markdown.length,
                baseBytes: currentBase.length,
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
                baseBytes: currentBase.length,
                fragmentChildren,
                copies: classification.copies,
                reason: classification.reason,
              }),
            );
            try {
              const requestedDiskPath = safeContentPath(documentName, contentDir);
              let diskContent: string;
              if (existsSync(requestedDiskPath)) {
                let canonical: string | null = null;
                try {
                  canonical = realpathSync(requestedDiskPath);
                } catch (realpathErr) {
                  log.warn(
                    { err: realpathErr, documentName },
                    `[persistence] Tripwire reset realpath failed for ${documentName}; using currentBase`,
                  );
                }
                if (canonical && isWithinContentDir(canonical, contentDir)) {
                  try {
                    diskContent = readFileSync(canonical, 'utf-8');
                  } catch (readErr) {
                    log.warn(
                      { err: readErr, documentName, canonical },
                      `[persistence] Tripwire reset readFileSync failed for ${documentName}; using currentBase`,
                    );
                    diskContent = currentBase;
                  }
                } else {
                  if (canonical) {
                    log.warn(
                      {
                        docName: documentName,
                        originalPath: requestedDiskPath,
                        canonical,
                        contentDir,
                      },
                      `[persistence] symlink-escape on tripwire reset: ${requestedDiskPath} → ${canonical}, using currentBase`,
                    );
                  }
                  diskContent = currentBase;
                }
              } else {
                diskContent = currentBase;
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

        const requestedPath = safeContentPath(documentName, contentDir);
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
            log.error(
              { path: requestedPath, err: e },
              `[persistence] Symlink cycle at ${requestedPath}`,
            );
            throw new Error(`Symlink cycle detected at ${requestedPath}`);
          } else {
            throw e;
          }
        }

        if (!isWithinContentDir(canonicalPath, contentDir)) {
          const msg = `symlink-escape: ${requestedPath} resolves to ${canonicalPath} outside ${contentDir}`;
          log.error(
            {
              docName: documentName,
              originalPath: requestedPath,
              canonical: canonicalPath,
              contentDir,
            },
            `[persistence] ${msg}`,
          );
          throw new Error(msg);
        }

        if (
          process.env.NODE_ENV === 'test' &&
          process.env.OK_TEST_STORE_DIVERGENCE === documentName
        ) {
          await tracedWriteFile(canonicalPath, '# NATIVE\n\nnative-divergence-injected\n', 'utf-8');
        }

        if (agentTriggeredStore && currentBase !== undefined) {
          let diskNow: string | null = null;
          try {
            if (existsSync(canonicalPath)) diskNow = readFileSync(canonicalPath, 'utf-8');
          } catch (err) {
            diskNow = null;
            log.warn(
              { err, documentName },
              '[persistence] L3 disk-read failed; divergence check skipped for this store',
            );
          }
          if (diskNow !== null && normalizeBridge(diskNow) !== normalizeBridge(currentBase)) {
            const diskContent = diskNow;
            console.warn(
              JSON.stringify({
                event: 'agent-write-content-divergence',
                'doc.name': documentName,
                outcome: 'reverted',
                diskBytes: diskContent.length,
                baseBytes: currentBase.length,
                candidateBytes: markdown.length,
              }),
            );
            checkpointBeforeDivergenceRealign(document, documentName, markdown, diskContent);
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
                    site: PERSISTENCE_REALIGN_SITE,
                    lostLen: dropped.reduce((n, s) => n + s.length, 0),
                    digest: fnv1aDigest(dropped.join('\n')),
                  });
                } catch (detectErr) {
                  log.warn(
                    { documentName, err: detectErr },
                    '[persistence] divergence-realign loss detection failed',
                  );
                }
              },
            };
            try {
              document.transact(() => {
                applyDiskContent(document, diskContent, undefined, undefined, undefined, detect);
              }, FILE_WATCHER_ORIGIN);
            } catch (err) {
              durabilityState.recordStoreFailure(documentName, toStoreFailure(err));
              persistenceDeferCounts.delete(documentName);
              throw err;
            }
            durabilityState.setReconciledBase(documentName, diskContent);
            durabilityState.recordStoreDivergence(documentName);
            persistenceDeferCounts.delete(documentName);
            return;
          }
        }

        if (options?.isRecentlyRemoved?.(documentName)) {
          incrementPersistenceStoreRemovedDoc();
          console.warn(
            JSON.stringify({
              event: 'persistence-store-removed-doc',
              'doc.name': documentName,
            }),
          );
        }

        const tmpPath = `${canonicalPath}.tmp.${crypto.randomUUID()}`;
        try {
          if (process.env.NODE_ENV === 'test' && process.env.OK_TEST_STORE_FAULT === documentName) {
            const faultErr = new Error(
              `OK_TEST_STORE_FAULT: simulated disk failure for ${documentName}`,
            ) as NodeJS.ErrnoException;
            faultErr.code = 'ENOSPC';
            throw faultErr;
          }
          await tracedWriteFile(tmpPath, markdown, 'utf-8');
          await tracedRename(tmpPath, canonicalPath);
          registerWrite(canonicalPath, contentHash(markdown));
          durabilityState.clearStoreFailure(documentName);
          incrementPersistenceDiskWrite();
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
          durabilityState.recordStoreFailure(documentName, toStoreFailure(e));
          log.error({ err: e, documentName }, `[persistence] Failed to save ${documentName}`);
          throw e;
        }
        log.info(
          { filePath: canonicalPath, bytes: markdown.length },
          `[persistence] Wrote ${canonicalPath} (${markdown.length} bytes)`,
        );

        durabilityState.setReconciledBase(documentName, markdown);
        docsWithSettledWrite.add(documentName);
        tripwireResetFailedDocs.delete(documentName);
        persistenceDeferCounts.delete(documentName);

        try {
          await derivedDocumentIndex?.recordDurableStore(documentName, markdown);
        } catch (err) {
          log.warn(
            { err, documentName },
            '[derived-index] durable-store projection failed; disk write remains authoritative',
          );
        }

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
    });
  }

  async function flushDeferredStores(mode: 'within-branch' | 'discard-stale' = 'within-branch') {
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
        const entries = [...deferredStores.entries()];
        deferredStores.clear();

        if (drainMode !== 'discard-stale') {
          for (const [documentName, entry] of entries) {
            if (entry.branch !== durabilityState.getActiveBranch()) continue;
            try {
              await storeDocumentNow({
                document: entry.document,
                documentName,
                lastTransactionOrigin: entry.lastTransactionOrigin,
              });
            } catch (err) {
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
            }
          }
        }

        const nextMode = pendingDeferredStoreFlushMode;
        pendingDeferredStoreFlushMode = null;
        if (deferredStores.size === 0 && nextMode === null) break;
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
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        loadConfigDoc(document, documentName, configPersistenceCtx);
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        loadManagedArtifactDoc(document, documentName, managedArtifactCtx);
        return;
      }
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
          if (!existsSync(filePath)) return;

          let canonical = filePath;
          try {
            const resolvedCanonical = realpathSync(filePath);
            if (!isWithinContentDir(resolvedCanonical, contentDir)) {
              log.warn(
                { path: filePath, canonical: resolvedCanonical },
                `[persistence] symlink-escape on load: ${filePath} → ${resolvedCanonical}, refusing`,
              );
              return;
            }
            canonical = resolvedCanonical;
          } catch (e) {
            const code = errnoCode(e);
            if (code === 'ELOOP') {
              log.warn(
                { path: filePath },
                `[persistence] Symlink cycle on load: ${filePath}, refusing`,
              );
              return;
            }
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

          const xmlFragment = document.getXmlFragment('default');
          log.info(
            { documentName, fragmentLength: xmlFragment.length },
            `[persistence] onLoadDocument ${documentName}: fragment.length=${xmlFragment.length} before update`,
          );

          if (xmlFragment.length === 0) {
            document.transact(() => {
              applyDiskContentToDoc(
                document,
                raw,
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

          durabilityState.setReconciledBase(documentName, raw);
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
     * second SV captured later (e.g., after `await tracedRename`) would
     * include updates from the async write window, falsely advancing the
     * watermark past content that's NOT durably persisted, and
     * clients would drop those bytes from the recycle buffer →
     * unsynced-edit loss on server-restart. See the helper's docstring
     * for the full timing contract.
     */
    async onStoreDocument({
      document,
      documentName,
      lastTransactionOrigin,
      lastContext: _lastContext,
    }) {
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        const outcome = await storeConfigDoc(
          document,
          documentName,
          lastTransactionOrigin,
          configPersistenceCtx,
        );
        if (outcome === 'persisted' || outcome === 'reconciled') {
          try {
            onConfigPersisted?.(documentName);
          } catch (err) {
            log.warn({ err, documentName }, '[persistence] onConfigPersisted callback failed');
          }
        }
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        const outcome = await storeManagedArtifactDoc(
          document,
          documentName,
          lastTransactionOrigin,
          managedArtifactCtx,
        );
        if (outcome === 'persisted') {
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
            log.warn(
              { err, documentName },
              '[persistence] onManagedSkillPersisted callback failed',
            );
          }
        }
        return;
      }
      if (
        isMermaidDoc(documentName) ||
        isExcalidrawDoc(documentName) ||
        isEditableTextDoc(documentName)
      ) {
        await storeMermaidDoc(document, documentName, lastTransactionOrigin, mermaidPersistenceCtx);
        return;
      }
      if (durabilityState.isBatchInProgress()) {
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

  async function forceStore(document: Y.Doc, documentName: string): Promise<void> {
    if (isPersistenceExcludedDoc(documentName)) {
      return;
    }
    if (durabilityState.isBatchInProgress()) {
      deferStore({ document, documentName, lastTransactionOrigin: null });
      return;
    }
    return storeDocumentNow({ document, documentName, lastTransactionOrigin: null });
  }

  return {
    extension,
    durabilityState,
    flushDeferredStores,
    flushPendingGitCommit,
    flushContributors,
    waitForPendingCommits,
    getQueueDepths,
    forceStore,
    configPersistenceCtx,
    managedArtifactCtx,
  };
}
