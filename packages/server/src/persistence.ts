import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Extension } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import {
  BridgeInvariantViolationError,
  type ConfigValidationError,
  DOCUMENT_OPEN_BYTE_LIMIT,
  fnv1aDigest,
  formatFileSize,
  normalizeBridge,
  type Principal,
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
import type { BacklinkIndex } from './backlink-index.ts';
import { getMsSinceLastUserTx, isDocQuiescent } from './bridge-quiescence.ts';
import { assertBridgeInvariant } from './bridge-watchdog.ts';
import { isConfigDoc, isManagedArtifactDoc, isSystemDoc } from './cc1-broadcast.ts';
import { type ConfigPersistenceCtx, loadConfigDoc, storeConfigDoc } from './config-persistence.ts';
import type { ContributorEntry } from './contributor-tracker.ts';
import {
  contributorCount,
  hasContributor,
  recordContributor,
  restoreContributorEntry,
  restoreContributors,
  swapContributors,
} from './contributor-tracker.ts';
import { getDocExtension } from './doc-extensions.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './external-change.ts';
import { contentHash, registerWrite } from './file-watcher.ts';
import { tracedMkdir, tracedRename, tracedUnlinkSync, tracedWriteFile } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  loadManagedArtifactDoc,
  type ManagedArtifactCtx,
  managedArtifactContributorAttribution,
  storeManagedArtifactDoc,
} from './managed-artifact-persistence.ts';
import { mdManager, schema } from './md-manager.ts';
import {
  incrementDeferredStoreFailures,
  incrementGitAutoSaveFailure,
  incrementGitWriterCommitFailure,
  incrementPersistenceDiskWrite,
  incrementPersistenceForceFlushDuringBurst,
  incrementPersistenceReconciliationFailures,
  incrementPersistenceSanityCheckSerializeFailures,
  incrementPersistenceSkipNonQuiescent,
} from './metrics.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { backfillRenameLogCommitSha, getOrLoadRenameLogIndex } from './rename-log.ts';
import { OBSERVER_SYNC_ORIGIN } from './server-observers.ts';
import type { ShadowRef, WriterIdentity } from './shadow-repo.ts';
import {
  buildWipTree,
  commitWip,
  commitWipFromTree,
  FILE_SYSTEM_WRITER,
  GIT_UPSTREAM_WRITER,
  SERVICE_WRITER,
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
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  wipRef?: string;
  shadowRef?: ShadowRef;
  contentRoot?: string;
  backlinkIndex?: BacklinkIndex;
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
  applyDiskContentToDoc?: (document: Y.Doc, content: string) => void;
  configHomedirOverride?: string;
  onConfigRejected?: (docName: string, error: ConfigValidationError) => void;
  mdManager?: MarkdownManager;
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

export function safeContentPath(documentName: string, contentDir: string): string {
  if (documentName.includes('\x00')) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  const ext = getDocExtension(documentName);
  const filePath = resolve(contentDir, `${documentName}${ext}`);
  if (!isWithinDir(filePath, contentDir)) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  return filePath;
}

export function isWithinContentDir(p: string, contentDir: string): boolean {
  return isWithinDir(p, contentDir);
}

const reconciledBaseByBranch = new Map<string, Map<string, string>>();

let activeBranch = 'main';

export function switchReconciledBaseScope(branch: string): void {
  activeBranch = branch;
  if (!reconciledBaseByBranch.has(branch)) {
    reconciledBaseByBranch.set(branch, new Map());
  }
}

export function getActiveBranch(): string {
  return activeBranch;
}

export function getReconciledBase(docName: string): string | undefined {
  return reconciledBaseByBranch.get(activeBranch)?.get(docName);
}

export function setReconciledBase(docName: string, content: string): void {
  if (!reconciledBaseByBranch.has(activeBranch)) {
    reconciledBaseByBranch.set(activeBranch, new Map());
  }
  reconciledBaseByBranch.get(activeBranch)?.set(docName, content);
}

export function deleteReconciledBase(docName: string): void {
  reconciledBaseByBranch.get(activeBranch)?.delete(docName);
}

const inFlightFlushByDoc = new Map<string, string>();

export function peekInFlightFlush(docName: string): string | undefined {
  return inFlightFlushByDoc.get(docName);
}

let batchInProgress = false;

export function setBatchInProgress(value: boolean): void {
  batchInProgress = value;
}

export function isBatchInProgress(): boolean {
  return batchInProgress;
}

export interface StoreFailure {
  code?: string;
  message: string;
}

function toStoreFailure(err: unknown): StoreFailure {
  let code: string | undefined;
  try {
    const c = (err as NodeJS.ErrnoException | null)?.code;
    if (typeof c === 'string') code = c;
  } catch {
  }
  let message = 'unknown store error';
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
  }
  return { code, message };
}

export interface PersistenceHandle {
  extension: Extension;
  flushDeferredStores: (mode?: 'within-branch' | 'discard-stale') => Promise<void>;
  flushPendingGitCommit: () => Promise<void>;
  takeStoreFailure: (documentName: string) => StoreFailure | null;
  takeStoreDivergence: (documentName: string) => boolean;
  markAgentWriteStore: (documentName: string) => void;
  flushContributors: () => Promise<void>;
  waitForPendingCommits: () => Promise<void>;
  readonly configPersistenceCtx: ConfigPersistenceCtx;
  readonly managedArtifactCtx: ManagedArtifactCtx;
}

export function createPersistenceExtension(options?: PersistenceOptions): PersistenceHandle {
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
  const backlinkIndex = options?.backlinkIndex;
  const getPrincipal = options?.getPrincipal;
  const onAgentCommit = options?.onAgentCommit;
  const onFlushCommit = options?.onFlushCommit;
  const onDiskFlush = options?.onDiskFlush;
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
    setReconciledBase,
    getReconciledBase,
  };

  const tripwireResetFailedDocs = new Set<string>();
  const applyDiskContent = options?.applyDiskContentToDoc ?? applyDiskContentToDoc;
  let pendingDeferredStoreFlushMode: 'within-branch' | 'discard-stale' | null = null;

  const QUIESCENCE_MAX_DEFER = 8;
  const persistenceDeferCounts = new Map<string, number>();

  const storeFailures = new Map<string, StoreFailure>();

  const storeDivergences = new Set<string>();

  const agentWriteStores = new Set<string>();


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
      const snapshot = swapContributors(); // atomic drain — new writes go to fresh map
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
              { attempt: consecutiveGitFailures },
              '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
            );
          }
        }
        return;
      }

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
          { attempt: consecutiveGitFailures },
          '[persistence] CRITICAL: Git auto-save has failed 3+ times. Version history is NOT being recorded.',
        );
      }
    } finally {
      try {
        tracedUnlinkSync(tmpIndex);
      } catch {
      }
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
    if (isBatchInProgress()) return;
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
        const agentTriggeredStore = agentWriteStores.delete(documentName);

        const lifecycleStatus = document.getMap('lifecycle').get('status');
        if (
          lifecycleStatus === 'deleted-upstream' ||
          lifecycleStatus === 'renamed' ||
          lifecycleStatus === 'conflict'
        ) {
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
        try {
          const fragmentBody = mgr.serialize(json);
          const fragmentMarkdown = prependFrontmatter(frontmatter, fragmentBody);
          normalizeEqual = assertBridgeInvariant(markdown, fragmentMarkdown, {
            site: 'persistence',
            docName: documentName,
            suppressDevThrow: true,
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
          normalizeEqual = false;
        }
        if (!normalizeEqual) {
          reconcileFragmentNow(document, body, documentName);
        }

        const currentBase = getReconciledBase(documentName);
        const normalizedMarkdown = normalizeBridge(markdown);
        let markdownSemanticallyUnchanged =
          currentBase !== undefined && normalizedMarkdown === normalizeBridge(currentBase);
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
          if (classification.kind === 'block') {
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
                    console.warn(
                      `[persistence] symlink-escape on tripwire reset: ${requestedDiskPath} → ${canonical}, using currentBase`,
                      {
                        docName: documentName,
                        originalPath: requestedDiskPath,
                        canonical,
                        contentDir,
                      },
                    );
                  }
                  diskContent = currentBase;
                }
              } else {
                diskContent = currentBase;
              }
              document.transact(() => {
                applyDiskContent(document, diskContent);
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
        inFlightFlushByDoc.set(documentName, inFlightFlushValue);

        const requestedPath = safeContentPath(documentName, contentDir);
        await tracedMkdir(dirname(requestedPath), { recursive: true });

        let canonicalPath: string;
        try {
          canonicalPath = await realpath(requestedPath);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            let isBrokenSymlink = false;
            try {
              isBrokenSymlink = lstatSync(requestedPath).isSymbolicLink();
            } catch (lstatErr) {
              if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.warn(
                  { err: lstatErr, path: requestedPath },
                  '[persistence] lstat failed during broken-symlink check',
                );
              }
            }
            if (isBrokenSymlink) {
              console.warn(`[persistence] broken-symlink fallback`, {
                docName: documentName,
                reason: 'broken-symlink',
              });
            }
            canonicalPath = requestedPath;
          } else if (code === 'ELOOP') {
            console.error(`[persistence] Symlink cycle at ${requestedPath}`);
            throw new Error(`Symlink cycle detected at ${requestedPath}`);
          } else {
            throw e;
          }
        }

        if (!isWithinContentDir(canonicalPath, contentDir)) {
          const msg = `symlink-escape: ${requestedPath} resolves to ${canonicalPath} outside ${contentDir}`;
          console.error(`[persistence] ${msg}`, {
            docName: documentName,
            originalPath: requestedPath,
            canonical: canonicalPath,
            contentDir,
          });
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
            const diskContent = diskNow; // const so the closure keeps the non-null narrowing
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
            try {
              document.transact(() => {
                applyDiskContent(document, diskContent);
              }, FILE_WATCHER_ORIGIN);
            } catch (err) {
              storeFailures.set(documentName, toStoreFailure(err));
              persistenceDeferCounts.delete(documentName);
              throw err;
            }
            setReconciledBase(documentName, diskContent);
            storeDivergences.add(documentName);
            persistenceDeferCounts.delete(documentName);
            return;
          }
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
          storeFailures.delete(documentName);
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
          } catch {
          }
          persistenceDeferCounts.delete(documentName);
          storeFailures.set(documentName, toStoreFailure(e));
          log.error({ err: e, documentName }, `[persistence] Failed to save ${documentName}`);
          throw e;
        }
        log.info(
          { filePath: canonicalPath, bytes: markdown.length },
          `[persistence] Wrote ${canonicalPath} (${markdown.length} bytes)`,
        );

        setReconciledBase(documentName, markdown);
        tripwireResetFailedDocs.delete(documentName);
        persistenceDeferCounts.delete(documentName);

        if (backlinkIndex) {
          backlinkIndex.updateDocumentFromMarkdown(documentName, markdown);
          void backlinkIndex.saveToDisk().catch((err) => {
            log.warn(
              { err, documentName },
              `[backlinks] Failed to persist cache for ${documentName}`,
            );
          });
        }

        setActiveSpanAttributes({ 'persistence.bytes': markdown.length });
        scheduleGitCommit();
      },
    ).finally(() => {
      if (
        inFlightFlushValue !== undefined &&
        inFlightFlushByDoc.get(documentName) === inFlightFlushValue
      ) {
        inFlightFlushByDoc.delete(documentName);
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
      branch: getActiveBranch(),
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
            if (entry.branch !== getActiveBranch()) continue;
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
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        loadConfigDoc(document, documentName, configPersistenceCtx);
        return;
      }
      if (isManagedArtifactDoc(documentName)) {
        loadManagedArtifactDoc(document, documentName, managedArtifactCtx);
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
              console.warn(
                `[persistence] symlink-escape on load: ${filePath} → ${resolvedCanonical}, refusing`,
              );
              return;
            }
            canonical = resolvedCanonical;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ELOOP') {
              console.warn(`[persistence] Symlink cycle on load: ${filePath}, refusing`);
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

          setReconciledBase(documentName, raw);
        },
      ).finally(() => {
        loadDurationHist?.record((Date.now() - started) / 1000);
      });
    },

    async onStoreDocument({
      document,
      documentName,
      lastTransactionOrigin,
      lastContext: _lastContext,
    }) {
      if (isSystemDoc(documentName)) return;
      if (isConfigDoc(documentName)) {
        await storeConfigDoc(document, documentName, lastTransactionOrigin, configPersistenceCtx);
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
        }
        return;
      }
      if (isBatchInProgress()) {
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
    if (commitInFlight) {
      await commitInFlight;
      return;
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

  function takeStoreFailure(documentName: string): StoreFailure | null {
    const failure = storeFailures.get(documentName);
    if (failure) storeFailures.delete(documentName);
    return failure ?? null;
  }

  function takeStoreDivergence(documentName: string): boolean {
    if (!storeDivergences.has(documentName)) return false;
    storeDivergences.delete(documentName);
    return true;
  }

  function markAgentWriteStore(documentName: string): void {
    agentWriteStores.add(documentName);
  }

  return {
    extension,
    flushDeferredStores,
    flushPendingGitCommit,
    flushContributors,
    waitForPendingCommits,
    takeStoreFailure,
    takeStoreDivergence,
    markAgentWriteStore,
    configPersistenceCtx,
    managedArtifactCtx,
  };
}
