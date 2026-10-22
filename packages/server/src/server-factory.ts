import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Document, Extension } from '@hocuspocus/server';
import { Hocuspocus, IncomingMessage, MessageType } from '@hocuspocus/server';
import {
  type BasenameIndex,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  type ConfigDiagnosticsReport,
  type ConfigDocName,
  type ConfigIssue,
  createBasenameIndex,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
  DOCUMENT_OPEN_BYTE_LIMIT,
  humanFormat,
  isKnownConfigError,
  type LinterConfig,
  type MarkdownManager,
  modeFromCommittedDefault,
  type PersistedLinterConfig,
  type Principal,
  parseGlobalSkillBundleDoc,
  parseManagedArtifactName,
  resolveAutoSyncIntervals,
  resolveLocalAutoSyncMode,
  type SyncMode,
  type SyncModeChangeSource,
  toEffectiveBase,
} from '@inkeep/open-knowledge-core';
import {
  atomicWriteFile,
  collectConfigDiagnostics,
  readConfigSafely,
  resolveConfigPath,
  writeConfigPatch,
} from '@inkeep/open-knowledge-core/server';
import {
  type CheckpointKind,
  formatReconcileSubject,
  gitAuthorWriterId,
  resolveGitDir,
  resolveShadowDir,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import type { Doc } from 'yjs';
import { AcpPermissionStore } from './acp/permissions.ts';
import { AcpRegistry, loadCustomAgents } from './acp/registry.ts';
import { AgentFocusBroadcaster } from './agent-focus.ts';
import { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentRegistryHostSeam } from './agent-registry-apply.ts';
import { AgentSessionManager } from './agent-sessions.ts';
import { type CommentDocHooks, createApiExtension, isSafeDocName } from './api-extension.ts';
import { assetReferencesChanged } from './asset-references.ts';
import { seedBasenameIndex, seedSingleDirBasenameIndex } from './asset-walk.ts';
import {
  HocuspocusAuthRejection,
  type HocuspocusAuthRejectionReason,
  parseHocuspocusAuthToken,
} from './auth-token-schema.ts';
import { bootElapsedMs, recordBootPhase, setBootField } from './boot-timings.ts';
import {
  type BridgeDeriveLossReporter,
  createBridgeDeriveLossReporter,
} from './bridge-loss-detector.ts';
import {
  CC1Broadcaster,
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isManagedArtifactDoc,
  isMermaidDoc,
  isPersistenceExcludedDoc,
  isReservedForUserTree,
  SYSTEM_DOC_NAME,
} from './cc1-broadcast.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { getLocalDir } from './config/paths.ts';
import {
  type ConfigFileWatcherUnsubscribe,
  startConfigFileWatcher,
  startMultiPathConfigFileWatcher,
} from './config-file-watcher.ts';
import {
  applyExternalConfigChange,
  configDocAbsPath,
  isConfigEcho,
  resetConfigDocForTest,
} from './config-persistence.ts';
import { bindConflictAuthority, ConflictAuthority } from './conflict-authority.ts';
import { createGeneratedIndexWarningScope } from './content/generate-index.ts';
import { type GeneratedArtifactEnv, writeGeneratedArtifact } from './content/generated-artifact.ts';
import {
  type GeneratedIndexGitAttributesStatus,
  inspectGeneratedIndexGitAttributes,
  updateGeneratedIndexGitAttributes,
} from './content/generated-index-git-attributes.ts';
import {
  collectIndexDirectories,
  directoryChainToRoot,
  directoryOf,
  indexedFieldsChanged,
  indexedMetadataChanged,
  isGeneratedIndexDocName,
  type PreviousIndexedFields,
  planDirectoryIndexRegenerations,
  ROOT_INDEX_DOC_NAME,
} from './content/regenerate-index.ts';
import {
  type ContentFilter,
  createContentFilter,
  isShareableOkArtifact,
} from './content-filter.ts';
import { isWithinContentDir, safeContentPath } from './content-path.ts';
import { dropPendingDocs, recordContributor } from './contributor-tracker.ts';
import {
  DerivedDocumentIndex,
  type DerivedDocumentIndexBranchTransition,
} from './derived-document-index.ts';
import { resolveDirectoryRoot } from './directory-root.ts';
import { applyDiskContentToDoc } from './disk-content-intake.ts';
import { DiskReceiptLog, receiptFileIsGoneIn } from './disk-receipts.ts';
import { displayPathFor } from './display-path.ts';
import {
  canonicalDocName,
  docNameToRelativePath,
  getDocExtension,
  isRegisteredMarkdownDocName,
  stripDocExtension,
} from './doc-extensions.ts';
import { runDocLineageGuard } from './doc-lineage-guard.ts';
import { DocNoticeLedger, type NoticeFile } from './doc-notices.ts';
import {
  DocumentDurabilityState,
  type StaleExternalWriteConflict,
  type StoreIntakeMerge,
  type WrittenThrough,
  writtenThroughOf,
} from './document-durability-state.ts';
import {
  createReconnectRefreshExtension,
  type DocumentRefreshResult,
  type DocumentRefreshTrigger,
} from './document-refresh.ts';
import {
  type Embedder,
  type EmbeddingsKeyStore,
  type LoadOpenAiEmbedderInput,
  loadOpenAiEmbedder,
  normalizeProviderId,
  type ResolvedSemanticConfig,
  readProjectLocalSemanticConfig,
  SemanticSearchService,
  secretsFilePath,
} from './embeddings/index.ts';
import {
  applyExternalChange,
  FILE_WATCHER_ORIGIN,
  type FrozenResidentRevival,
  redactedErrorSummary,
  refuseStaleExternalWrite,
  reportReconcileBothKept,
  reportReconcileCheckFailed,
  reportReconcileKeptLive,
  reviveFrozenResidentDoc,
  serializeYDocSource,
  wireReasonForRefusal,
} from './external-change.ts';
import {
  assertNeverDiskEvent,
  contentHash,
  type DiskEvent,
  getMarkdownEventFacts,
  getMarkdownRemovalCurrentness,
  hasAdmittedMarkdownFile,
  type NativeWatcherBackend,
  pathToDocName,
  type RecheckResult,
  reconcileFileIndexAfterFilterRebuild,
  registerRemoval,
  registerWrite,
  retractRemoval,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import { canonicalContentPathIsRefused, SymlinkEscapeError } from './fs-safety.ts';
import {
  normalizeFsPath,
  tracedMkdirSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { createGitInstance } from './git-handle.ts';
import type {
  CheckPushPermissionOptions,
  DetectGhAccountsFn,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { createGitHubTokenResolver } from './github-reference/token-resolver.ts';
import { type HeadWatcherHandle, readProjectHeadState, startHeadWatcher } from './head-watcher.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { NativeApiHandle } from './http/http-app.ts';
import type { LocalApiDispatch } from './http/local-api-dispatch.ts';
import type { GeneratedIndexSettingsStatus } from './http/workspace-tools-routes.ts';
import {
  scanGlobalInPlaceSkillsAsync,
  scanInPlaceSkillDirs,
  scanInPlaceSkills,
  skillRootPathsFor,
} from './in-place-skills.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import type { LinkAdvisoryPolicy } from './link-advisory-policy.ts';
import { ensureOkfSchemaFiles } from './lint/write-okf-schemas.ts';
import { createLiveDerivedIndexExtension } from './live-derived-index.ts';
import { wikiFilePath } from './local-target-assessment.ts';
import {
  createTrackedFileResolver,
  createTrackedWikiFileResolver,
  localTargetInventoryFromWatcher,
} from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
import { LossCaptureRing } from './loss-capture.ts';
import {
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
} from './maintenance-coordinator.ts';
import {
  applyExternalManagedArtifactChange,
  homeFor,
  managedArtifactAbsPath,
  managedArtifactDocNameForPath,
  managedArtifactSkillsRoots,
} from './managed-artifact-persistence.ts';
import { startManagedArtifactWatcher } from './managed-artifact-watcher.ts';
import { recoverPendingManagedRename } from './managed-rename-journal.ts';
import type { NativeTomlMcpEditor } from './mcp-config-reconciler.ts';
import { mdManager, schema } from './md-manager.ts';
import { createMergeHistoryRecorder, type MergeHistoryWriter } from './merge-history.ts';
import { applyExternalEnginelessChange } from './mermaid-persistence.ts';
import {
  incrementBatch,
  incrementBranchSwitch,
  incrementBranchSwitchRecheckShortfalls,
  incrementConflict,
  incrementDiskAuthoritativeIngest,
  incrementDiskAuthoritativeIngestApplyFailures,
  incrementDiskAuthoritativeIngestUnrescued,
  incrementOutsideRenameClaimFailures,
  incrementOutsideRenameRecordFailures,
  incrementPark,
  incrementReceiptIntakeSkip,
  incrementRecentlyRemovedDocsEviction,
  incrementReconcile,
  incrementReconcileInsertDedupSkipped,
  incrementRescueBuffer,
  incrementRescueBufferWriteFailures,
  incrementRescueCheckpointWriteFailures,
  incrementUpstreamImport,
  recordVanishOutcome,
  setRecentlyRemovedDocsSize,
} from './metrics.ts';
import { destroyParsePool } from './parse-pool.ts';
import { isWithinDir, toPosix } from './path-utils.ts';
import { createPersistenceExtension, type PersistenceOptions } from './persistence.ts';
import {
  createPersistenceStalenessWatchdog,
  type StalenessWatchdogHandle,
  StructuralDiskReadError,
} from './persistence-staleness-watchdog.ts';
import { loadPrincipal } from './principal.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { type ReconcileOutcome, reconcile } from './reconciliation.ts';
import { reconcileRecoveredFileTarget } from './recovered-file-target.ts';
import { runRemovalRedirectGuard } from './removal-redirect-guard.ts';
import { loadRemovedDocsJournal, saveRemovedDocsJournal } from './removed-docs-journal.ts';
import {
  gcRenameLog,
  getOrLoadRenameLogIndex,
  loadRenameLogIndex,
  setRenameLogIndex,
  sweepLazyPopOrphans,
} from './rename-log.ts';
import { followRenameRecords } from './rename-records.ts';
import {
  acquireServerAuthority,
  contentScopeContainsPath,
  ServerAuthorityCollisionError,
} from './server-authority.ts';
import {
  assertCapturedServerContentPath,
  assertServerContentPath,
  assertServerContentSubtree,
  ContentScopeAdmissionError,
  canonicalContentPath,
  contentScopedAtomicFs,
  ServerMutationShuttingDownError,
  snapshotServerContentScope,
} from './server-content-policy.ts';
import {
  acquireServerLock,
  markServerLockDraining,
  readServerLock,
  releaseServerLock,
  ServerLockCollisionError,
} from './server-lock.ts';
import { createServerObserverExtension } from './server-observer-extension.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import {
  installServerWorkloadGauges,
  registerAgentSessionCountsProvider,
  registerConnectionCountsProvider,
  registerLoadedDocsProvider,
  registerPersistenceQueueDepthProvider,
} from './server-workload-telemetry.ts';
import { shadowOpGateFor } from './shadow-op-gate.ts';
import {
  buildWipTree,
  commitUpstreamImport,
  configureShadowGc,
  destroyShadowRepo,
  FILE_SYSTEM_WRITER,
  initShadowRepo,
  isShadowExcludesDegraded,
  OK_GENERATOR_WRITER,
  type ParkableDoc,
  parkBranch,
  SERVICE_WRITER,
  type ShadowHandle,
  type ShadowRef,
  safetyCheckpoint,
  saveInMemoryCheckpoint,
  shadowGit,
} from './shadow-repo.ts';
import {
  createSyncCredentialConfigResolver,
  readDeclaredGitHubHosts,
} from './share/git-context.ts';
import { resyncRecordedSkillCopies } from './skill-placements.ts';
import { skillStateYamlPath } from './skill-state.ts';
import { assertCompatibleStateManifest } from './state-manifest.ts';
import { classifyIntakeAgainstReceipt, receiptIntakeSkipOf } from './store-compare.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';
import { SyncEngine } from './sync-engine.ts';
import { createSyncHandshakeSpanExtension } from './sync-handshake-span-extension.ts';
import { initTelemetry, shutdownTelemetry, withSpan } from './telemetry.ts';
import { trustSystemCertificates } from './trust-system-ca.ts';
import { cleanupOrphanUploadTempfiles } from './upload-streaming.ts';
import {
  type RecentCreate,
  VANISH_HOLD_LIMIT_MS,
  VANISH_OVERDUE_FAULT_LIMIT,
  VANISH_RECHECK_DELAY_MS,
  type VanishedDocument,
  VanishedDocuments,
} from './vanished-documents.ts';
import { type WatcherClock, type WatcherTimer, watcherClock } from './watcher-clock.ts';
import { FRESHNESS_BASE_INTERVAL_MS } from './watcher-freshness.ts';

export interface ServerOptions {
  acpRegistryFetchImpl?: typeof fetch;
  ingressPolicy?: IngressPolicy;
  port?: number;
  host?: string;
  contentDir: string;
  projectDir?: string;
  quiet?: boolean;
  debounce?: number;
  maxDebounce?: number;
  stalenessGraceMs?: number;
  stalenessSweepIntervalMs?: number;
  agentSessionOptions?: {
    maxSessions?: number;
    minEvictableIdleMs?: number;
  };
  gitEnabled?: boolean;
  mcpTomlEditor?: NativeTomlMcpEditor;
  commitDebounceMs?: number;
  wipRef?: string;
  enableTestRoutes?: boolean;
  getCollabClientCount?: () => number;
  shadowRepo?: ShadowHandle;
  contentRoot?: string;
  destroyTimeoutMs?: number;
  authorityRegistryPath?: string;
  onAgentWrite?: () => void;
  localOpCliArgs?: string[];
  authStreamHeartbeatMs?: number;
  lockKind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
  skipStateManifestCheck?: boolean;
  configHomedirOverride?: string;
  mdManager?: MarkdownManager;
  detectGh?: DetectGhFn;
  agentIntegrations?: AgentRegistryHostSeam;
  detectGhAccounts?: DetectGhAccountsFn;
  tokenStore?: ProbeTokenStore | null;
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  pullIntervalSeconds?: number;
  pushIntervalSeconds?: number;
  embeddingsKeyStore?: EmbeddingsKeyStore | null;
  embedderLoader?: (input: LoadOpenAiEmbedderInput) => Promise<Embedder | null>;
  singleDocRelPath?: string;
  ephemeral?: boolean;
  watcherBackend?: NativeWatcherBackend;
  watcherClock?: WatcherClock;
  freshnessIntervalMs?: number | null;
  mergeHistoryWriter?: MergeHistoryWriter;
  generatedIndexTestHooks?: {
    beforePlan?: (context: { fullSweep: boolean; signal: AbortSignal }) => Promise<void> | void;
    beforeDecision?: (context: {
      directory: string;
      fullSweep: boolean;
      signal: AbortSignal;
    }) => Promise<void> | void;
    afterWrite?: (context: {
      docName: string;
      fullSweep: boolean;
      signal: AbortSignal;
    }) => Promise<void> | void;
    onKickWhileInFlight?: () => void;
    onIdle?: () => void;
  };
}

type GeneratedIndexSweepResult =
  | { status: 'completed'; indexCount: number }
  | { status: 'disabled'; indexCount: number }
  | { status: 'blocked'; indexCount: number }
  | { status: 'failed'; indexCount: number }
  | { status: 'cancelled'; indexCount: number };

export interface ServerInstance {
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  nativeApi: NativeApiHandle;
  localApi: LocalApiDispatch;
  cc1Broadcaster: CC1Broadcaster;
  agentFocusBroadcaster: AgentFocusBroadcaster;
  agentPresenceBroadcaster: AgentPresenceBroadcaster;
  maintenanceCoordinator?: MaintenanceCoordinator;
  contentFilter: ContentFilter;
  basenameIndex: BasenameIndex;
  readonly serverInstanceId: string;
  readonly durabilityState: DocumentDurabilityState;
  destroy: () => Promise<void>;
  ready: Promise<void>;
  generatedIndexSweepReady: Promise<GeneratedIndexSweepResult>;
  readonly degraded: readonly string[];
  readonly lockDir: string;
  readonly syncEngine: SyncEngine | null;
  readonly conflicts: ConflictAuthority;
  readonly getLinkPreviewsEnabled: () => boolean;
  readonly resolveEmbed: (basename: string, sourcePath: string) => string | null;
  readonly resolveTrackedFile: (relativePath: string) => string | undefined;
  readonly acpRegistry: AcpRegistry;
  readonly acpPermissions: AcpPermissionStore;
  readonly recheckDisk: () => Promise<RecheckResult>;
}

export function observeShutdownDocumentRetirements(
  hocuspocus: Hocuspocus,
  onDocumentRetired: () => void,
): () => void {
  let active = true;
  const observer: Extension = {
    async afterUnloadDocument() {
      if (active) onDocumentRetired();
    },
  };
  hocuspocus.configuration.extensions.unshift(observer);
  return () => {
    active = false;
    const extensions = hocuspocus.configuration.extensions;
    const index = extensions.indexOf(observer);
    if (index !== -1) extensions.splice(index, 1);
  };
}

export const SHADOW_FANOUT_WARMUP_MS = 3000;

export const BRANCH_SWITCH_FOLLOW_UP_LIMIT = 3;

export const BRANCH_SWITCH_FOLLOW_UP_DELAY_MS = 5_000;

const PARK_SNAPSHOT_ORIGIN = (() => {
  const ctx = Object.freeze({ origin: 'park-snapshot', paired: true as const });
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: ctx,
  }) satisfies PairedWriteOrigin;
})();

const GENERATED_ARTIFACT_ORIGIN = (() => {
  const ctx = Object.freeze({ origin: 'generated-index', paired: true as const });
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: ctx,
  }) satisfies PairedWriteOrigin;
})();

export interface UpstreamAuthor {
  name: string;
  email: string;
}

export function resolveUpstreamChanges(
  projectDir: string,
  contentDir: string,
  oldHead: string | null,
  newHead: string,
): Map<string, UpstreamAuthor> {
  const changes = new Map<string, UpstreamAuthor>();
  if (!oldHead) return changes;
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      'git',
      [
        '-c',
        'core.quotePath=false',
        'log',
        `${oldHead}..${newHead}`,
        '--no-merges',
        '--name-only',
        '--format=C%x00%an%x00%ae',
      ],
      withHiddenWindowsConsole({ cwd: projectDir, encoding: 'utf-8', timeout: 5000 }),
    );
  } catch (err) {
    getLogger('upstream-attribution').warn(
      { err, oldHead, newHead },
      'git log spawn threw; upstream docs keep file-system attribution',
    );
    return changes;
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    getLogger('upstream-attribution').warn(
      {
        err: result.error,
        status: result.status,
        signal: result.signal,
        stderr: typeof result.stderr === 'string' ? result.stderr.slice(0, 500) : undefined,
        oldHead,
        newHead,
      },
      'git log failed; upstream docs keep file-system attribution',
    );
    return changes;
  }

  let current: UpstreamAuthor | null = null;
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('C\0')) {
      const [, name, email] = line.split('\0');
      current = name && email ? { name, email } : null;
      continue;
    }
    if (!current) continue;
    if (!line.endsWith('.md') && !line.endsWith('.mdx')) continue;
    const abs = resolve(projectDir, line);
    if (!isWithinContentDir(abs, contentDir)) continue;
    const docName = pathToDocName(abs, contentDir);
    if (changes.has(docName)) continue;
    if (!existsSync(abs)) continue;
    changes.set(docName, current);
  }
  return changes;
}

export function createServer(options: ServerOptions): ServerInstance {
  trustSystemCertificates();
  const ingressPolicy = options.ingressPolicy ?? buildIngressPolicy({});
  const {
    contentDir,
    projectDir = contentDir,
    quiet = true,
    debounce = 2000,
    maxDebounce = 10000,
    gitEnabled = true,
    commitDebounceMs = 30_000,
    wipRef = 'refs/wip/main',
    configHomedirOverride,
    enableTestRoutes = false,
    shadowRepo,
    contentRoot,
    destroyTimeoutMs = 10_000,
    localOpCliArgs,
    authStreamHeartbeatMs,
    skipStateManifestCheck = false,
    singleDocRelPath,
    ephemeral = false,
  } = options;
  const canonicalContentDir = resolveDirectoryRoot(contentDir, {
    root: 'content',
    component: 'server-factory',
  });
  const declaredGitHubHosts = readDeclaredGitHubHosts(configHomedirOverride);
  const resolveSyncCredentialConfig = createSyncCredentialConfigResolver({
    projectDir,
    tokenStore: options.tokenStore,
    localOpCliArgs,
    declaredGitHubHosts,
  });

  const log = getLogger('server');
  let headWatcher: HeadWatcherHandle | null = null;
  const getStorageBranch = () => headWatcher?.getLastKnownBranch() ?? null;
  const getReportedBranch = () =>
    headWatcher ? headWatcher.getLastKnownBranch() : readProjectHeadState(projectDir).branch;
  const generatedIndexWarningScope = createGeneratedIndexWarningScope(resolve(contentDir));
  let cc1Broadcaster: CC1Broadcaster | null = null;
  const initialBranch = readProjectHeadState(projectDir).branch ?? 'main';
  const diskReceipts = new DiskReceiptLog({
    path: join(getLocalDir(projectDir), 'receipts.jsonl'),
  });
  const receiptFileIsGone = receiptFileIsGoneIn(contentDir);
  const durabilityState = new DocumentDurabilityState(initialBranch, {
    persistencePath: join(getLocalDir(projectDir), 'stale-external-writes.json'),
    receipts: diskReceipts,
    onStaleExternalWriteChange: () => {
      cc1Broadcaster?.signal('sync-status');
      hydrateStaleExternalWrites();
    },
    onStoreRefused: (docName) => {
      if (rescueDocToShadowBuffer(docName, 'refused-store-mark') === 'lost') {
        log.warn(
          { docName },
          `[rescue] refused-store content for ${docName} was not durably buffered at refusal time`,
        );
      }
    },
    fileForDocName: (docName) =>
      relative(projectDir, safeContentPath(docName, contentDir)).replaceAll('\\', '/'),
    hasResolvedExtension: isRegisteredMarkdownDocName,
  });
  const getActiveBranch = () => durabilityState.getActiveBranch();
  const getReconciledBase = (docName: string) => durabilityState.getReconciledBase(docName);
  const setReconciledBase = (docName: string, content: string) =>
    durabilityState.setReconciledBase(docName, content);
  const deleteReconciledBase = (docName: string) => durabilityState.deleteReconciledBase(docName);
  const switchReconciledBaseScope = (branch: string) =>
    durabilityState.switchReconciledBaseScope(branch);
  const vanishedDocuments = new VanishedDocuments();
  const holdBatch = (owner: string): void => durabilityState.holdBatch(owner);
  const releaseBatchHold = (owner: string): boolean => durabilityState.releaseBatch(owner);
  const finishBatch = async (): Promise<void> => {
    try {
      await drainEventBuffer();
    } finally {
      disposeBufferedRemovalScopes();
    }
    await persistence.flushDeferredStores('within-branch');
  };
  const batchFlagFor =
    (owner: string) =>
    (value: boolean): void => {
      if (value) {
        holdBatch(owner);
        return;
      }
      if (!releaseBatchHold(owner)) return;
      void finishBatch().catch((err: unknown) => {
        log.error({ err, owner }, '[batch] draining after the batch failed');
      });
    };
  const isBatchInProgress = () => durabilityState.isBatchInProgress();

  const conflicts = new ConflictAuthority({
    projectDir,
    contentDir,
    assertResolutionPath: assertConflictContentPath,
    branch: initialBranch,
    signal: { signal: (channel) => cc1Broadcaster?.signal(channel) },
    io: {
      gitRaw: async (args) =>
        createGitInstance(projectDir, { credentialConfig: [], timeoutMs: 30_000 }).git.raw(args),
      writeProjectFileUntracked: (absPath, bytes) => {
        assertConflictContentPath(absPath);
        tracedWriteFileSync(absPath, bytes, 'utf-8');
      },
      unlinkProjectFileUndeclared: (absPath) => {
        assertConflictContentPath(absPath);
        tracedUnlinkSync(absPath);
      },
      deleteResolvedContent: (docName, absPath) => {
        assertContentPath(absPath);
        const declaration = registerRemoval(absPath);
        try {
          tracedUnlinkSync(absPath);
        } catch (cause) {
          retractRemoval(declaration);
          throw cause;
        }
        contentFilter.decrementMdDir(dirname(docName));
        commentDocHooksRef.current?.deleted(docName);
      },
      applyResolvedContent: async (docName, absPath, bytes) => {
        assertContentPath(absPath);
        const absent = !existsSync(absPath);
        registerWrite(absPath, contentHash(bytes));
        await atomicWriteFile(absPath, bytes, { fs: scopedAtomicFs });
        if (absent) contentFilter.incrementMdDir(dirname(docName));
        if (hocuspocus.documents.get(docName)) applyToDoc(docName, bytes);
        setReconciledBase(docName, bytes);
        await derivedDocumentIndex.recordDiskUpsert(docName, bytes);
      },
      readLiveContent: (docName) => serializeDoc(docName),
      finalizeReconcileResolution: async (entry, strategy, docName) => {
        let priorStaleExternalWrite:
          | { conflict: StaleExternalWriteConflict; branch: string }
          | undefined;
        if (entry.reason === 'stale-external-write') {
          const conflict = durabilityState.getStaleExternalWrite(docName);
          if (conflict) {
            priorStaleExternalWrite = { conflict, branch: durabilityState.getActiveBranch() };
          }
          if (strategy === 'mine' || strategy === 'content') {
            durabilityState.recordDisplacedVersion(docName, entry.stages.theirs);
          } else {
            durabilityState.clearDisplacedVersions(docName);
          }
          durabilityState.clearStaleExternalWrite(docName);
        }
        if (strategy === 'delete' && hasAdmittedMarkdownBinding(docName)) {
          log.debug(
            { docName, source: 'resolve-delete', bindingRecreated: true },
            `[reconcile] delete skipped: ${docName} (binding recreated)`,
          );
          return;
        }
        const document = hocuspocus.documents.get(docName);
        const lifecycle = document?.getMap('lifecycle');
        if (strategy === 'delete') {
          const removal = beginRemoval(docName);
          try {
            const isDirty =
              removal.residentCurrent() && document
                ? rescueUnflushedEditsBeforeTeardown(
                    docName,
                    headWatcher?.getLastKnownBranch() ?? 'main',
                    'delete',
                    true,
                  )
                : false;
            if (removal.namespaceCurrent()) {
              commentDocHooksRef.current?.deleted(docName);
              await derivedDocumentIndex.recordDiskDelete(docName);
            }
            if (!removal.namespaceCurrent() && !removal.residentCurrent()) {
              log.debug(
                {
                  docName,
                  source: 'resolve-delete',
                  namespaceCurrent: false,
                  residentCurrent: false,
                },
                `[reconcile] delete skipped: ${docName} (stale removal)`,
              );
              return;
            }
            log.info(
              { docName, isDirty, source: 'resolve-delete' },
              `[reconcile] delete: ${docName} (dirty=${isDirty})`,
            );
            const priorLifecycle = lifecycle
              ? {
                  status: lifecycle.get('status'),
                  reason: lifecycle.get('reason'),
                  detectedAt: lifecycle.get('detectedAt'),
                }
              : undefined;
            if (document && removal.residentCurrent()) {
              lifecycle?.set('status', 'deleted-upstream');
              lifecycle?.delete('reason');
              lifecycle?.delete('detectedAt');
              try {
                hocuspocus.closeConnections(docName);
                await forceUnloadDocument(document, removal.residentCurrent);
              } catch (cause) {
                if (removal.residentCurrent() && lifecycle && priorLifecycle) {
                  for (const [key, value] of Object.entries(priorLifecycle)) {
                    if (value === undefined) lifecycle.delete(key);
                    else lifecycle.set(key, value);
                  }
                }
                if (removal.namespaceCurrent() && priorStaleExternalWrite) {
                  try {
                    durabilityState.restoreStaleExternalWrite(
                      priorStaleExternalWrite.conflict,
                      priorStaleExternalWrite.branch,
                    );
                  } catch (rollbackFailure) {
                    log.error(
                      { err: rollbackFailure, docName },
                      `[reconcile] stale-external-write rollback failed for ${docName}; the retry may not find the conflict`,
                    );
                  }
                }
                throw cause;
              }
            }
            if (!removal.namespaceCurrent()) {
              log.debug(
                {
                  docName,
                  source: 'resolve-delete',
                  namespaceCurrent: false,
                  residentCurrent: removal.residentCurrent(),
                },
                `[reconcile] delete: ${docName} not recorded as removed (stale removal)`,
              );
              return;
            }
            deleteReconciledBase(docName);
            onUpstreamDelete(docName);
            scheduleIndexRegenerationAfterRemoval(docName);
            console.info(
              JSON.stringify({
                event: 'recently-removed-docs-populate',
                docName,
                kind: 'deleted',
                source: 'resolve-delete',
              }),
            );
          } finally {
            removal.dispose();
          }
        } else if (lifecycle?.get('reason') === entry.reason) {
          lifecycle.delete('status');
          lifecycle.delete('reason');
          lifecycle.delete('detectedAt');
        }
        signalChannel('files');
      },
    },
  });

  function hydrateStaleExternalWrites(): void {
    for (const stale of durabilityState.listStaleExternalWrites()) {
      const base = getReconciledBase(stale.docName) ?? stale.diskContent;
      conflicts.raise({
        kind: 'reconcile',
        file: stale.file,
        reason: 'stale-external-write',
        detectedAt: stale.detectedAt,
        stages: {
          base,
          ours: stale.retainedContent ?? base,
          theirs: stale.diskContent,
        },
      });
    }
  }
  hydrateStaleExternalWrites();

  function readProjectAttachmentFolderPath(options?: { requireValid?: boolean }): string {
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project config'),
    });
    if (!project.valid) {
      const attachmentIssues =
        isKnownConfigError(project.error) && project.error.code === 'SCHEMA_INVALID'
          ? (project.error.issues as ConfigIssue[]).filter(
              (issue) => issue.path.map(String).join('.') === 'content.attachmentFolderPath',
            )
          : [];
      if (attachmentIssues.length > 0) {
        const details = attachmentIssues.map((issue) => issue.message).join('; ');
        throw new Error(`Invalid content.attachmentFolderPath in project config: ${details}`);
      }
      if (options?.requireValid) {
        throw new Error('Project config is invalid', { cause: project.error });
      }
      log.warn(
        {},
        '[config] committed content.attachmentFolderPath unavailable (project config invalid) — using default attachment placement',
      );
    }
    return project.value.content.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH;
  }

  function readProjectAutoSyncMode(): { mode: SyncMode; source: SyncModeChangeSource } {
    const local = readConfigSafely({
      absPath: resolveConfigPath('project-local', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
    const localMode = resolveLocalAutoSyncMode(local.value.autoSync);
    if (localMode !== null) {
      return { mode: localMode, source: 'config' };
    }
    if (!local.valid) {
      log.warn(
        {},
        '[config] project-local autoSync.mode unavailable (config invalid) — falling back to the committed project default',
      );
    }
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project config'),
    });
    if (!project.valid) {
      log.warn(
        {},
        '[config] committed autoSync.default unavailable (project config invalid) — defaulting to disabled',
      );
    }
    return {
      mode: modeFromCommittedDefault(project.value.autoSync?.default) ?? 'off',
      source: 'committed-default',
    };
  }

  function readProjectAutoSyncIntervals(): {
    pullIntervalSeconds: number;
    pushIntervalSeconds: number;
  } {
    const local = readConfigSafely({
      absPath: resolveConfigPath('project-local', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
    return resolveAutoSyncIntervals(local.value.autoSync);
  }

  function readLinterBaseConfig(): LinterConfig {
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project config for linter'),
    });
    const persisted = project.value.contentRules as PersistedLinterConfig | undefined;
    const base = persisted ? toEffectiveBase(persisted) : DEFAULT_LINTER_CONFIG;
    ensureOkfSchemaFiles(projectDir, base.plugins.okf);
    return base;
  }

  function readLinkAdvisoryPolicy(): LinkAdvisoryPolicy {
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) =>
        log.warn({ message }, '[config] could not read project config for link validation'),
    });
    return {
      links: project.value.validation?.links ?? DEFAULT_LINKS_VALIDATION,
      suppressLogLinkAdvisories:
        project.value.validation?.suppressLogLinkAdvisories ?? DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
    };
  }

  function readSemanticSearchConfig(): ResolvedSemanticConfig {
    return readProjectLocalSemanticConfig(projectDir, {
      configHomedirOverride,
      onWarn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
  }

  function readLinkPreviewsEnabled(): boolean {
    const local = readConfigSafely({
      absPath: resolveConfigPath('project-local', projectDir, configHomedirOverride),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
    if (!local.valid) return false;
    return local.value.linkPreviews?.enabled === true;
  }

  function readConfigDiagnostics(): ConfigDiagnosticsReport {
    return collectConfigDiagnostics({
      cwd: projectDir,
      homedirOverride: configHomedirOverride,
      warn: (message) => log.debug({ message }, '[config] diagnostics read'),
    });
  }

  function logConfigDiagnostics(configDocName?: string): void {
    const configDocNamesByScope = {
      user: CONFIG_DOC_NAME_USER,
      project: CONFIG_DOC_NAME_PROJECT,
      'project-local': CONFIG_DOC_NAME_PROJECT_LOCAL,
    };
    for (const finding of readConfigDiagnostics().diagnostics) {
      if (configDocName !== undefined && configDocNamesByScope[finding.scope] !== configDocName) {
        continue;
      }
      if (finding.code === 'VALUE_FALLBACK') {
        for (const issue of finding.issues) {
          log.warn(
            {
              code: finding.code,
              scope: finding.scope,
              file: finding.file,
              path: issue.path.join('.'),
              line: issue.line,
              column: issue.column,
            },
            `[config] ${issue.path.join('.')}: ${issue.message}`,
          );
        }
        continue;
      }
      if (finding.code !== 'REMOVED_KEY') continue;
      log.warn(
        { scope: finding.scope, file: finding.file, path: finding.path.join('.') },
        `[config] ${finding.path.join('.')} is no longer read and was ignored. ${finding.redirect}`,
      );
    }
  }

  function semanticProviderFingerprint(cfg: ResolvedSemanticConfig): string {
    return `${normalizeProviderId(cfg.baseUrl)}|${cfg.model}|${cfg.dimensions ?? 'auto'}`;
  }

  function semanticTransportFingerprint(cfg: ResolvedSemanticConfig): string {
    return `${cfg.maxBatchSize}|${cfg.maxBatchChars}|${cfg.docTimeoutMs}`;
  }

  let lastAppliedAttachmentFolderPath: string | undefined;
  let projectConfigEpoch = 0;

  function applyPersistedConfigToConsumers(
    configDocName: string,
    generatedIndexEnabledOverride?: boolean,
  ): void {
    let appliedAutoSyncMode: SyncMode | undefined;
    if (
      configDocName === CONFIG_DOC_NAME_PROJECT ||
      configDocName === CONFIG_DOC_NAME_PROJECT_LOCAL
    ) {
      const resolved = readProjectAutoSyncMode();
      appliedAutoSyncMode = resolved.mode;
      void syncEngine?.setMode(resolved.mode, resolved.source).catch((err) => {
        log.warn(
          { err, mode: resolved.mode, docName: configDocName },
          '[sync] failed to apply autoSync mode from config',
        );
      });
      const intervals = readProjectAutoSyncIntervals();
      syncEngine?.setIntervals(intervals.pullIntervalSeconds, intervals.pushIntervalSeconds);
    }
    const semCfg = readSemanticSearchConfig();
    semanticSearch.applyConfig({
      enabled: semCfg.enabled,
      providerFingerprint: semanticProviderFingerprint(semCfg),
      transportFingerprint: semanticTransportFingerprint(semCfg),
      maxBatchSize: semCfg.maxBatchSize,
    });
    if (configDocName === CONFIG_DOC_NAME_PROJECT) {
      projectConfigEpoch += 1;
      try {
        const nextAttachmentFolderPath = readProjectAttachmentFolderPath({ requireValid: true });
        contentFilter?.setAttachmentFolderPath(nextAttachmentFolderPath);
        if (
          lastAppliedAttachmentFolderPath !== undefined &&
          nextAttachmentFolderPath !== lastAppliedAttachmentFolderPath
        ) {
          log.warn(
            { previous: lastAppliedAttachmentFolderPath, next: nextAttachmentFolderPath },
            '[content-filter] attachment folder changed — files under the previous folder no longer sync',
          );
        }
        lastAppliedAttachmentFolderPath = nextAttachmentFolderPath;
      } catch (err) {
        log.warn(
          { err },
          '[content-filter] project config invalid — keeping previous attachment admission',
        );
      }
      cc1Broadcaster?.signal('lint-config');
      const generatedIndexEnabled =
        generatedIndexEnabledOverride ??
        readLinterBaseConfig().plugins.okf?.generate?.index === true;
      if (!generatedIndexEnabled) {
        void updateGeneratedIndexGitAttributes({
          projectDir,
          contentDir,
          generatedDocNames: generatedIndexDocNamesForGitAttributes(),
          enabled: false,
        }).then((result) => {
          if (!result.ok) {
            log.warn(
              { state: result.status.state },
              '[index] could not remove Open Knowledge generated-index Git attributes',
            );
          }
        });
      }
      scheduleFullIndexSweep();
    }
    log.info(
      {
        docName: configDocName,
        autoSyncMode: appliedAutoSyncMode,
        semanticEnabled: semCfg.enabled,
      },
      '[config] applied persisted config to in-process consumers',
    );
  }

  initTelemetry();

  const serverInstanceId = randomUUID();
  let authorityRetired = false;
  let documentAdmissionClosed = false;
  let authorityScope = snapshotServerContentScope(contentDir, singleDocRelPath);
  const assertContentPath = (path: string): void => {
    if (authorityRetired) throw new ServerMutationShuttingDownError(false);
    assertServerContentPath(authorityScope, path);
  };
  const assertContentSubtree = (path: string): void => {
    assertContentPath(path);
    assertServerContentSubtree(authorityScope, path);
  };
  const scopedAtomicFs = contentScopedAtomicFs(assertContentPath);
  function assertConflictContentPath(path: string): void {
    assertRealpathWithinDir(path, projectDir, { allowShareableOkArtifact: isShareableOkArtifact });
    const canonical = canonicalContentPath(path);
    const projectPath = toPosix(relative(canonicalContentPath(projectDir), canonical));
    if (
      authorityScope.kind === 'tree' &&
      !contentScopeContainsPath(
        { kind: 'tree', path: authorityScope.path, excluded: [] },
        canonical,
      ) &&
      isShareableOkArtifact(projectPath)
    )
      return;
    assertContentPath(canonical);
  }

  const lockDir = getLocalDir(projectDir);

  const acpRegistry = new AcpRegistry({
    localDir: lockDir,
    log: getLogger('acp-registry'),
    fetchImpl: options.acpRegistryFetchImpl,
  });
  const acpPermissions = new AcpPermissionStore(lockDir, getLogger('acp-permissions'));

  let authority: ReturnType<typeof acquireServerAuthority>;
  try {
    authority = acquireServerAuthority({
      scope: authorityScope,
      projectDir: canonicalContentPath(projectDir),
      serverInstanceId,
      registryPath: options.authorityRegistryPath,
    });
  } catch (error) {
    if (
      error instanceof ServerAuthorityCollisionError &&
      error.existing.projectDir === canonicalContentPath(projectDir)
    ) {
      const existing = readServerLock(lockDir);
      if (existing?.pid === error.existing.pid) {
        throw new ServerLockCollisionError(existing, join(lockDir, 'server.lock'));
      }
    }
    throw error;
  }
  authorityScope = authority.scope;
  let primaryLockAcquired = false;
  try {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: projectDir,
      kind: options.lockKind ?? 'interactive',
      capabilities: options.capabilities ?? ['http', 'ws'],
    });
    primaryLockAcquired = true;
    if (!skipStateManifestCheck) {
      assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir: resolveShadowDir(projectDir),
      });
    }
  } catch (error) {
    if (primaryLockAcquired) releaseServerLock(lockDir);
    try {
      authority.release();
    } catch (cleanupError) {
      log.error({ err: cleanupError }, '[server] startup authority release failed');
    }
    throw error;
  }

  const basenameIndex: BasenameIndex = createBasenameIndex();

  const resolveTrackedFile = createTrackedFileResolver(() =>
    localTargetInventoryFromWatcher(watcher, contentDir),
  );
  const resolveTrackedWikiFile = createTrackedWikiFileResolver(() =>
    localTargetInventoryFromWatcher(watcher, contentDir),
  );

  const resolveEmbed = (target: string, sourcePath: string): string | null => {
    const wikiPath = wikiFilePath(target);
    if (wikiPath === null || !wikiPath.includes('/')) {
      return basenameIndex.resolveEmbed(target, sourcePath);
    }
    return resolveTrackedWikiFile(wikiPath) ?? null;
  };

  const resolveSize = (basename: string, sourcePath: string): number | null => {
    let candidatePath: string | null = resolveEmbed(basename, sourcePath);
    if (!candidatePath && basename.includes('/')) {
      candidatePath = basename.replace(/^\.?\//, '');
    }
    if (!candidatePath) return null;
    const fullPath = resolve(contentDir, candidatePath);
    const contentDirAbs = resolve(contentDir);
    if (!isWithinDir(fullPath, contentDirAbs)) {
      return null;
    }
    try {
      const stat = statSync(fullPath);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };

  let contentFilter: ReturnType<typeof createContentFilter>;
  let derivedDocumentIndex: DerivedDocumentIndex;
  let shadowRef: ShadowRef;
  let maintenanceCoordinator: MaintenanceCoordinator | undefined;
  let persistence: ReturnType<typeof createPersistenceExtension>;
  let lossRing: LossCaptureRing | undefined;
  let hocuspocus: Hocuspocus;
  let sessionManager: AgentSessionManager;
  let nativeApi: NativeApiHandle;
  let localApi: LocalApiDispatch;
  let shutdownLocalOps: () => Promise<void>;
  let bridgeLossReporter: BridgeDeriveLossReporter | undefined;
  let inPlaceRescanTimer: ReturnType<typeof setTimeout> | null = null;
  let shadowWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  const IN_PLACE_RESCAN_DEBOUNCE_MS = 500;
  let agentFocusBroadcaster: AgentFocusBroadcaster | null = null;
  let agentPresenceBroadcaster: AgentPresenceBroadcaster | null = null;
  let invalidateReferencedAssetsCache: (() => void) | null = null;
  let stalenessWatchdog: StalenessWatchdogHandle | null = null;

  const initialSemanticConfig = readSemanticSearchConfig();
  const semanticSearch = new SemanticSearchService({
    loadEmbedder: () => {
      const cfg = readSemanticSearchConfig();
      const input: LoadOpenAiEmbedderInput = {
        keyStore: options.embeddingsKeyStore ?? null,
        projectDir,
        config: { baseUrl: cfg.baseUrl, model: cfg.model, dimensions: cfg.dimensions },
        options: {
          maxBatchSize: cfg.maxBatchSize,
          maxBatchChars: cfg.maxBatchChars,
          docTimeoutMs: cfg.docTimeoutMs,
        },
      };
      return (options.embedderLoader ?? loadOpenAiEmbedder)(input);
    },
    cacheDir: join(getLocalDir(projectDir), 'embeddings'),
    enabled: initialSemanticConfig.enabled,
    providerFingerprint: semanticProviderFingerprint(initialSemanticConfig),
    transportFingerprint: semanticTransportFingerprint(initialSemanticConfig),
    maxBatchSize: initialSemanticConfig.maxBatchSize,
  });

  let loadedPrincipal: Principal | null = null;
  const forceUnloadRequests = new Map<Document, Set<() => boolean>>();
  let shutdownAllowsUnload = false;
  const unregisterWorkloadProviders: Array<() => void> = [];
  let forceUnloadDocument!: (document: Document, isCurrent?: () => boolean) => Promise<void>;
  let defaultShouldUnloadDocument!: (document: Document) => boolean;

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyForNotices = false;
  void ready.then(
    () => {
      readyForNotices = true;
    },
    () => {},
  );
  const noticeDisplayPath = (abs: string): string =>
    displayPathFor(abs, projectDir, configHomedirOverride ?? homedir());
  let heldSaveProbe: (docName: string) => boolean = () => true;
  const noticeFileOutsideContent = (docName: string): NoticeFile | null => {
    let abs: string;
    try {
      if (isConfigDoc(docName)) abs = configDocAbsPath(docName, persistence.configPersistenceCtx);
      else if (isManagedArtifactDoc(docName)) {
        abs = managedArtifactAbsPath(docName, persistence.managedArtifactCtx);
      } else return null;
    } catch (err) {
      log.debug(
        { err, docName },
        '[doc-notices] no file to name for a notice outside the content folder',
      );
      return null;
    }
    return { abs, display: noticeDisplayPath(abs) };
  };
  const docNotices = new DocNoticeLedger({
    projectDir,
    contentDir,
    getShadow: () => shadowRef?.current,
    isReady: () => readyForNotices,
    signal: () => cc1Broadcaster?.signal('sync-status'),
    isHeld: (docName) => vanishedDocuments.has(docName),
    isSaveHeld: (docName) => heldSaveProbe(docName),
    resolveFile: noticeFileOutsideContent,
  });
  const mergeHistory = createMergeHistoryRecorder({
    getShadow: () => shadowRef?.current,
    contentRoot: contentRoot ?? '',
    getBranch: getStorageBranch,
    writeCheckpoint: options.mergeHistoryWriter,
    notices: docNotices,
  });
  const offlineRemovalsReconciled = Promise.withResolvers<void>();

  let resolveBranchScopeAligned!: () => void;
  const branchScopeAligned = new Promise<void>((res) => {
    resolveBranchScopeAligned = res;
  });

  const BRANCH_SCOPE_GATE_TIMEOUT_MS = 10_000;

  async function resolveBranchForClaimCheck(): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = Symbol('branch-scope-gate-timeout');
    const timeout = new Promise<typeof expired>((res) => {
      timer = setTimeout(() => res(expired), BRANCH_SCOPE_GATE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([branchScopeAligned, timeout]);
      if (outcome !== expired) return getActiveBranch();
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      return readProjectHeadState(projectDir).branch ?? null;
    } catch (err) {
      log.warn(
        { err },
        '[auth] branch scope gate expired and HEAD is unreadable — skipping the branch claim check',
      );
      return null;
    }
  }

  function signalChannel(
    channel:
      | 'files'
      | 'backlinks'
      | 'graph'
      | 'tags'
      | 'comments'
      | 'lint-config'
      | 'local-targets',
  ): void {
    cc1Broadcaster?.signal(channel);
  }

  const INDEX_REGENERATION_DEBOUNCE_MS = 500;
  let indexRegenerationTimer: NodeJS.Timeout | undefined;
  let indexRegenerationImmediate: NodeJS.Immediate | undefined;
  let indexRegenerationInFlight: Promise<void> | undefined;
  let indexRegenerationReady = false;
  let indexRegenerationClosed = false;
  const indexRegenerationAbort = new AbortController();
  const pendingIndexDirectories = new Set<string>();
  let pendingIndexFullSweep = false;
  let pendingBootIndexSweep = false;

  let generatedIndexSweepSettled = false;
  let generatedIndexBootSweepCount = 0;
  let resolveGeneratedIndexSweep!: (result: GeneratedIndexSweepResult) => void;
  const generatedIndexSweepReady = new Promise<GeneratedIndexSweepResult>((resolve) => {
    resolveGeneratedIndexSweep = resolve;
  });

  function settleGeneratedIndexSweep(result: GeneratedIndexSweepResult): void {
    if (generatedIndexSweepSettled) return;
    generatedIndexSweepSettled = true;
    resolveGeneratedIndexSweep(result);
  }

  type IndexRegenerationRequest =
    | { fullSweep: true }
    | { fullSweep: false; directories: ReadonlySet<string> };

  type IndexRegenerationPassResult =
    | GeneratedIndexSweepResult
    | { status: 'deferred'; indexCount: number };

  function hasPendingIndexRegeneration(): boolean {
    return pendingIndexFullSweep || pendingIndexDirectories.size > 0;
  }

  function armIndexRegeneration(): void {
    if (indexRegenerationClosed || !indexRegenerationReady) return;
    if (indexRegenerationTimer !== undefined) clearTimeout(indexRegenerationTimer);
    indexRegenerationTimer = setTimeout(() => {
      indexRegenerationTimer = undefined;
      kickIndexRegeneration();
    }, INDEX_REGENERATION_DEBOUNCE_MS);
    indexRegenerationTimer.unref?.();
  }

  function deferBootIndexSweep(): void {
    if (indexRegenerationClosed) {
      settleGeneratedIndexSweep({ status: 'cancelled', indexCount: 0 });
      return;
    }
    pendingIndexFullSweep = true;
    pendingBootIndexSweep = true;
    indexRegenerationImmediate = setImmediate(() => {
      indexRegenerationImmediate = undefined;
      kickIndexRegeneration();
    });
  }

  let shadowHousekeepingImmediate: NodeJS.Immediate | undefined;
  let shadowHousekeepingInFlight: Promise<void> | undefined;
  let shadowHousekeepingClosed = false;
  let bootRenameLogIndex: ReturnType<typeof loadRenameLogIndex> | null = null;

  async function runShadowHousekeeping(): Promise<void> {
    const shadow = shadowRef.current;
    if (!shadow || shadowHousekeepingClosed) return;
    const startedAtMono = performance.now();
    log.info({ gitDir: shadow.gitDir }, '[shadow-housekeeping] deferred boot housekeeping started');
    try {
      await configureShadowGc(shadow);
    } catch (e) {
      log.warn({ err: e }, 'failed to write gc config (non-fatal)');
    }
    if (shadowHousekeepingClosed) return;
    if (bootRenameLogIndex) {
      try {
        const RETRY_BUDGET = 30;
        const retryIntervalMs =
          Number.parseInt(process.env.OK_BOOT_RENAME_GC_RETRY_INTERVAL_MS ?? '', 10) || 1_000;
        let rebuilt = false;
        for (let attempt = 0; attempt < RETRY_BUDGET; attempt++) {
          const gc = await gcRenameLog(shadow, bootRenameLogIndex, { rebuild: true });
          if (!gc.skipped) {
            rebuilt = true;
            break;
          }
          if (attempt === RETRY_BUDGET - 1) break;
          await new Promise((r) => {
            setTimeout(r, retryIntervalMs).unref?.();
          });
          if (shadowHousekeepingClosed) return;
        }
        if (!rebuilt) {
          log.warn(
            { gitDir: shadow.gitDir },
            '[rename-log] deferred boot GC/rebuild retry budget exhausted (persistent GC contention); rebuild deferred to next boot',
          );
        }
      } catch (e) {
        log.warn(
          { err: e, gitDir: shadow.gitDir },
          '[rename-log] deferred boot GC/rebuild failed; index loaded without GC',
        );
      }
    }
    if (shadowHousekeepingClosed) return;
    try {
      await maintenanceCoordinator?.runBootMaintenance();
    } catch (e) {
      log.warn({ err: e }, '[shadow-maintenance] boot maintenance failed (non-fatal)');
    }
    log.info(
      { gitDir: shadow.gitDir, durationMs: Math.round(performance.now() - startedAtMono) },
      '[shadow-housekeeping] deferred boot housekeeping complete',
    );
  }

  function deferShadowHousekeeping(): void {
    if (shadowHousekeepingClosed) return;
    shadowHousekeepingImmediate = setImmediate(() => {
      shadowHousekeepingImmediate = undefined;
      shadowHousekeepingInFlight = runShadowHousekeeping().catch((err) => {
        log.error({ err }, '[shadow-housekeeping] unexpected uncaught failure');
      });
    });
  }

  async function closeShadowHousekeeping(): Promise<void> {
    shadowHousekeepingClosed = true;
    if (shadowHousekeepingImmediate !== undefined) {
      clearImmediate(shadowHousekeepingImmediate);
      shadowHousekeepingImmediate = undefined;
    }
    if (!shadowHousekeepingInFlight) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), destroyTimeoutMs);
    });
    try {
      const outcome = await Promise.race([shadowHousekeepingInFlight, timedOut]);
      if (outcome === 'timeout') {
        throw new Error(
          `shadow housekeeping drain timed out after ${destroyTimeoutMs}ms — abandoning in-flight housekeeping`,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function kickIndexRegeneration(): void {
    if (indexRegenerationClosed || !indexRegenerationReady || !hasPendingIndexRegeneration()) {
      return;
    }
    if (indexRegenerationInFlight !== undefined) {
      options.generatedIndexTestHooks?.onKickWhileInFlight?.();
      return;
    }
    if (durabilityState.isBatchInProgress()) {
      armIndexRegeneration();
      return;
    }

    const fullSweep = pendingIndexFullSweep;
    const directories = new Set(pendingIndexDirectories);
    const includesBootSweep = pendingBootIndexSweep;
    pendingIndexFullSweep = false;
    pendingIndexDirectories.clear();
    pendingBootIndexSweep = false;
    const request: IndexRegenerationRequest = fullSweep
      ? { fullSweep: true }
      : { fullSweep: false, directories };

    indexRegenerationInFlight = (async () => {
      const result = await regenerateIndexes(request, indexRegenerationAbort.signal);
      if (result.status === 'deferred') {
        pendingIndexFullSweep = true;
        if (includesBootSweep) {
          generatedIndexBootSweepCount += result.indexCount;
          pendingBootIndexSweep = true;
        }
        return;
      }
      if (includesBootSweep) {
        generatedIndexBootSweepCount += result.indexCount;
        if (result.status === 'completed' && hasPendingIndexRegeneration()) {
          pendingBootIndexSweep = true;
        } else {
          settleGeneratedIndexSweep({ ...result, indexCount: generatedIndexBootSweepCount });
        }
      }
    })()
      .catch((err: unknown) => {
        log.warn({ err }, '[index] index regeneration coordinator failed');
        if (includesBootSweep) settleGeneratedIndexSweep({ status: 'failed', indexCount: 0 });
      })
      .finally(() => {
        indexRegenerationInFlight = undefined;
        if (indexRegenerationClosed) {
          if (includesBootSweep) {
            settleGeneratedIndexSweep({ status: 'cancelled', indexCount: 0 });
          }
          return;
        }
        if (hasPendingIndexRegeneration() && indexRegenerationTimer === undefined) {
          armIndexRegeneration();
        } else if (!hasPendingIndexRegeneration() && indexRegenerationTimer === undefined) {
          options.generatedIndexTestHooks?.onIdle?.();
        }
      });
  }

  async function closeIndexRegeneration(): Promise<void> {
    if (!indexRegenerationClosed) {
      const inFlight = indexRegenerationInFlight;
      indexRegenerationClosed = true;
      indexRegenerationAbort.abort();
      if (indexRegenerationTimer !== undefined) {
        clearTimeout(indexRegenerationTimer);
        indexRegenerationTimer = undefined;
      }
      if (indexRegenerationImmediate !== undefined) {
        clearImmediate(indexRegenerationImmediate);
        indexRegenerationImmediate = undefined;
      }
      pendingIndexDirectories.clear();
      pendingIndexFullSweep = false;
      pendingBootIndexSweep = false;
      if (inFlight === undefined) {
        settleGeneratedIndexSweep({ status: 'cancelled', indexCount: 0 });
      }
    }
    await indexRegenerationInFlight;
  }

  function scheduleIndexRegeneration(docName: string): void {
    if (indexRegenerationClosed || isGeneratedIndexDocName(docName)) return;
    pendingIndexDirectories.add(directoryOf(docName));
    armIndexRegeneration();
  }

  function scheduleSubdirectoryIndexRegeneration(directory: string): void {
    if (indexRegenerationClosed) return;
    for (const ancestor of directoryChainToRoot(directory)) {
      pendingIndexDirectories.add(ancestor);
    }
    armIndexRegeneration();
  }

  function scheduleIndexRegenerationAfterRemoval(docName: string): void {
    const fileIndex = watcher?.getFileIndex();
    if (!fileIndex) {
      scheduleIndexRegeneration(docName);
      return;
    }

    const sourceDirectory = directoryOf(docName);
    const desiredDirectories = collectIndexDirectories(fileIndex.keys());
    if (desiredDirectories.has(sourceDirectory)) {
      scheduleIndexRegeneration(docName);
      return;
    }

    scheduleSubdirectoryIndexRegeneration(directoryOf(sourceDirectory));
  }

  function scheduleFullIndexSweep(): void {
    if (indexRegenerationClosed) return;
    pendingIndexFullSweep = true;
    armIndexRegeneration();
  }

  function currentIndexedFields(docName: string): PreviousIndexedFields | undefined {
    const entry = watcher?.getFileIndex().get(docName);
    if (!entry) return undefined;
    return { title: entry.title, description: entry.description, type: entry.type };
  }

  let generatedAttributionPending = false;
  const generatedArtifactEnv: GeneratedArtifactEnv = {
    origin: GENERATED_ARTIFACT_ORIGIN,
    writer: OK_GENERATOR_WRITER,
    isConflict: (docName) => conflicts.has(docName),
    getDocument: (docName) => hocuspocus.documents.get(docName),
    writeDisk: async (absPath, markdown) => {
      assertContentPath(absPath);
      tracedMkdirSync(dirname(absPath), { recursive: true });
      await atomicWriteFile(absPath, markdown, { fs: scopedAtomicFs });
    },
    registerWrite: (absPath, markdown) => registerWrite(absPath, contentHash(markdown)),
    noteFileIndex: (event) =>
      watcher?.mutateFileIndex({
        kind: event.kind,
        path: event.absPath,
        docName: event.docName,
        content: event.markdown,
      }),
    signalFiles: () => signalChannel('files'),
    attribute: async (docName, writer) => {
      recordContributor(docName, writer.id, writer.name, writer.id);
      generatedAttributionPending = true;
    },
  };

  function indexDocNameFor(directory: string): string {
    return directory === '' ? ROOT_INDEX_DOC_NAME : `${directory}/${ROOT_INDEX_DOC_NAME}`;
  }

  function generatedIndexDocNamesForGitAttributes(): string[] {
    const directories = watcher
      ? collectIndexDirectories(watcher.getFileIndex().keys())
      : new Set<string>(['']);
    return [...directories].map(indexDocNameFor);
  }

  function toGeneratedIndexSettingsStatus(
    git: GeneratedIndexGitAttributesStatus,
  ): GeneratedIndexSettingsStatus {
    const enabled = readLinterBaseConfig().plugins.okf?.generate?.index === true;
    const admitted = git.state === 'ready' || git.state === 'not-applicable';
    return {
      enabled,
      active: enabled && admitted,
      git:
        git.state === 'ready'
          ? { state: git.state, ownership: git.ownership }
          : { state: git.state },
    };
  }

  function getGeneratedIndexSettingsStatus(): GeneratedIndexSettingsStatus {
    return toGeneratedIndexSettingsStatus(
      inspectGeneratedIndexGitAttributes({
        projectDir,
        contentDir,
        generatedDocNames: generatedIndexDocNamesForGitAttributes(),
      }),
    );
  }

  async function setGeneratedIndexEnabled(enabled: boolean): Promise<GeneratedIndexSettingsStatus> {
    const attributes = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames: generatedIndexDocNamesForGitAttributes(),
      enabled,
    });
    if (!attributes.ok) {
      return {
        ...getGeneratedIndexSettingsStatus(),
        applied: false,
        reason: attributes.status.state === 'conflict' ? 'git-conflict' : 'git-unavailable',
      };
    }

    const configResult = await writeConfigPatch({
      cwd: projectDir,
      scope: 'project',
      patch: { contentRules: { okf: { generate: { index: enabled } } } },
    });
    if (!configResult.ok) {
      try {
        await attributes.rollback();
      } catch (err) {
        log.error({ err }, '[index] could not roll back generated-index Git attributes');
      }
      return { ...getGeneratedIndexSettingsStatus(), applied: false, reason: 'config-write' };
    }

    try {
      const content = readFileSync(configResult.path, 'utf-8');
      await applyExternalConfigChange(
        hocuspocus.documents.get(CONFIG_DOC_NAME_PROJECT) ?? null,
        CONFIG_DOC_NAME_PROJECT,
        content,
        persistence.configPersistenceCtx,
      );
    } catch (err) {
      log.warn({ err }, '[index] generated-index settings reflection deferred to config watcher');
    }
    applyPersistedConfigToConsumers(CONFIG_DOC_NAME_PROJECT, enabled);
    logConfigDiagnostics(CONFIG_DOC_NAME_PROJECT);
    return { ...getGeneratedIndexSettingsStatus(), applied: true };
  }

  async function regenerateIndexes(
    request: IndexRegenerationRequest,
    signal: AbortSignal,
  ): Promise<IndexRegenerationPassResult> {
    let generatedIndexCount = 0;
    const sweepStartedAt = request.fullSweep ? performance.now() : undefined;
    const generationIsDisabled = () => readLinterBaseConfig().plugins.okf?.generate?.index !== true;
    try {
      if (signal.aborted) return { status: 'cancelled', indexCount: 0 };
      if (generationIsDisabled()) {
        return { status: 'disabled', indexCount: 0 };
      }

      const fileIndex = watcher?.getFileIndex();
      if (!fileIndex) return { status: 'failed', indexCount: 0 };

      try {
        await options.generatedIndexTestHooks?.beforePlan?.({
          fullSweep: request.fullSweep,
          signal,
        });
        if (signal.aborted) return { status: 'cancelled', indexCount: generatedIndexCount };
        if (generationIsDisabled()) {
          return { status: 'disabled', indexCount: generatedIndexCount };
        }
        if (durabilityState.isBatchInProgress()) {
          return { status: 'deferred', indexCount: generatedIndexCount };
        }
        const decisions = planDirectoryIndexRegenerations({
          docs: fileIndex,
          docExtension: getDocExtension,
          currentMarkdownFor: () => null,
          warningScope: generatedIndexWarningScope,
        });
        const gitAttributes = inspectGeneratedIndexGitAttributes({
          projectDir,
          contentDir,
          generatedDocNames: decisions.map(({ directory }) => indexDocNameFor(directory)),
        });
        if (gitAttributes.state !== 'ready' && gitAttributes.state !== 'not-applicable') {
          log.warn(
            { state: gitAttributes.state },
            '[index] generated index regeneration paused by Git attributes',
          );
          return { status: 'blocked', indexCount: generatedIndexCount };
        }

        for (const { directory, markdown } of decisions) {
          if (!request.fullSweep && !request.directories.has(directory)) continue;
          if (signal.aborted) {
            return { status: 'cancelled', indexCount: generatedIndexCount };
          }
          if (generationIsDisabled()) {
            return { status: 'disabled', indexCount: generatedIndexCount };
          }
          if (durabilityState.isBatchInProgress()) {
            return { status: 'deferred', indexCount: generatedIndexCount };
          }

          await options.generatedIndexTestHooks?.beforeDecision?.({
            directory,
            fullSweep: request.fullSweep,
            signal,
          });
          if (signal.aborted) {
            return { status: 'cancelled', indexCount: generatedIndexCount };
          }
          if (generationIsDisabled()) {
            return { status: 'disabled', indexCount: generatedIndexCount };
          }

          const docName = indexDocNameFor(directory);
          const absPath = resolve(contentDir, `${docName}.md`);
          assertContentPath(absPath);
          let currentMarkdown: string | null;
          try {
            currentMarkdown = readFileSync(absPath, 'utf-8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.warn(
                { err: error, path: normalizeFsPath(absPath) },
                '[index] could not read the existing generated index; treating it as absent',
              );
            }
            currentMarkdown = null;
          }

          generatedIndexCount += 1;
          const outcome = await writeGeneratedArtifact(
            { docName, absPath, markdown, currentMarkdown },
            generatedArtifactEnv,
          );
          if (outcome === 'blocked-conflict') {
            log.warn(
              {
                event: 'generated-index-regeneration',
                outcome: 'blocked',
                directory,
                reason: 'conflict',
              },
              '[index] generated index regeneration blocked by active conflict',
            );
          } else {
            log.info(
              {
                event: 'generated-index-regeneration',
                outcome: outcome === 'unchanged' ? 'unchanged' : 'written',
                directory,
              },
              '[index] generated index regeneration completed',
            );
          }
          await options.generatedIndexTestHooks?.afterWrite?.({
            docName,
            fullSweep: request.fullSweep,
            signal,
          });

          if (!request.fullSweep && directory !== '' && currentMarkdown === null) {
            scheduleSubdirectoryIndexRegeneration(directoryOf(directory));
          }
        }
      } finally {
        if (generatedAttributionPending) {
          await persistence.waitForPendingCommits();
          await persistence.flushContributors();
          generatedAttributionPending = false;
        }
        if (sweepStartedAt !== undefined) {
          recordBootPhase(
            'generatedIndexSweepMs',
            Math.round((performance.now() - sweepStartedAt) * 100) / 100,
          );
          setBootField('generatedIndexCount', generatedIndexCount);
        }
      }
      return { status: 'completed', indexCount: generatedIndexCount };
    } catch (err) {
      log.warn({ err }, '[index] index regeneration failed');
      return { status: 'failed', indexCount: generatedIndexCount };
    }
  }

  const REMOVED_DOCS_JOURNAL_SAVE_DEBOUNCE_MS = 2000;
  let removedDocsJournalTimer: ReturnType<typeof setTimeout> | null = null;
  let removedDocsJournalWritable = false;
  const writeRemovedDocsJournalNow = (): void => {
    try {
      saveRemovedDocsJournal(projectDir, recentlyRemovedDocs.entries());
    } catch (err) {
      log.warn({ err }, '[removed-docs-journal] failed to persist removal journal');
    }
  };
  const scheduleRemovedDocsJournalSave = (): void => {
    if (!removedDocsJournalWritable || removedDocsJournalTimer !== null) return;
    removedDocsJournalTimer = setTimeout(() => {
      removedDocsJournalTimer = null;
      writeRemovedDocsJournalNow();
    }, REMOVED_DOCS_JOURNAL_SAVE_DEBOUNCE_MS);
  };
  const recentlyRemovedDocs = new RecentlyRemovedDocs(undefined, {
    onEviction: () => incrementRecentlyRemovedDocsEviction(),
    onSizeChange: (size) => setRecentlyRemovedDocsSize(size),
    onMutate: scheduleRemovedDocsJournalSave,
  });
  for (const [journaledDocName, entry] of loadRemovedDocsJournal(projectDir)) {
    if (isReservedForUserTree(journaledDocName)) continue;
    if (!isSafeDocName(journaledDocName)) continue;
    const recreated = ['.md', '.mdx'].some((ext) => {
      const candidate = resolve(contentDir, `${journaledDocName}${ext}`);
      return isWithinDir(candidate, resolve(contentDir)) && existsSync(candidate);
    });
    if (recreated) continue;
    recentlyRemovedDocs.restore(journaledDocName, entry);
  }
  removedDocsJournalWritable = true;
  const commentDocHooksRef: { current: CommentDocHooks | null } = { current: null };

  type ResidentOccurrence = {
    source: string | undefined;
    mutation: { occurrence: ResidentOccurrence } | undefined;
    adoption: object | undefined;
    pendingRetirement: boolean;
  };
  let residentOccurrences = new WeakMap<Doc, ResidentOccurrence>();
  type RemovalOperation = { namespaceAllowed: boolean; residentAllowed: boolean };
  const activeRemovals = new Map<string, Set<RemovalOperation>>();

  const resolvedContentDir = resolve(contentDir);
  function resolveDocFilePath(docName: string): string | null {
    if (!isSafeDocName(docName)) return null;
    const relativePath = docNameToRelativePath(docName);
    const filePath = resolve(resolvedContentDir, relativePath);
    if (!isWithinDir(filePath, resolvedContentDir)) return null;
    return filePath;
  }

  function hasAdmittedMarkdownBinding(docName: string): boolean {
    const owner = watcher?.getFileIndex().get(docName);
    const filePath = owner?.canonicalPath ?? resolveDocFilePath(docName);
    if (filePath === null) return false;
    return hasAdmittedMarkdownFile(docName, filePath, contentDir, contentFilter);
  }

  function occurrenceFor(document: Doc): ResidentOccurrence {
    let occurrence = residentOccurrences.get(document);
    if (!occurrence) {
      occurrence = {
        source: document.getText('source').toString(),
        mutation: undefined,
        adoption: undefined,
        pendingRetirement: false,
      };
      residentOccurrences.set(document, occurrence);
    }
    return occurrence;
  }

  function revokeNamespaceRemovals(docName: string): void {
    for (const removal of activeRemovals.get(docName) ?? []) removal.namespaceAllowed = false;
  }

  function acceptResident(document: Doc, docName: string): void {
    if (
      documentAdmissionClosed ||
      document.isDestroyed ||
      hocuspocus.documents.get(docName) !== document
    )
      return;
    const occurrence = occurrenceFor(document);
    occurrence.pendingRetirement = false;
    occurrence.adoption = {};
    for (const removal of activeRemovals.get(docName) ?? []) {
      removal.namespaceAllowed = false;
      removal.residentAllowed = false;
    }
  }

  function markResidentForRetirement(document: Doc): void {
    residentOccurrences.set(document, {
      source: document.getText('source').toString(),
      mutation: undefined,
      adoption: undefined,
      pendingRetirement: true,
    });
  }

  function acceptNamespaceCreate(docName: string): void {
    if (documentAdmissionClosed) return;
    revokeNamespaceRemovals(docName);
    const document = hocuspocus.documents.get(docName);
    if (document) markResidentForRetirement(document);
    commentDocHooksRef.current?.deleted(docName);
  }

  function captureNamespaceMove(docName: string): () => void {
    const document = hocuspocus.documents.get(docName);
    const occurrence = document ? occurrenceFor(document) : undefined;
    const adoption = occurrence?.adoption;
    return () => {
      if (documentAdmissionClosed) return;
      revokeNamespaceRemovals(docName);
      if (
        document &&
        hocuspocus.documents.get(docName) === document &&
        residentOccurrences.get(document) === occurrence &&
        occurrence?.adoption === adoption
      )
        markResidentForRetirement(document);
    };
  }

  function capturePublicationReceipt(document: Doc, docName: string): (() => void) | undefined {
    const mutation = residentOccurrences.get(document)?.mutation;
    if (!mutation) return undefined;
    return () => {
      if (residentOccurrences.get(document) === mutation.occurrence)
        acceptResident(document, docName);
    };
  }

  function acceptConnectedDocument(docName: string, document: Document): void {
    if (hasAdmittedMarkdownBinding(docName)) acceptResident(document, docName);
  }

  function beginRemoval(docName: string, observedCurrent?: () => boolean) {
    const document = hocuspocus.documents.get(docName);
    const isApplicable = () =>
      (observedCurrent?.() ?? true) && !hasAdmittedMarkdownBinding(docName);
    const namespaceAllowed = !documentAdmissionClosed && isApplicable();
    const operation: RemovalOperation = {
      namespaceAllowed,
      residentAllowed:
        !documentAdmissionClosed &&
        document !== undefined &&
        (namespaceAllowed || occurrenceFor(document).pendingRetirement),
    };
    const removals = activeRemovals.get(docName) ?? new Set<RemovalOperation>();
    if (!documentAdmissionClosed) {
      removals.add(operation);
      activeRemovals.set(docName, removals);
    }
    const namespaceCurrent = () => {
      if (operation.namespaceAllowed && !isApplicable()) operation.namespaceAllowed = false;
      return operation.namespaceAllowed;
    };
    return {
      document,
      namespaceCurrent,
      residentCurrent: () => {
        if (
          operation.residentAllowed &&
          (document === undefined ||
            document.isDestroyed ||
            hocuspocus.documents.get(docName) !== document)
        )
          operation.residentAllowed = false;
        return operation.residentAllowed;
      },
      dispose: () => {
        operation.namespaceAllowed = false;
        operation.residentAllowed = false;
        removals.delete(operation);
        if (removals.size === 0) activeRemovals.delete(docName);
      },
    };
  }

  const onUpstreamRename = (oldDocName: string, newDocName: string): void => {
    if (isReservedForUserTree(oldDocName)) return;
    recentlyRemovedDocs.setRenamed(oldDocName, newDocName);
  };
  const onUpstreamDelete = (docName: string): void => {
    if (isReservedForUserTree(docName)) return;
    if (recentlyRemovedDocs.peek(docName)?.kind === 'renamed') {
      console.info(
        JSON.stringify({
          event: 'recently-removed-docs-unpaired-delete-suppressed',
          docName,
          source: 'watcher-delete',
        }),
      );
      return;
    }
    recentlyRemovedDocs.setDeleted(docName);
  };
  const onUpstreamAdd = (docName: string): void => {
    if (isReservedForUserTree(docName)) return;
    recentlyRemovedDocs.delete(docName);
  };

  try {
    let initialAttachmentFolderPath = DEFAULT_ATTACHMENT_FOLDER_PATH;
    try {
      initialAttachmentFolderPath = readProjectAttachmentFolderPath();
    } catch (err) {
      log.warn(
        { err },
        '[content-filter] invalid attachment folder at boot — using sibling admission',
      );
    }
    lastAppliedAttachmentFolderPath = initialAttachmentFolderPath;
    contentFilter = createContentFilter({
      projectDir,
      contentDir,
      isContentScopeExcluded: (path) => {
        if (authorityScope.kind !== 'tree') return false;
        try {
          const target = canonicalContentPath(path);
          return authorityScope.excluded.some((root) =>
            contentScopeContainsPath({ kind: 'tree', path: root, excluded: [] }, target),
          );
        } catch (err) {
          const code = errnoCode(err);
          if (!(err instanceof SymlinkEscapeError) && code !== 'EACCES' && code !== 'EPERM')
            throw err;
          log.warn(
            { path: normalizeFsPath(path), code },
            '[content-filter] scope path could not be inspected',
          );
          return true;
        }
      },
      singleDocRelPath,
      attachmentFolderPath: initialAttachmentFolderPath,
      inPlaceSkillDirs: new Set(scanInPlaceSkills(contentDir).map((skill) => skill.dir)),
      rescanInPlaceSkillDirs: (priorAdmission) => scanInPlaceSkillDirs(contentDir, priorAdmission),
      skillRootPaths: skillRootPathsFor(contentDir),
      onAfterRebuild: () => {
        void derivedDocumentIndex.refreshContentScope().catch((err) => {
          getLogger('server-factory').warn(
            { err },
            '[content-filter] derived-index rebuild failed after onAfterRebuild',
          );
        });
        void reconcileFileIndexAfterFilterRebuild(watcher)
          .then(({ prunedFiles, prunedFolders }) => {
            const pruned = prunedFiles + prunedFolders;
            if (pruned > 0) {
              getLogger('server-factory').info(
                { pruned, prunedFiles, prunedFolders },
                '[content-filter] reconciled file indexes after onAfterRebuild',
              );
            } else {
              getLogger('server-factory').debug(
                { prunedFiles, prunedFolders },
                '[content-filter] file index reconcile completed after onAfterRebuild (no entries pruned; rescan may have added entries)',
              );
            }
          })
          .catch((err) => {
            getLogger('server-factory').warn(
              { err },
              '[content-filter] file index reconcile failed after onAfterRebuild',
            );
          });
      },
    });
    derivedDocumentIndex = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter,
      getGlobalSkillRoots: () => managedArtifactSkillsRoots(persistence.managedArtifactCtx),
      signalChannel,
      getLocalTargetInventory: () => localTargetInventoryFromWatcher(watcher, canonicalContentDir),
      onRecoveredFileTarget: (relativePath, exists) => {
        if (!watcher) return;
        reconcileRecoveredFileTarget({
          watcher,
          contentDir,
          relativePath,
          exists,
          invalidateReferencedAssetsCache,
        });
      },
    });

    shadowRef = { current: shadowRepo };

    maintenanceCoordinator = gitEnabled
      ? createMaintenanceCoordinator({
          getShadow: () => shadowRef.current ?? null,
          getCurrentBranch: getStorageBranch,
          contentRoot: contentRoot ?? '',
          projectGitDir: resolveGitDir(projectDir) ?? undefined,
          isWriterLive: (writerId) => {
            if (!agentPresenceBroadcaster && !sessionManager) {
              getLogger('server-factory').debug(
                { writerId },
                '[server-factory] isWriterLive called before liveness deps populated — treating writer as dead',
              );
              return false;
            }
            if (agentPresenceBroadcaster?.getPresenceMap()[writerId]) return true;
            const connId = writerId.startsWith('agent-')
              ? writerId.slice('agent-'.length)
              : writerId;
            for (const _session of sessionManager?.sessionsForConnection(connId) ?? []) {
              return true;
            }
            return false;
          },
        })
      : undefined;

    let globalCopyResyncTimer: ReturnType<typeof setTimeout> | null = null;
    const persistenceOpts: PersistenceOptions = {
      contentDir,
      assertContentPath,
      projectDir,
      conflicts,
      lifecycleOf: (document, docName) => conflicts.lifecycleOf(document, docName),
      gitEnabled,
      commitDebounceMs,
      wipRef,
      shadowRef,
      ephemeral,
      contentRoot,
      derivedDocumentIndex,
      configHomedirOverride,
      getCurrentBranch: getStorageBranch,
      resolveEmbed,
      resolveSize,
      getPrincipal: () => loadedPrincipal,
      onAgentCommit: () => cc1Broadcaster?.signal('session-activity'),
      onFlushCommit: () => maintenanceCoordinator?.noteFlushCommit(),
      capturePublicationReceipt,
      onDiskFlush: (docName, sv, persistedMarkdown, previousMarkdown) => {
        cc1Broadcaster?.emitDiskAck(docName, sv);
        if (isReservedForUserTree(docName)) return;
        if (indexedFieldsChanged(previousMarkdown, persistedMarkdown, docName)) {
          scheduleIndexRegeneration(docName);
        }
        if (!assetReferencesChanged(previousMarkdown, persistedMarkdown)) return;
        invalidateReferencedAssetsCache?.();
        signalChannel('files');
      },
      onConfigRejected: (docName, error) =>
        cc1Broadcaster?.emitConfigValidationRejected(docName, error),
      onConfigPersisted: (docName) => {
        applyPersistedConfigToConsumers(docName);
        logConfigDiagnostics(docName);
      },
      onManagedSkillPersisted: (docName) => {
        const parsed = parseManagedArtifactName(docName);
        if (parsed?.kind !== 'skill' || parsed.scope !== 'global') return;
        if (globalCopyResyncTimer !== null) clearTimeout(globalCopyResyncTimer);
        globalCopyResyncTimer = setTimeout(() => {
          globalCopyResyncTimer = null;
          const home = configHomedirOverride ?? homedir();
          void scanGlobalInPlaceSkillsAsync(home)
            .then((inPlace) => resyncRecordedSkillCopies(home, home, inPlace))
            .then((n) => {
              if (n > 0) log.info({ refreshed: n }, '[in-place-skills] post-edit copy re-sync');
            })
            .catch((err) => log.warn({ err }, '[in-place-skills] post-edit copy re-sync failed'));
        }, 2000);
        globalCopyResyncTimer.unref?.();
      },
      isRecentlyRemoved: (docName) => recentlyRemovedDocs.has(docName),
      mdManager: options.mdManager,
      getLossRing: () => lossRing,
      mergeHistory,
      ingestDiskAtStore: async (docName, absPath, content) => {
        let outcome: DiskIntakeOutcome;
        try {
          outcome = await intakeDiskUpdate({ kind: 'update', path: absPath, docName, content });
        } catch (error) {
          return { kind: 'failed', error };
        }
        switch (outcome.kind) {
          case 'applied':
            return outcome.merge === undefined
              ? { kind: 'taken-in' }
              : { kind: 'taken-in', merge: outcome.merge };
          case 'nothing-to-take':
            return { kind: 'taken-in' };
          case 'conflict':
            return { kind: 'conflict' };
          case 'failed':
            return { kind: 'failed', error: outcome.error };
          default:
            return assertNeverDiskIntakeOutcome(outcome);
        }
      },
    };

    persistence = createPersistenceExtension({ ...persistenceOpts, durabilityState });
    heldSaveProbe = (docName) => persistence.hasHeldSave(docName);

    hocuspocus = new Hocuspocus({
      quiet,
      debounce,
      maxDebounce,
      extensions: [persistence.extension],
    });

    const dispatchHooks = hocuspocus.hooks.bind(hocuspocus);
    hocuspocus.hooks = (name, payload, callback) => {
      if (
        (name === 'afterLoadDocument' || name === 'onChange') &&
        'document' in payload &&
        !isReservedForUserTree(payload.document.name)
      ) {
        const document = payload.document;
        const occurrence = occurrenceFor(document);
        if (name === 'onChange' && occurrence.mutation === undefined) {
          const source = document.getText('source').toString();
          if (source !== occurrence.source) {
            occurrence.source = undefined;
            occurrence.mutation = { occurrence };
          }
        }
      }
      if (
        name === 'connected' &&
        'connection' in payload &&
        payload.connection &&
        !isReservedForUserTree(payload.documentName)
      ) {
        acceptConnectedDocument(payload.documentName, payload.connection.document);
      }
      return dispatchHooks(name, payload, callback);
    };

    const openDirect = hocuspocus.openDirectConnection.bind(hocuspocus);
    function assertDocumentProjectScope(documentName: string): void {
      if (documentAdmissionClosed) throw new ServerMutationShuttingDownError(false);
      if (isReservedForUserTree(documentName)) {
        if (
          singleDocRelPath !== undefined &&
          documentName !== SYSTEM_DOC_NAME &&
          !isConfigDoc(documentName)
        )
          throw new ContentScopeAdmissionError();
        return;
      }
      if (
        singleDocRelPath !== undefined &&
        canonicalDocName(documentName) !== canonicalDocName(stripDocExtension(singleDocRelPath))
      )
        throw new ContentScopeAdmissionError();
      if (authorityRetired) throw new ServerMutationShuttingDownError(false);
      assertCapturedServerContentPath(authorityScope, safeContentPath(documentName, contentDir));
    }

    hocuspocus.openDirectConnection = (async (documentName: string, context?: unknown) => {
      const canonicalName = canonicalDocName(documentName);
      assertDocumentProjectScope(canonicalName);
      return openDirect(canonicalName, context);
    }) as typeof hocuspocus.openDirectConnection;

    const hp = hocuspocus;
    unregisterWorkloadProviders.push(
      registerLoadedDocsProvider(() => hp.documents.size),
      registerPersistenceQueueDepthProvider(() => persistence.getQueueDepths()),
      registerConnectionCountsProvider(() => {
        let direct = 0;
        for (const doc of hp.documents.values()) {
          direct += doc.directConnectionsCount;
        }
        return { websocket: hp.getConnectionsCount() - direct, direct };
      }),
    );
    installServerWorkloadGauges();

    if (!ephemeral) {
      stalenessWatchdog = createPersistenceStalenessWatchdog({
        getLoadedDocuments: () => hp.documents,
        lifecycleOf: (document, documentName) => conflicts.lifecycleOf(document, documentName),
        forceStore: (document, documentName) => persistence.forceStore(document, documentName),
        isHeldSaveDue: (documentName) => persistence.isHeldSaveDue(documentName),
        retryHeldSave: (document, documentName) =>
          persistence.retryHeldSave(document, documentName),
        getBase: (documentName) => durabilityState.getReconciledBase(documentName),
        isBatchActive: () => durabilityState.isBatchInProgress(),
        hasInFlight: (documentName) => durabilityState.inFlightFlushCount(documentName) > 0,
        readDiskBytes: (documentName) => {
          const requestedPath = safeContentPath(documentName, contentDir);
          let canonical: string;
          let size: number;
          try {
            canonical = realpathSync(requestedPath);
            size = statSync(canonical).size;
          } catch (err) {
            const code = errnoCode(err);
            if (code === 'ENOENT') return null;
            if (code === 'ELOOP') {
              throw new StructuralDiskReadError(`symlink cycle at content path: ${documentName}`);
            }
            throw err;
          }
          if (canonicalContentPathIsRefused(requestedPath, canonical, contentDir)) {
            throw new StructuralDiskReadError(
              `symlink-escape: ${requestedPath} resolves outside the content dir or into private state`,
            );
          }
          if (size > DOCUMENT_OPEN_BYTE_LIMIT) {
            throw new StructuralDiskReadError(
              `document exceeds the open byte limit: ${documentName}`,
            );
          }
          try {
            return readFileSync(canonical, 'utf-8');
          } catch (err) {
            if (errnoCode(err) === 'ENOENT') return null;
            throw err;
          }
        },
        graceMs: options.stalenessGraceMs,
        sweepIntervalMs: options.stalenessSweepIntervalMs,
      });
    }

    defaultShouldUnloadDocument = hocuspocus.shouldUnloadDocument.bind(hocuspocus);
    hocuspocus.shouldUnloadDocument = (document) => {
      const requests = forceUnloadRequests.get(document);
      if (requests) return [...requests].some((isCurrent) => isCurrent());
      if (
        shutdownAllowsUnload &&
        !isReservedForUserTree(document.name) &&
        durabilityState.isStoreRefused(document.name)
      ) {
        return false;
      }
      if (shutdownAllowsUnload && defaultShouldUnloadDocument(document)) {
        return true;
      }
      const name = document.name;
      if (isReservedForUserTree(name)) return false;
      if (getReconciledBase(name) !== undefined) return false;
      if (document.getXmlFragment('default').length !== 0) return false;
      if (document.getText('source').length !== 0) return false;
      return defaultShouldUnloadDocument(document);
    };

    forceUnloadDocument = async (document, isCurrent): Promise<void> => {
      const request = () =>
        hocuspocus.documents.get(document.name) === document && (isCurrent?.() ?? true);
      const requests = forceUnloadRequests.get(document) ?? new Set<() => boolean>();
      requests.add(request);
      forceUnloadRequests.set(document, requests);
      try {
        await hocuspocus.unloadDocument(document);
      } finally {
        requests.delete(request);
        if (requests.size === 0) forceUnloadRequests.delete(document);
      }
    };

    cc1Broadcaster = new CC1Broadcaster(hocuspocus);
    agentFocusBroadcaster = new AgentFocusBroadcaster(hocuspocus);
    agentPresenceBroadcaster = new AgentPresenceBroadcaster(hocuspocus);

    sessionManager = new AgentSessionManager(hocuspocus, {
      ...options.agentSessionOptions,
      assertDocumentScope: assertDocumentProjectScope,
      awaitWriteAdmission: () => durabilityState.whenWriteAdmitted(),
    });
    const sm = sessionManager;
    unregisterWorkloadProviders.push(
      registerAgentSessionCountsProvider(() => ({
        active: sm.liveSessionCount,
        limit: sm.sessionLimit,
      })),
    );
    const liveDerivedIndexExtension = createLiveDerivedIndexExtension({
      derivedDocumentIndex,
      onDocumentSettled: (docName) => commentDocHooksRef.current?.changed(docName),
    });
    hocuspocus.configuration.extensions.push(liveDerivedIndexExtension);

    type AuthRejectionLogReason = HocuspocusAuthRejectionReason | 'config-doc-admission-denied';
    function logAuthRejection(
      reason: AuthRejectionLogReason,
      documentName: string | undefined,
      detail: Record<string, unknown> = {},
    ): void {
      log.warn({ reason, docName: documentName, ...detail }, `[auth-rejection] ${reason}`);
    }

    const principalAuthExtension: Extension & { __kind: 'principal-auth' } = {
      __kind: 'principal-auth',
      async beforeHandleMessage(payload) {
        assertDocumentProjectScope(payload.documentName);
      },
      async onAuthenticate(payload) {
        assertDocumentProjectScope(payload.documentName);
        const tokenStr = payload.token;
        const parsed = parseHocuspocusAuthToken(tokenStr);

        const claimed = parsed?.expectedServerInstanceId;
        if (typeof claimed === 'string' && claimed.length > 0 && claimed !== serverInstanceId) {
          logAuthRejection('server-instance-mismatch', payload.documentName, {
            claimedServerInstanceId: claimed,
            currentServerInstanceId: serverInstanceId,
          });
          throw new HocuspocusAuthRejection(
            'server-instance-mismatch',
            `server instance mismatch: client claimed ${claimed}, this server is ${serverInstanceId}`,
          );
        }

        const claimedBranch = parsed?.expectedBranch;
        if (typeof claimedBranch === 'string' && claimedBranch.length > 0) {
          const currentBranch = await resolveBranchForClaimCheck();
          if (currentBranch !== null && claimedBranch !== currentBranch) {
            logAuthRejection('branch-mismatch', payload.documentName, {
              claimedBranch,
              currentBranch,
            });
            throw new HocuspocusAuthRejection(
              'branch-mismatch',
              `branch mismatch: client claimed ${claimedBranch}, server is on ${currentBranch}`,
            );
          }
        }

        if (!parsed) return;
        const ctx = payload.context as Record<string, unknown>;
        if (typeof parsed.principalId === 'string') {
          if (loadedPrincipal && parsed.principalId === loadedPrincipal.id) {
            ctx.principalId = loadedPrincipal.id;
          } else if (loadedPrincipal) {
            console.warn(
              JSON.stringify({
                event: 'principal-token-mismatch',
                claimed: parsed.principalId,
                loaded: loadedPrincipal.id,
              }),
            );
          } else {
            ctx.principalId = parsed.principalId;
          }
        }
        if (typeof parsed.tabSessionId === 'string') {
          ctx.tabSessionId = parsed.tabSessionId;
        }
        ctx.kind = 'human';
      },
    };
    hocuspocus.configuration.extensions.push(principalAuthExtension);

    const configDocAdmissionGuard: Extension & { __kind: 'config-doc-admission-guard' } = {
      __kind: 'config-doc-admission-guard',
      async onAuthenticate(payload) {
        if (!isConfigDoc(payload.documentName) && !isManagedArtifactDoc(payload.documentName)) {
          return;
        }
        const req = payload.request as unknown as {
          socket?: { remoteAddress?: string };
          headers?: { host?: string };
        };
        const peer = req.socket?.remoteAddress;
        if (peer !== undefined && !isPeerAdmitted(peer, ingressPolicy)) {
          logAuthRejection('config-doc-admission-denied', payload.documentName, { check: 'peer' });
          throw new Error(
            `config-doc admission requires loopback peer (peer=${peer}, doc=${payload.documentName})`,
          );
        }
        const headersBag = (payload as { requestHeaders?: Headers }).requestHeaders;
        const host =
          (headersBag && typeof headersBag.get === 'function' ? headersBag.get('host') : null) ??
          req.headers?.host ??
          undefined;
        if (!isHostAdmitted(host, ingressPolicy)) {
          logAuthRejection('config-doc-admission-denied', payload.documentName, { check: 'host' });
          throw new Error(
            `config-doc admission requires a loopback or remote Host header (host=${host ?? '<absent>'}, doc=${payload.documentName})`,
          );
        }
      },
    };
    hocuspocus.configuration.extensions.push(configDocAdmissionGuard);

    const removalRedirectGuard: Extension & { __kind: 'removal-redirect-guard' } = {
      __kind: 'removal-redirect-guard',
      async onAuthenticate(payload) {
        if (!isReservedForUserTree(payload.documentName)) {
          const path = resolveDocFilePath(payload.documentName);
          if (path !== null && !existsSync(path)) {
            try {
              await Promise.race([offlineRemovalsReconciled.promise, ready]);
            } catch (err) {
              log.error(
                { err, docName: payload.documentName },
                '[removal-guard] missing-document admission refused after startup failure',
              );
              throw err;
            }
          }
        }
        await runRemovalRedirectGuard(payload.documentName, {
          recentlyRemovedDocs,
          resolveFilePath: resolveDocFilePath,
          fileExists: existsSync,
        });
      },
    };
    hocuspocus.configuration.extensions.push(removalRedirectGuard);

    const docLineageGuard: Extension & { __kind: 'doc-lineage-guard' } = {
      __kind: 'doc-lineage-guard',
      async onAuthenticate(payload) {
        const parsed = parseHocuspocusAuthToken(payload.token);
        runDocLineageGuard(payload.documentName, parsed?.expectedDocLineageEpoch, {
          getLoadedDoc: (name) => hocuspocus.documents.get(name),
        });
      },
    };
    hocuspocus.configuration.extensions.push(docLineageGuard);

    const systemDocBroadcastGuard: Extension & { __kind: 'system-doc-broadcast-guard' } = {
      __kind: 'system-doc-broadcast-guard',
      async beforeHandleMessage(payload) {
        if (payload.documentName !== SYSTEM_DOC_NAME) return;
        const message = new IncomingMessage(payload.update);
        message.readVarString();
        const type = message.readVarUint();
        if (type === MessageType.BroadcastStateless) {
          throw new Error(
            `inbound BroadcastStateless on ${SYSTEM_DOC_NAME} rejected — server-only channel`,
          );
        }
      },
    };
    hocuspocus.configuration.extensions.push(systemDocBroadcastGuard);

    const renameCarryRetirement: Extension = {
      async afterUnloadDocument({ documentName }) {
        durabilityState.endRenameCarry(documentName);
      },
    };
    hocuspocus.configuration.extensions.push(renameCarryRetirement);

    const apiExtension = createApiExtension({
      mergeHistoryWriter: options.mergeHistoryWriter,
      docNotices,
      declaredGitHubHosts,
      resolveSyncCredentialConfig,
      hocuspocus,
      durabilityState,
      ingressPolicy,
      sessionManager,
      commentDocHooksRef,
      onNamespaceCreateAccepted: acceptNamespaceCreate,
      capturePublicationReceipt,
      captureNamespaceMove,
      onResidentAdopted: acceptResident,
      contentDir,
      assertContentPath,
      assertContentSubtree,
      getGeneratedIndexSettingsStatus,
      setGeneratedIndexEnabled,
      contentFilter,
      serverInstanceId,
      getFileIndex: () => (watcher ? watcher.getFileIndex() : new Map()),
      getAttachmentFolderPath: readProjectAttachmentFolderPath,
      getAllFilesIndex: () => (watcher ? watcher.getAllFilesIndex() : new Map()),
      getFileIndexGeneration: () => watcher?.getFileIndexGeneration() ?? 0,
      mutateFileIndex: (event) => {
        const previousIndexedFields =
          event.kind === 'update' ? currentIndexedFields(event.docName) : undefined;
        watcher?.mutateFileIndex(event);
        switch (event.kind) {
          case 'update':
            if (indexedMetadataChanged(previousIndexedFields, event.content, event.docName)) {
              scheduleIndexRegeneration(event.docName);
            }
            break;
          case 'create':
            reviveFrozenResident(event.docName, event.content);
            scheduleIndexRegeneration(event.docName);
            break;
          case 'conflict':
            scheduleIndexRegeneration(event.docName);
            break;
          case 'delete':
            commentDocHooksRef.current?.deleted(event.docName);
            scheduleIndexRegenerationAfterRemoval(event.docName);
            break;
          case 'rename':
            scheduleIndexRegenerationAfterRemoval(event.oldDocName);
            scheduleIndexRegeneration(event.newDocName);
            break;
          case 'folder-create':
          case 'folder-delete':
            scheduleSubdirectoryIndexRegeneration(event.relativePath);
            break;
          case 'asset-create':
          case 'asset-delete':
          case 'file-create':
          case 'file-update':
          case 'file-delete':
            break;
          default:
            assertNeverDiskEvent(event);
        }
      },
      getFolderIndex: () => (watcher ? watcher.getFolderIndex() : new Map()),
      getAliasMap: () => (watcher ? watcher.getAliasMap() : new Map()),
      getFolderAliasIndex: () => (watcher ? watcher.getFolderAliasIndex() : new Map()),
      resolveTrackedFile,
      rescanFiles: () => watcher?.rescanFromDisk(),
      settleDiskEventsForTest: async () => {
        await watcher?.settle();
      },
      enableTestRoutes,
      shadowRef,
      flushGitCommit: () => persistence.flushPendingGitCommit(),
      flushContributors: () => persistence.flushContributors(),
      getCurrentBranch: getStorageBranch,
      getReportedBranch,
      getDiskAckSVs: () => cc1Broadcaster?.getLatestDiskAckSVsAsBase64() ?? {},
      getCollabClientCount: options.getCollabClientCount,
      contentRoot,
      derivedDocumentIndex,
      signalChannel,
      agentFocusBroadcaster,
      agentPresenceBroadcaster,
      onAgentWrite: options.onAgentWrite,
      getSyncEngine: () => syncEngine,
      conflicts,
      setBatchInProgress: batchFlagFor('conflict-resolve'),
      refreshDocumentsFromDisk,
      localOpCliArgs,
      authStreamHeartbeatMs,
      projectDir,
      resolveEmbed,
      getBridgeLossReporter: () => bridgeLossReporter,
      getPrincipal: () => loadedPrincipal,
      agentIntegrations: options.agentIntegrations,
      acpRegistry,
      loadAcpCustomAgents: () => loadCustomAgents(lockDir, getLogger('acp-registry')),
      homeDirOverride: configHomedirOverride,
      resetSettingsForTest:
        configHomedirOverride === undefined
          ? undefined
          : () => {
              for (const configDocName of CONFIG_DOC_NAMES) {
                resetConfigDocForTest(
                  hocuspocus.documents.get(configDocName) ?? null,
                  configDocName,
                  persistence.configPersistenceCtx,
                );
                configFileWatcherResyncs.get(configDocName)?.();
                applyPersistedConfigToConsumers(configDocName);
              }
            },
      forceUnloadDocument,
      ready,
      recentlyRemovedDocs,
      serializeDoc,
      evictManagedArtifactLkg: (docName: string) => {
        persistence.managedArtifactCtx.lkgCache.delete(docName);
      },
      semanticSearch,
      getSemanticSimilarityFloor: () => readSemanticSearchConfig().similarityFloor,
      getLinterBaseConfig: () => readLinterBaseConfig(),
      getLinkAdvisoryPolicy: readLinkAdvisoryPolicy,
      getProjectConfigEpoch: () => projectConfigEpoch,
      getLinkPreviewsEnabled: readLinkPreviewsEnabled,
      resolveGitHubToken: createGitHubTokenResolver(options.detectGh, options.tokenStore),
      getConfigDiagnostics: readConfigDiagnostics,
      embeddingsSecretsFile: secretsFilePath(configHomedirOverride),
      readSemanticProviderConfig: readSemanticSearchConfig,
      ephemeral,
      onReferencedAssetsCacheInvalidator: (invalidate) => {
        invalidateReferencedAssetsCache = invalidate;
      },
    });
    hocuspocus.configuration.extensions.push(apiExtension);
    hocuspocus.configuration.extensions.push(
      createReconnectRefreshExtension({
        clock: options.watcherClock ?? watcherClock(),
        refresh: refreshDocumentsFromDisk,
      }),
    );
    nativeApi = apiExtension.nativeApi;
    localApi = apiExtension.localApi;
    shutdownLocalOps = apiExtension.shutdownLocalOps;

    const bridgeGuardConfig = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) =>
        log.warn({ message }, '[config] could not read project config for bridge guards'),
    });
    const deferGuardEnabled = bridgeGuardConfig.value.bridge.deferGuard.enabled;
    const fixedPointBackstopEnabled = bridgeGuardConfig.value.bridge.fixedPoint.enabled;
    const preDrainEnabled = bridgeGuardConfig.value.bridge.preDrain.enabled;
    lossRing = bridgeGuardConfig.value.lossCapture.enabled
      ? new LossCaptureRing({
          projectDir,
          maxBytes: bridgeGuardConfig.value.lossCapture.maxBytes,
        })
      : undefined;

    if (bridgeGuardConfig.value.bridge.lossDetector.enabled) {
      bridgeLossReporter = createBridgeDeriveLossReporter({
        shadow: () => shadowRef.current,
        ring: lossRing,
        getBranch: () => getStorageBranch() ?? 'main',
        contentRoot: contentRoot ?? '',
      });
      sessionManager.attachBridgeLossReporter(bridgeLossReporter);
    }

    hocuspocus.configuration.extensions.push(
      createServerObserverExtension({
        mdManager,
        schema,
        shadowRef,
        contentRoot,
        getCurrentBranch: getStorageBranch,
        resolveEmbed,
        resolveSize,
        deferGuardEnabled,
        lossDetectorEnabled: bridgeGuardConfig.value.bridge.lossDetector.enabled,
        fixedPointBackstopEnabled,
        preDrainEnabled,
        lossRing,
      }),
    );

    hocuspocus.configuration.extensions.push(createSyncHandshakeSpanExtension());

    hocuspocus.configuration.extensions.push({
      async afterLoadDocument({ document }) {
        bindConflictAuthority(document, conflicts);
      },
    });
  } catch (err) {
    for (const unregister of unregisterWorkloadProviders.splice(0)) {
      unregister();
    }
    void stalenessWatchdog?.dispose();
    stalenessWatchdog = null;
    authorityRetired = true;
    releaseServerLock(lockDir);
    try {
      authority.release();
    } catch (cleanupError) {
      log.error({ err: cleanupError }, '[server] construction authority release failed');
    }
    throw err;
  }

  let systemDocConnection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>> | null = null;
  const configDocConnections = new Map<
    string,
    Awaited<ReturnType<Hocuspocus['openDirectConnection']>>
  >();

  const configFileWatcherCleanups: Array<{
    docName: string;
    cleanup: ConfigFileWatcherUnsubscribe;
  }> = [];
  const configFileWatcherResyncs = new Map<ConfigDocName, () => void>();

  function safeRescuePath(shadowGitDir: string, docName: string): string | null {
    const rescueBase = resolve(shadowGitDir, 'rescue');
    const relativePath = docNameToRelativePath(docName);
    const filePath = resolve(rescueBase, relativePath);
    if (!isWithinDir(filePath, rescueBase)) return null;
    return filePath;
  }

  function serializeDoc(docName: string): string | null {
    const document = hocuspocus.documents.get(docName);
    if (!document) return null;
    return serializeYDocSource(document);
  }

  const applyToDoc = (docName: string, content: string): void => {
    const document = hocuspocus.documents.get(docName);
    applyExternalChange(
      durabilityState,
      hocuspocus,
      docName,
      content,
      resolveEmbed,
      resolveSize,
      bridgeLossReporter,
    );
    if (document && hasAdmittedMarkdownBinding(docName)) acceptResident(document, docName);
  };

  const reviveFrozenResident = (docName: string, content: string): FrozenResidentRevival => {
    const result = reviveFrozenResidentDoc(
      durabilityState,
      hocuspocus,
      docName,
      content,
      resolveEmbed,
      resolveSize,
      bridgeLossReporter,
    );
    const document = hocuspocus.documents.get(docName);
    if (result === 'revived' && document && hasAdmittedMarkdownBinding(docName)) {
      acceptResident(document, docName);
    }
    return result;
  };

  const refreshLoadedEmbeds = (
    needle: string,
    context: { reason: 'startup' } | { reason: 'asset-event'; assetBasename: string },
  ): number => {
    let refreshed = 0;
    for (const [docName] of hocuspocus.documents) {
      if (isReservedForUserTree(docName)) continue;
      const document = hocuspocus.documents.get(docName);
      if (!document) continue;
      const source = document.getText('source').toString();
      if (!source.includes(needle)) continue;
      try {
        document.transact(() => {
          applyDiskContentToDoc(document, source, resolveEmbed, docName);
        }, FILE_WATCHER_ORIGIN);
        refreshed++;
      } catch (err) {
        log.error(
          { originalError: redactedErrorSummary(err), docName, ...context },
          context.reason === 'asset-event'
            ? `[asset-event] failed to re-render ${docName} for asset basename ${context.assetBasename}`
            : `[basename-index] failed to refresh loaded startup embeds in ${docName}`,
        );
      }
    }
    return refreshed;
  };

  const rerenderDocsReferencingAssetBasename = (assetBasename: string): void => {
    if (!assetBasename) return;
    refreshLoadedEmbeds(`[[${assetBasename}]]`, { reason: 'asset-event', assetBasename });
  };

  const refreshStartupEmbeds = (): void => {
    try {
      const documentCount = refreshLoadedEmbeds('![[', { reason: 'startup' });
      log.debug({ documentCount }, '[basename-index] refreshed loaded startup embeds');
    } catch (err) {
      log.warn({ err }, '[basename-index] loaded startup embed refresh failed');
    }
  };

  let pendingAssetRerenderBasenames: Set<string> | null = null;
  const scheduleAssetRerender = (assetBasename: string): void => {
    if (!assetBasename) return;
    if (pendingAssetRerenderBasenames === null) {
      pendingAssetRerenderBasenames = new Set();
      setImmediate(() => {
        const toRender = pendingAssetRerenderBasenames;
        pendingAssetRerenderBasenames = null;
        if (!toRender) return;
        try {
          for (const b of toRender) rerenderDocsReferencingAssetBasename(b);
        } catch (err) {
          log.error({ err, basenames: [...toRender] }, '[asset-event] dedup rerender pass crashed');
        }
      });
    }
    pendingAssetRerenderBasenames.add(assetBasename);
  };

  function diskEventLabel(event: DiskEvent): string {
    switch (event.kind) {
      case 'rename':
        return event.newDocName;
      case 'asset-create':
      case 'asset-delete':
      case 'folder-create':
      case 'folder-delete':
      case 'file-create':
      case 'file-update':
      case 'file-delete':
        return event.relativePath;
      case 'create':
      case 'update':
      case 'delete':
      case 'conflict':
        return event.docName;
      default:
        return assertNeverDiskEvent(event);
    }
  }

  const CHECKPOINT_KIND_BY_MINT_SITE = {
    delete: 'external-change-rescue',
    rename: 'external-change-rescue',
    'branch-switch': 'external-change-rescue',
    'disk-update': 'external-change-rescue-disk-update',
  } as const satisfies Record<
    'delete' | 'rename' | 'branch-switch' | 'disk-update',
    CheckpointKind
  >;

  /* WARN: mint-site → checkpoint-kind → GC bucket coupling; the per-kind retention budgets and
   * the external-change-rescue split are recorded in packages/core/src/bridge/README.md
   * (external-change-rescue exception paragraph). */
  const mintExternalChangeRescue = (
    docName: string,
    ours: string,
    branch: string,
    site: keyof typeof CHECKPOINT_KIND_BY_MINT_SITE,
    incomingDiskSha = '',
    followedByContentLoss = false,
  ): boolean => {
    if (!shadowRef.current) {
      const consequence = !followedByContentLoss
        ? ''
        : site === 'delete'
          ? ' — the delete that follows destroys the document content'
          : ' — the overwrite that follows replaces the document content';
      log.warn(
        { docName, site },
        `[reconcile] rescue checkpoint not minted for ${docName} (${site}) — shadow repo unavailable${consequence}`,
      );
      incrementRescueBufferWriteFailures();
      return false;
    }
    const shadowForCheckpoint = shadowRef.current;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadowForCheckpoint, contentRoot ?? '', {
        kind: CHECKPOINT_KIND_BY_MINT_SITE[site],
        docName,
        contents: ours,
        label: `External change recovered @ ${new Date().toISOString()}`,
        branch,
        metadata: { incomingDiskSha },
      })
        .then(() => {
          incrementRescueBuffer();
          log.info({ docName, site }, `[reconcile] rescue checkpoint saved (${site}): ${docName}`);
        })
        .catch((e: unknown) => {
          incrementRescueCheckpointWriteFailures();
          const consequence = !followedByContentLoss
            ? ''
            : site === 'delete'
              ? ' — the delete that follows destroys the document content'
              : ' — the overwrite that follows replaces the document content';
          log.error(
            { docName, site, err: e },
            `[reconcile] rescue checkpoint write failed (${site}): ${docName}${consequence}`,
          );
        });
    });
    return true;
  };

  const settledVanishEvents = new WeakSet<DiskEvent>();
  const vanishClock = options.watcherClock ?? watcherClock();
  let vanishRecheckTimer: WatcherTimer | null = null;
  let vanishRecheckRunning = false;

  const holdVanished = (entry: VanishedDocument): void => {
    vanishedDocuments.hold(entry);
    durabilityState.holdStores(entry.docName);
  };

  const reportedUnreadableReturns = new Set<string>();
  const overdueFaults = new Map<string, number>();

  const releaseVanished = (docName: string): void => {
    vanishedDocuments.release(docName);
    overdueFaults.delete(docName);
    reportedUnreadableReturns.delete(docName);
    durabilityState.releaseStores(docName);
  };

  let branchSwitchFollowUpTimer: WatcherTimer | null = null;
  let branchSwitchFollowUpGeneration = 0;

  function supersedeBranchSwitchFollowUps(): void {
    branchSwitchFollowUpGeneration += 1;
    vanishClock.clearTimeout(branchSwitchFollowUpTimer);
    branchSwitchFollowUpTimer = null;
  }

  function followUpBranchSwitchRecheck(branch: string): void {
    supersedeBranchSwitchFollowUps();
    void runBranchSwitchFollowUp(branch, branchSwitchFollowUpGeneration, 1).catch(
      (err: unknown) => {
        log.error({ err, branch }, '[branch-switch] the follow-up re-checks stopped');
      },
    );
  }

  async function runBranchSwitchFollowUp(
    branch: string,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (!watcher || generation !== branchSwitchFollowUpGeneration) return;
    let result: RecheckResult | undefined;
    try {
      result = await watcher.recheck('full');
    } catch (err) {
      log.warn(
        { err, branch, attempt },
        `[branch-switch] follow-up re-check ${attempt} after switching to ${branch} failed`,
      );
    }
    if (generation !== branchSwitchFollowUpGeneration || result?.status === 'closed') return;
    if (result?.status === 'completed' && !result.partial) {
      log.info(
        { branch, attempt },
        `[branch-switch] follow-up re-check ${attempt} observed the whole tree after switching to ${branch}`,
      );
      return;
    }
    incrementBranchSwitchRecheckShortfalls();
    const details = {
      branch,
      attempt,
      status: result?.status ?? 'failed',
      partial: result?.partial === true,
    };
    if (attempt >= BRANCH_SWITCH_FOLLOW_UP_LIMIT) {
      log.warn(
        details,
        `[branch-switch] ${attempt} follow-up re-checks after switching to ${branch} did not observe the whole tree; open documents may keep text from the previous branch until a later re-check observes it`,
      );
      return;
    }
    log.warn(
      details,
      `[branch-switch] follow-up re-check ${attempt} after switching to ${branch} did not observe the whole tree; trying again in ${BRANCH_SWITCH_FOLLOW_UP_DELAY_MS / 1000} s`,
    );
    branchSwitchFollowUpTimer = vanishClock.setTimeout(() => {
      branchSwitchFollowUpTimer = null;
      void runBranchSwitchFollowUp(branch, generation, attempt + 1).catch((err: unknown) => {
        log.error({ err, branch }, '[branch-switch] the follow-up re-checks stopped');
      });
    }, BRANCH_SWITCH_FOLLOW_UP_DELAY_MS);
    branchSwitchFollowUpTimer.unref();
  }

  const scheduleVanishRecheck = (): void => {
    if (vanishRecheckTimer || vanishRecheckRunning || vanishedDocuments.size === 0) return;
    vanishRecheckTimer = vanishClock.setTimeout(() => {
      vanishRecheckTimer = null;
      void runVanishRecheck().catch((err: unknown) => {
        log.error({ err }, '[reconcile] the re-check loop for vanished documents failed');
      });
    }, VANISH_RECHECK_DELAY_MS);
    vanishRecheckTimer.unref();
  };

  async function runVanishRecheck(): Promise<void> {
    if (!watcher) return;
    vanishRecheckRunning = true;
    let result: RecheckResult | undefined;
    try {
      result = await watcher.recheck('metadata');
    } catch (err) {
      log.warn({ err }, '[reconcile] the re-check for vanished documents failed');
    } finally {
      vanishRecheckRunning = false;
    }
    try {
      if (vanishedDocuments.size > 0 && (result?.status !== 'completed' || result.partial)) {
        log.info(
          { status: result?.status ?? 'failed', partial: result?.partial === true },
          `[reconcile] the re-check for ${vanishedDocuments.size} vanished document(s) did not observe the whole tree; trying again`,
        );
      }
      await resolveOverdueVanishedDocuments();
    } finally {
      scheduleVanishRecheck();
    }
  }

  function pathIsOccupied(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      log.warn({ err, path }, '[reconcile] could not tell whether a vanished file is gone');
      return true;
    }
  }

  type MarkdownFileProbe =
    | { readonly kind: 'present'; readonly path: string; readonly content: string }
    | { readonly kind: 'absent' }
    | { readonly kind: 'refused' }
    | { readonly kind: 'unreadable'; readonly code: string };

  function probeMarkdownFile(docName: string, path: string): MarkdownFileProbe {
    const unreadable = (err: unknown): MarkdownFileProbe => {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
      return { kind: 'unreadable', code: code ?? 'unknown' };
    };
    try {
      lstatSync(path);
      accessSync(path, fsConstants.R_OK);
    } catch (err) {
      const probe = unreadable(err);
      if (probe.kind === 'absent' || errnoCode(err) !== 'ELOOP') return probe;
    }
    if (!hasAdmittedMarkdownFile(docName, path, contentDir, contentFilter))
      return { kind: 'refused' };
    try {
      return { kind: 'present', path, content: readFileSync(path, 'utf-8') };
    } catch (err) {
      return unreadable(err);
    }
  }

  function probeVanishedFile(entry: VanishedDocument): MarkdownFileProbe {
    const path =
      watcher?.getFileIndex().get(entry.docName)?.canonicalPath ??
      resolveDocFilePath(entry.docName) ??
      entry.path;
    return probeMarkdownFile(entry.docName, path);
  }

  async function holdVanishedDocument(
    event: Extract<DiskEvent, { kind: 'delete' }>,
  ): Promise<boolean> {
    if (!watcher || pathIsOccupied(event.path)) return false;
    const facts = getMarkdownEventFacts(event);
    const base = getReconciledBase(event.docName);
    const hashes = new Set<string>();
    if (facts.lastHash !== undefined) hashes.add(facts.lastHash);
    if (base !== undefined) hashes.add(contentHash(base));
    const vanished = {
      docName: event.docName,
      path: event.path,
      identity: facts.identity,
      size: facts.size,
      modified: facts.modified,
      hashes,
      text: base ?? serializeDoc(event.docName) ?? undefined,
    };
    const readRecentCreate = (create: RecentCreate): string | undefined => {
      const probe = probeMarkdownFile(create.docName, create.path);
      return probe.kind === 'present' ? probe.content : undefined;
    };
    const recent = vanishedDocuments.matchRecentCreate(
      vanished,
      vanishClock.now(),
      readRecentCreate,
    );
    if (recent) {
      const probe = probeMarkdownFile(recent.create.docName, recent.create.path);
      if (probe.kind === 'present') {
        recordVanishOutcome(recent.by === 'identity' ? 'paired-identity' : 'paired-hash');
        await handleDiskEvent({
          kind: 'rename',
          oldPath: event.path,
          newPath: recent.create.path,
          oldDocName: event.docName,
          newDocName: recent.create.docName,
          content: probe.content,
        });
        return true;
      }
      log.info(
        { docName: event.docName, create: recent.create.docName, probe: probe.kind },
        `[reconcile] ${event.docName}: a recent create could not be read; holding the document instead`,
      );
    }
    holdVanished({
      ...vanished,
      afterPass: watcher.recoveryPassesStarted(),
      heldAt: vanishClock.now(),
    });
    recordVanishOutcome('pending');
    log.info(
      { docName: event.docName },
      `[reconcile] ${event.docName}: its file vanished; it stays open until a re-check of the whole tree, in case it was moved`,
    );
    scheduleVanishRecheck();
    return true;
  }

  const flushReleasedStores = (): void => {
    if (isBatchInProgress()) return;
    void persistence.flushDeferredStores('within-branch').catch((err: unknown) => {
      log.error(
        { err },
        '[persistence] deferred store drain failed after a vanished file resolved',
      );
    });
  };

  async function takeReturnedFile(
    entry: VanishedDocument,
    probe: Extract<MarkdownFileProbe, { kind: 'present' }>,
  ): Promise<void> {
    releaseVanished(entry.docName);
    try {
      recordVanishOutcome('recreated');
      log.info(
        { docName: entry.docName },
        `[reconcile] ${entry.docName}: its file is back; taking it in as an update`,
      );
      await onDiskEvent({
        kind: 'update',
        path: probe.path,
        docName: entry.docName,
        content: probe.content,
      });
    } finally {
      flushReleasedStores();
    }
  }

  async function standVanishedDelete(
    entry: VanishedDocument,
    outcome: 'deleted' | 'unconfirmed',
  ): Promise<void> {
    persistence.discardDeferredStore(entry.docName, { kind: 'deleted-outside' });
    releaseVanished(entry.docName);
    recordVanishOutcome(outcome);
    const deleteEvent: DiskEvent = { kind: 'delete', path: entry.path, docName: entry.docName };
    settledVanishEvents.add(deleteEvent);
    await onDiskEvent(deleteEvent);
  }

  function keepUnreadableHeld(entry: VanishedDocument, code: string): void {
    if (reportedUnreadableReturns.has(entry.docName)) return;
    reportedUnreadableReturns.add(entry.docName);
    log.warn(
      { docName: entry.docName, code },
      `[reconcile] ${entry.docName}: a file is at its path but cannot be read (${code}); it stays held until it can be read or the hold limit passes`,
    );
  }

  interface VanishStep {
    action: string;
  }

  function reportVanishFault(
    entry: VanishedDocument,
    step: VanishStep,
    err: unknown,
    overdueAttempt?: number,
  ): void {
    const stillHeld = vanishedDocuments.has(entry.docName);
    const attempt =
      overdueAttempt === undefined
        ? ''
        : ` (attempt ${overdueAttempt} of ${VANISH_OVERDUE_FAULT_LIMIT} past the hold limit)`;
    log.error(
      { err, docName: entry.docName, action: step.action, stillHeld, overdueAttempt },
      stillHeld
        ? `[reconcile] ${entry.docName}: ${step.action} failed with an internal error${attempt}; it is still held`
        : `[reconcile] ${entry.docName}: ${step.action} failed with an internal error${attempt}; its hold had already ended`,
    );
  }

  function endHoldAfterOverdueFaults(entry: VanishedDocument, attempts: number): void {
    releaseVanished(entry.docName);
    flushReleasedStores();
    log.error(
      { docName: entry.docName, attempts },
      `[reconcile] ${entry.docName}: ended its hold after ${attempts} failed attempts past the hold limit; its deferred saves were released to run as normal saves`,
    );
  }

  async function settleVanishedDocuments(pass: number, whole: boolean): Promise<void> {
    if (!whole) return;
    for (const entry of vanishedDocuments.dueAfter(pass)) {
      const step: VanishStep = { action: 'checking its path' };
      try {
        await settleVanishedDocument(entry, step);
      } catch (err) {
        reportVanishFault(entry, step, err);
      }
    }
  }

  async function settleVanishedDocument(entry: VanishedDocument, step: VanishStep): Promise<void> {
    const probe = probeVanishedFile(entry);
    switch (probe.kind) {
      case 'present':
        step.action = 'taking its returned file in';
        await takeReturnedFile(entry, probe);
        return;
      case 'unreadable':
        keepUnreadableHeld(entry, probe.code);
        return;
      case 'absent':
      case 'refused':
        step.action = 'applying the delete';
        log.info(
          { docName: entry.docName, probe: probe.kind },
          `[reconcile] ${entry.docName}: no move found after a re-check of the whole tree; the delete stands`,
        );
        await standVanishedDelete(entry, 'deleted');
        return;
      default: {
        const unhandled: never = probe;
        throw new Error(`unhandled file probe: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  async function resolveOverdueVanishedDocuments(): Promise<void> {
    for (const entry of vanishedDocuments.heldBefore(vanishClock.now() - VANISH_HOLD_LIMIT_MS)) {
      const step: VanishStep = { action: 'resolving its hold at the limit' };
      try {
        await resolveOverdueVanishedDocument(entry, step);
      } catch (err) {
        if (!vanishedDocuments.has(entry.docName)) {
          reportVanishFault(entry, step, err);
          continue;
        }
        const attempts = (overdueFaults.get(entry.docName) ?? 0) + 1;
        overdueFaults.set(entry.docName, attempts);
        reportVanishFault(entry, step, err, attempts);
        if (attempts >= VANISH_OVERDUE_FAULT_LIMIT) endHoldAfterOverdueFaults(entry, attempts);
      }
    }
  }

  async function resolveOverdueVanishedDocument(
    entry: VanishedDocument,
    step: VanishStep,
  ): Promise<void> {
    const limit = `${VANISH_HOLD_LIMIT_MS / 1000} s`;
    let probe: MarkdownFileProbe | undefined;
    try {
      probe = probeVanishedFile(entry);
    } catch (err) {
      log.error(
        { err, docName: entry.docName, limitMs: VANISH_HOLD_LIMIT_MS },
        `[reconcile] ${entry.docName}: checking its path at the hold limit failed with an internal error; the delete stands as at any hold limit`,
      );
    }
    switch (probe?.kind) {
      case undefined:
        break;
      case 'present':
        step.action = 'taking its returned file in';
        await takeReturnedFile(entry, probe);
        return;
      case 'absent':
        log.warn(
          { docName: entry.docName, probe: probe.kind, limitMs: VANISH_HOLD_LIMIT_MS },
          `[reconcile] ${entry.docName}: its file is gone and no re-check observed the whole tree within ${limit}; the delete stands and unsaved typing is in its history`,
        );
        break;
      case 'unreadable':
        log.warn(
          {
            docName: entry.docName,
            probe: probe.kind,
            code: probe.code,
            limitMs: VANISH_HOLD_LIMIT_MS,
          },
          `[reconcile] ${entry.docName}: a file at its path still cannot be read (${probe.code}) after ${limit}; the hold ends, the document closes and unsaved typing is in its history`,
        );
        break;
      case 'refused':
        log.warn(
          { docName: entry.docName, probe: probe.kind, limitMs: VANISH_HOLD_LIMIT_MS },
          `[reconcile] ${entry.docName}: the entry at its path is still not an admitted Markdown file after ${limit}; the hold ends, the document closes and unsaved typing is in its history`,
        );
        break;
      default: {
        const unhandled: never = probe;
        throw new Error(`unhandled file probe: ${JSON.stringify(unhandled)}`);
      }
    }
    step.action = 'applying the delete at the hold limit';
    await standVanishedDelete(entry, 'unconfirmed');
  }

  function followRecordsAcrossRename(
    oldDocName: string,
    newDocName: string,
    newPath: string,
  ): void {
    const branch = getStorageBranch() ?? 'main';
    const move = { from: oldDocName, to: newDocName, toFile: `${newDocName}${extname(newPath)}` };
    const writer = {
      writerId: FILE_SYSTEM_WRITER.id,
      displayName: FILE_SYSTEM_WRITER.name,
      colorSeed: FILE_SYSTEM_WRITER.id,
    };
    followRenameRecords({
      moves: [move],
      kind: 'file',
      branch,
      writer,
      shadow: undefined,
      notices: docNotices,
    });
    const shadow = shadowRef.current;
    if (!shadow) return;
    void recordOutsideRenameInHistory(shadow, branch, move, writer);
  }

  async function readWriterHeads(shadow: ShadowHandle, branch: string): Promise<string[]> {
    try {
      const raw = await shadowGit(shadow).raw(
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(objectname)',
        `refs/wip/${branch}/`,
      );
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((sha) => /^[0-9a-f]{40}$/.test(sha));
    } catch (err) {
      log.warn(
        { err, branch },
        "[reconcile] rename: could not read the writers' history heads; the move is recorded without them",
      );
      return [];
    }
  }

  async function recordOutsideRenameInHistory(
    shadow: ShadowHandle,
    branch: string,
    move: { from: string; to: string; toFile: string },
    writer: { writerId: string; displayName: string; colorSeed: string },
  ): Promise<void> {
    const anchors = await readWriterHeads(shadow, branch);
    let appended: number;
    try {
      appended = followRenameRecords({
        moves: [move],
        kind: 'file',
        branch,
        writer,
        shadow,
        notices: undefined,
        anchors,
      });
    } catch (err) {
      incrementOutsideRenameRecordFailures();
      log.warn(
        { err, oldDocName: move.from, newDocName: move.to },
        `[reconcile] rename: could not write the rename-log entry for ${move.from} -> ${move.to}; history before the move will not show under the new name`,
      );
      return;
    }
    if (appended === 0) return;
    let flushError: unknown;
    try {
      await persistence.flushContributors();
    } catch (err) {
      flushError = err;
    }
    const recorded = getOrLoadRenameLogIndex(shadow.gitDir).byTo.get(move.to);
    if (recorded !== undefined && recorded.commitSha === '') {
      incrementOutsideRenameClaimFailures();
      log.warn(
        { err: flushError, oldDocName: move.from, newDocName: move.to },
        `[reconcile] rename: wrote the rename-log entry for ${move.from} -> ${move.to}, but no commit claimed it yet; a later commit by the file-system writer claims it, and the next start drops it if none does`,
      );
      return;
    }
    if (flushError !== undefined) {
      log.warn(
        { err: flushError, oldDocName: move.from, newDocName: move.to },
        '[reconcile] rename: the commit after recording the move failed',
      );
    }
  }

  async function carryLiveTextAcrossRename(
    newDocName: string,
    newPath: string,
    base: string,
    live: string,
    diskContent: string,
  ): Promise<boolean> {
    let connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>> | undefined;
    try {
      connection = await hocuspocus.openDirectConnection(newDocName);
      applyToDoc(newDocName, live);
      setReconciledBase(newDocName, base);
      if (diskContent !== base) {
        await handleDiskEvent({
          kind: 'update',
          path: newPath,
          docName: newDocName,
          content: diskContent,
        });
      }
      log.info({ newDocName }, `[reconcile] rename: unsaved typing carried into ${newDocName}`);
      return true;
    } catch (err) {
      log.error(
        { err, newDocName },
        `[reconcile] rename: could not carry unsaved typing into ${newDocName}; it is in the rename checkpoint`,
      );
      return false;
    } finally {
      await connection?.disconnect();
    }
  }

  function tombstoneResidentsResolvingIntoPrivateState(branch: string): void {
    for (const [docName, document] of hocuspocus.documents) {
      if (isReservedForUserTree(docName)) continue;
      if (document.getMap('lifecycle').get('status') !== undefined) continue;
      try {
        const filePath = safeContentPath(docName, contentDir);
        if (!existsSync(filePath)) continue;
        if (!canonicalContentPathIsRefused(filePath, realpathSync(filePath), contentDir)) continue;
        rescueUnflushedEditsBeforeTeardown(docName, branch, 'branch-switch');
        document.getMap('lifecycle').set('status', 'deleted-upstream');
        log.warn(
          { docName, branch },
          `[branch-switch] tombstone: ${docName} resolves outside the content dir or into private state on ${branch}`,
        );
      } catch (err) {
        log.error({ err, docName }, `[branch-switch] could not check where ${docName} resolves`);
      }
    }
  }

  const rescueUnflushedEditsBeforeTeardown = (
    docName: string,
    branch: string,
    site: 'delete' | 'rename' | 'branch-switch',
    followedByContentLoss = false,
  ): boolean => {
    const reconciledBase = getReconciledBase(docName);
    const ours = serializeDoc(docName) ?? '';
    const isDirty = reconciledBase === undefined ? ours !== '' : ours !== reconciledBase;
    if (!isDirty) return isDirty;
    mintExternalChangeRescue(docName, ours, branch, site, '', followedByContentLoss);
    return isDirty;
  };

  function dissolveNonGitConflicts(docName: string): void {
    conflicts.dissolveReconcile(docName);
    conflicts.dissolveWorkingTree(conflicts.fileOf(docName));
  }

  const reportInsertDedupSkipped = (
    docName: string,
    outcome: ReconcileOutcome,
    ours: string,
    theirs: string,
  ): void => {
    if (outcome.kind !== 'merged' && outcome.kind !== 'both-kept') return;
    if (!outcome.dedupSkipped) return;
    incrementReconcileInsertDedupSkipped();
    log.warn(
      {
        docName,
        oursLen: ours.length,
        theirsLen: theirs.length,
        newLen: outcome.newContent.length,
      },
      `[reconcile] ${docName} insert-group dedup skipped (LCS cell cap); union emitted with possible same-block duplication`,
    );
  };

  const applyDiskAuthoritativeIngest = async (
    docName: string,
    theirs: string,
    priorBase: string | undefined,
  ): Promise<DiskIntakeOutcome> => {
    const baseAbsent = priorBase === undefined;
    incrementDiskAuthoritativeIngest();
    const ours = serializeDoc(docName) ?? '';
    const branch = getStorageBranch() ?? 'main';
    const theirsH = contentHash(theirs).slice(0, 6);
    const liveOnlyContentAtRisk = ours !== '' && ours !== theirs;
    const rescue: 'not-needed' | 'rescued' | 'lost' = !liveOnlyContentAtRisk
      ? 'not-needed'
      : rescueDocToShadowBuffer(docName, 'disk-authoritative-ingest');
    if (liveOnlyContentAtRisk) {
      mintExternalChangeRescue(docName, ours, branch, 'disk-update', theirsH, true);
    }
    const oursH = contentHash(ours).slice(0, 6);
    const baseToken = baseAbsent ? 'absent' : 'blockless';
    let applyError: unknown;
    let ingested = false;
    try {
      applyToDoc(docName, theirs);
      dissolveNonGitConflicts(docName);
      ingested = true;
    } catch (e) {
      applyError = e;
      incrementDiskAuthoritativeIngestApplyFailures();
      log.error(
        { err: e, docName },
        `[reconcile] failed to apply disk-authoritative ingest to Y.Doc for ${docName}`,
      );
      mintExternalChangeRescue(docName, theirs, branch, 'disk-update', theirsH, true);
      dissolveNonGitConflicts(docName);
      let surviving: string | undefined;
      try {
        surviving = serializeDoc(docName) ?? undefined;
      } catch (readError) {
        log.error(
          { err: readError, docName },
          `[reconcile] unable to read ${docName} back after a failed disk-authoritative ingest; treating the live content as lost`,
        );
      }
      if (surviving === theirs) setReconciledBase(docName, theirs);
      else durabilityState.restoreReconciledBase(docName, priorBase);
      if (rescue === 'lost' && surviving !== ours) {
        incrementDiskAuthoritativeIngestUnrescued();
        log.warn(
          {
            docName,
            baseAbsent,
            reason: 'no-base',
            ours: oursH,
            theirs: theirsH,
            result: 'clean-unrescued',
            rescue,
            applyFailed: true,
          },
          `[reconcile] ${docName} base=${baseToken} reason=no-base result=clean-unrescued ours=${oursH} theirs=${theirsH} rescue=${rescue} applyFailed=true`,
        );
      }
    }
    if (ingested) {
      const result = rescue === 'lost' ? 'clean-unrescued' : 'clean';
      if (rescue === 'lost') incrementDiskAuthoritativeIngestUnrescued();
      const emit = rescue === 'lost' ? log.warn.bind(log) : log.info.bind(log);
      emit(
        {
          docName,
          baseAbsent,
          reason: 'no-base',
          ours: oursH,
          theirs: theirsH,
          result,
          rescue,
        },
        `[reconcile] ${docName} base=${baseToken} reason=no-base result=${result} ours=${oursH} theirs=${theirsH} rescue=${rescue}`,
      );
      await recordUpsertAfterIntake(docName, theirs);
      return liveOnlyContentAtRisk
        ? { kind: 'applied', merge: 'disk-replaced' }
        : { kind: 'applied' };
    }
    return { kind: 'failed', error: applyError };
  };

  const recordUpsertAfterIntake = async (docName: string, theirs: string): Promise<void> => {
    try {
      await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
    } catch (err) {
      log.warn(
        { err, docName },
        `[reconcile] ${docName}: the derived index could not record the disk version`,
      );
    }
  };

  type DiskIntakeOutcome =
    | { readonly kind: 'applied'; readonly merge?: StoreIntakeMerge }
    | { readonly kind: 'nothing-to-take' }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'failed'; readonly error: unknown };

  function assertNeverDiskIntakeOutcome(outcome: never): never {
    throw new Error(`unhandled disk intake outcome: ${(outcome as { kind: string }).kind}`);
  }

  function assertNeverReconcileOutcome(outcome: never): never {
    throw new Error(`unhandled reconcile outcome: ${(outcome as { kind: string }).kind}`);
  }

  async function intakeDiskUpdate(
    event: Extract<DiskEvent, { kind: 'update' }>,
  ): Promise<DiskIntakeOutcome> {
    const { docName, content: theirs } = event;
    onUpstreamAdd(docName);
    if (indexedMetadataChanged(event.previousIndexedFields, theirs, docName)) {
      scheduleIndexRegeneration(docName);
    }
    if (conflicts.findByDocName(docName)?.kind === 'merge-native') {
      try {
        await conflicts.pruneMergeNativeAgainstGit();
      } catch (err) {
        log.warn({ err, docName }, '[reconcile] conflict prune against git failed');
      }
    }

    const document = hocuspocus.documents.get(docName);
    if (!document) {
      if (!refuseStaleExternalWrite(durabilityState, undefined, docName, theirs, conflicts)) {
        durabilityState.refreshReceiptWithoutBase(docName, theirs);
      }
      await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
      return { kind: 'nothing-to-take' };
    }
    if (reviveFrozenResident(docName, theirs) !== 'not-frozen') {
      await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
      return { kind: 'nothing-to-take' };
    }

    const theirsHash = contentHash(theirs);
    const receiptIntake = classifyIntakeAgainstReceipt({
      receiptHash: durabilityState.getReceipt(docName)?.hash,
      eventHash: theirsHash,
      isRecentOwnWrite: durabilityState.isRecentOwnWrite(docName, theirsHash),
      readDiskHash: () => {
        try {
          return contentHash(readFileSync(event.path, 'utf-8'));
        } catch {
          return null;
        }
      },
    });
    const receiptSkip = receiptIntakeSkipOf(receiptIntake);
    if (receiptSkip !== null && durabilityState.getStaleExternalWrite(docName) === undefined) {
      incrementReceiptIntakeSkip(receiptSkip);
      log.debug(
        { docName, receiptIntake },
        `[reconcile] ${docName}: the disk bytes match its receipt (${receiptIntake}); nothing to take in`,
      );
      conflicts.dissolveReconcile(docName);
      await recordUpsertAfterIntake(docName, theirs);
      return { kind: 'nothing-to-take' };
    }

    const base = getReconciledBase(docName);
    const ours = serializeDoc(docName) ?? base ?? '';

    if (refuseStaleExternalWrite(durabilityState, document, docName, theirs, conflicts, ours)) {
      await recordUpsertAfterIntake(docName, theirs);
      return { kind: 'conflict' };
    }

    if (base === undefined) {
      return applyDiskAuthoritativeIngest(docName, theirs, undefined);
    }

    const result = reconcile({ docName, base, ours, theirs });

    const baseH = contentHash(base).slice(0, 6);
    const oursH = contentHash(ours).slice(0, 6);
    const theirsH = contentHash(theirs).slice(0, 6);
    const oursLen = ours.length;
    const theirsLen = theirs.length;
    const newLen =
      result.kind === 'clean' || result.kind === 'merged' || result.kind === 'both-kept'
        ? result.newContent.length
        : undefined;
    const delta = newLen === undefined ? undefined : newLen - Math.max(oursLen, theirsLen);
    const sizeSuffix = newLen === undefined ? '' : ` newLen=${newLen} delta=${delta}`;
    log.info(
      {
        docName,
        base: baseH,
        ours: oursH,
        theirs: theirsH,
        result: result.kind,
        oursLen,
        theirsLen,
        ...(newLen === undefined ? {} : { newLen, delta }),
      },
      `[reconcile] ${docName} base=${baseH} ours=${oursH} theirs=${theirsH} result=${result.kind} oursLen=${oursLen} theirsLen=${theirsLen}${sizeSuffix}`,
    );

    reportInsertDedupSkipped(docName, result, ours, theirs);

    switch (result.kind) {
      case 'noop':
        conflicts.dissolveReconcile(docName);
        await recordUpsertAfterIntake(docName, theirs);
        return { kind: 'nothing-to-take' };

      case 'clean':
        try {
          applyToDoc(docName, result.newContent);
        } catch (e) {
          log.error(
            { err: e, docName },
            `[reconcile] failed to apply clean content to Y.Doc for ${docName}`,
          );
          setReconciledBase(docName, base);
          conflicts.dissolveReconcile(docName);
          return { kind: 'failed', error: e };
        }
        setReconciledBase(docName, result.newContent);
        incrementReconcile();
        conflicts.dissolveReconcile(docName);
        await recordUpsertAfterIntake(docName, theirs);
        return { kind: 'applied', merge: 'clean' };

      case 'merged':
        try {
          applyToDoc(docName, result.newContent);
        } catch (e) {
          log.error(
            { err: e, docName },
            `[reconcile] failed to apply merged content to Y.Doc for ${docName}`,
          );
          setReconciledBase(docName, base);
          conflicts.dissolveReconcile(docName);
          return { kind: 'failed', error: e };
        }
        setReconciledBase(docName, theirs);
        incrementReconcile();
        conflicts.dissolveReconcile(docName);
        await recordUpsertAfterIntake(docName, theirs);
        return { kind: 'applied', merge: 'merged' };

      case 'both-kept': {
        try {
          applyToDoc(docName, result.newContent);
        } catch (e) {
          log.error(
            { err: e, docName },
            `[reconcile] failed to apply both-kept content to Y.Doc for ${docName}; raising the conflict`,
          );
          setReconciledBase(docName, base);
          incrementConflict();
          conflicts.raise({
            kind: 'reconcile',
            file: conflicts.fileOf(docName),
            reason: 'merged-with-markers',
            stages: { base, ours, theirs },
          });
          return { kind: 'failed', error: e };
        }
        mergeHistory.bothKept(docName, { ours, theirs }, result.kept);
        setReconciledBase(docName, theirs);
        incrementReconcile();
        reportReconcileBothKept(docName, result.kept, 'watcher');
        conflicts.dissolveReconcile(docName);
        await recordUpsertAfterIntake(docName, theirs);
        return { kind: 'applied', merge: 'both-kept' };
      }

      case 'refused': {
        if (result.reason === 'no-base') {
          return applyDiskAuthoritativeIngest(docName, theirs, base);
        }
        reportReconcileCheckFailed(docName, result, 'watcher');
        if (result.reason === 'check-failed' || result.reason === 'too-large') {
          if (
            await mergeHistory.keptLive(docName, { side: 'theirs', bytes: theirs }, result.reason)
          ) {
            setReconciledBase(docName, theirs);
            reportReconcileKeptLive(docName, result.reason, 'watcher');
            conflicts.dissolveReconcile(docName);
            await recordUpsertAfterIntake(docName, theirs);
            return { kind: 'applied', merge: 'kept-live' };
          }
        }
        incrementConflict();
        conflicts.raise({
          kind: 'reconcile',
          file: conflicts.fileOf(docName),
          reason: wireReasonForRefusal(result.reason),
          stages: { base, ours, theirs },
        });
        return { kind: 'conflict' };
      }
      default:
        return assertNeverReconcileOutcome(result);
    }
  }

  const bufferedRemovalScopes = new Map<
    Extract<DiskEvent, { kind: 'delete' | 'rename' }>,
    ReturnType<typeof beginRemoval>
  >();

  async function handleDiskEvent(
    event: DiskEvent,
    preparedRemoval = event.kind === 'delete' || event.kind === 'rename'
      ? (bufferedRemovalScopes.get(event) ??
        beginRemoval(
          event.kind === 'delete' ? event.docName : event.oldDocName,
          getMarkdownRemovalCurrentness(event),
        ))
      : undefined,
  ): Promise<void> {
    try {
      switch (event.kind) {
        case 'create': {
          const facts = getMarkdownEventFacts(event);
          const createdHash = contentHash(event.content);
          const paired = vanishedDocuments.matchCreate({
            docName: event.docName,
            identity: facts.identity,
            size: facts.size,
            modified: facts.modified,
            hash: createdHash,
            content: event.content,
          });
          if (paired) {
            releaseVanished(paired.vanished.docName);
            if (paired.by === 'same-name') {
              recordVanishOutcome('recreated');
              log.info(
                { docName: event.docName },
                `[reconcile] ${event.docName}: its file came back; taking it in as an update`,
              );
              await handleDiskEvent({
                kind: 'update',
                path: event.path,
                docName: event.docName,
                content: event.content,
              });
              flushReleasedStores();
              break;
            }
            const carry = durabilityState.beginRenameCarry(paired.vanished.docName);
            try {
              persistence.discardDeferredStore(paired.vanished.docName, {
                kind: 'renamed-outside',
                to: event.docName,
                carry,
              });
              recordVanishOutcome(paired.by === 'identity' ? 'paired-identity' : 'paired-hash');
              await handleDiskEvent({
                kind: 'rename',
                oldPath: paired.vanished.path,
                newPath: event.path,
                oldDocName: paired.vanished.docName,
                newDocName: event.docName,
                content: event.content,
              });
            } finally {
              durabilityState.abandonRenameCarry(paired.vanished.docName);
            }
            break;
          }
          vanishedDocuments.rememberCreate({
            docName: event.docName,
            path: event.path,
            identity: facts.identity,
            size: facts.size,
            modified: facts.modified,
            hash: createdHash,
            at: vanishClock.now(),
          });
          log.info({ docName: event.docName }, `[reconcile] create: ${event.docName}`);
          reviveFrozenResident(event.docName, event.content);
          await derivedDocumentIndex.recordDiskUpsert(event.docName, event.content);
          signalChannel('files');
          scheduleIndexRegeneration(event.docName);
          onUpstreamAdd(event.docName);
          break;
        }

        case 'update': {
          await intakeDiskUpdate(event);
          break;
        }

        case 'delete': {
          const { docName } = event;
          const removal =
            preparedRemoval ?? beginRemoval(docName, getMarkdownRemovalCurrentness(event));
          bufferedRemovalScopes.delete(event);
          try {
            const namespaceCurrent = removal.namespaceCurrent();
            const residentCurrent = removal.residentCurrent();
            if (!namespaceCurrent && !residentCurrent) {
              log.debug(
                { docName, source: 'watcher-delete', namespaceCurrent, residentCurrent },
                `[reconcile] delete skipped: ${docName} (stale removal)`,
              );
              return;
            }
            if (
              namespaceCurrent &&
              residentCurrent &&
              removal.document &&
              !settledVanishEvents.has(event) &&
              (await holdVanishedDocument(event))
            ) {
              return;
            }
            if (namespaceCurrent) {
              dissolveNonGitConflicts(docName);
              commentDocHooksRef.current?.deleted(docName);
            }
            const { document } = removal;
            const isDirty =
              residentCurrent && document
                ? rescueUnflushedEditsBeforeTeardown(
                    docName,
                    getStorageBranch() ?? 'main',
                    'delete',
                    true,
                  )
                : false;
            if (residentCurrent) {
              document?.getMap('lifecycle').set('status', 'deleted-upstream');
              durabilityState.endRenameCarry(docName);
            }
            if (namespaceCurrent) deleteReconciledBase(docName);
            if (namespaceCurrent) await derivedDocumentIndex.recordDiskDelete(docName);
            if (!removal.namespaceCurrent() && !removal.residentCurrent()) {
              log.debug(
                {
                  docName,
                  source: 'watcher-delete',
                  namespaceCurrent: false,
                  residentCurrent: false,
                },
                `[reconcile] delete skipped: ${docName} (stale removal)`,
              );
              return;
            }
            log.info(
              { docName, isDirty, source: 'watcher-delete' },
              `[reconcile] delete: ${docName} (dirty=${isDirty})`,
            );
            if (removal.residentCurrent() && document) {
              hocuspocus.closeConnections(docName);
              await forceUnloadDocument(document, removal.residentCurrent);
            }
            if (!removal.namespaceCurrent()) {
              log.debug(
                {
                  docName,
                  source: 'watcher-delete',
                  namespaceCurrent: false,
                  residentCurrent: removal.residentCurrent(),
                },
                `[reconcile] delete: ${docName} not recorded as removed (stale removal)`,
              );
              return;
            }
            signalChannel('files');
            onUpstreamDelete(docName);
            scheduleIndexRegenerationAfterRemoval(docName);
            console.info(
              JSON.stringify({
                event: 'recently-removed-docs-populate',
                docName,
                kind: 'deleted',
                source: 'watcher-delete',
              }),
            );
          } finally {
            removal.dispose();
          }
          break;
        }

        case 'rename': {
          const { oldDocName, newDocName, content } = event;
          const removal =
            preparedRemoval ?? beginRemoval(oldDocName, getMarkdownRemovalCurrentness(event));
          bufferedRemovalScopes.delete(event);
          durabilityState.beginRenameCarry(oldDocName);
          let carriedThrough: WrittenThrough | null = null;
          let retiredResident = false;
          try {
            const document = removal.document;
            const residentBeforeRename = removal.residentCurrent() && document ? document : null;
            const liveBeforeRename = residentBeforeRename ? serializeDoc(oldDocName) : null;
            const textBeforeRename = residentBeforeRename
              ? writtenThroughOf(residentBeforeRename)
              : null;
            const baseBeforeRename = getReconciledBase(oldDocName);
            const freezeAsRenamed = (doc: Document): void => {
              const lifecycle = doc.getMap('lifecycle');
              lifecycle.set('status', 'renamed');
              lifecycle.set('newPath', newDocName);
            };
            const isDirty =
              removal.residentCurrent() && document
                ? rescueUnflushedEditsBeforeTeardown(
                    oldDocName,
                    getStorageBranch() ?? 'main',
                    'rename',
                  )
                : false;
            if (removal.residentCurrent() && document) freezeAsRenamed(document);
            if (removal.namespaceCurrent()) {
              dissolveNonGitConflicts(oldDocName);
              deleteReconciledBase(oldDocName);
              persistence.forgetObservedFile(oldDocName);
              onUpstreamRename(oldDocName, newDocName);
            }
            setReconciledBase(newDocName, content);
            log.info(
              { oldDocName, newDocName, isDirty },
              `[reconcile] rename: ${oldDocName} → ${newDocName} (dirty=${isDirty})`,
            );
            signalChannel('files');
            onUpstreamAdd(newDocName);
            try {
              if (removal.namespaceCurrent()) {
                await derivedDocumentIndex.recordDiskRename(oldDocName, newDocName, content);
              } else {
                await derivedDocumentIndex.recordDiskUpsert(newDocName, content);
              }
            } catch (err) {
              log.error(
                { oldDocName, newDocName, err },
                `[reconcile] rename: index update failed for ${oldDocName} → ${newDocName}; completing client teardown anyway`,
              );
            }
            const loadedDuringIndex = removal.namespaceCurrent()
              ? hocuspocus.documents.get(oldDocName)
              : undefined;
            const lateResident = loadedDuringIndex !== document ? loadedDuringIndex : undefined;
            if (lateResident) freezeAsRenamed(lateResident);
            reviveFrozenResident(newDocName, content);
            scheduleIndexRegeneration(newDocName);
            if (removal.namespaceCurrent()) {
              followRecordsAcrossRename(oldDocName, newDocName, event.newPath);
            }
            if (liveBeforeRename !== null && baseBeforeRename !== undefined) {
              const carried =
                liveBeforeRename === baseBeforeRename ||
                (await carryLiveTextAcrossRename(
                  newDocName,
                  event.newPath,
                  baseBeforeRename,
                  liveBeforeRename,
                  content,
                ));
              if (carried) carriedThrough = textBeforeRename;
            }
            const retired = removal.residentCurrent() && document ? document : lateResident;
            retiredResident = Boolean(retired);
            if (retired) {
              const closedConnections = retired.getConnectionsCount();
              /* WARN: the `delete` branch above and `captureAndCloseDocuments` pair their
               close with `forceUnloadDocument`; this branch does not, so the frozen doc
               stays resident under the old name and template-watcher-capabilities.test.ts
               pins that residency. The destination clear above is what stops a move back
               to this path from being served that stale frozen doc. */
              hocuspocus.closeConnections(oldDocName);
              await sessionManager.closeAllForDoc(oldDocName);
              if (closedConnections > 0) {
                log.info(
                  { oldDocName, newDocName, closedConnections },
                  `[reconcile] rename: closed ${closedConnections} connection(s) on ${oldDocName}`,
                );
              }
            }
            if (!removal.namespaceCurrent()) {
              log.debug(
                {
                  docName: oldDocName,
                  newDocName,
                  source: 'watcher-rename',
                  namespaceCurrent: false,
                  residentCurrent: removal.residentCurrent(),
                },
                `[reconcile] rename: ${oldDocName} not recorded as removed (stale removal)`,
              );
              break;
            }
            console.info(
              JSON.stringify({
                event: 'recently-removed-docs-populate',
                from: oldDocName,
                to: newDocName,
                kind: 'renamed',
                source: 'watcher-rename',
              }),
            );
            scheduleIndexRegenerationAfterRemoval(oldDocName);
          } finally {
            durabilityState.settleRenameCarry(oldDocName, carriedThrough);
            if (!retiredResident) durabilityState.endRenameCarry(oldDocName);
            removal.dispose();
          }
          break;
        }

        case 'conflict': {
          const { docName } = event;
          const document = hocuspocus.documents.get(docName);
          if (!document) return;

          const priorBase = getReconciledBase(docName) ?? '';
          const ours = serializeDoc(docName);
          if (ours !== null) {
            setReconciledBase(docName, ours);
          } else {
            log.warn(
              { docName },
              `[reconcile] case 'conflict': serializeDoc returned null for ${docName}; reconciledBase snapshot skipped — post-resolution reconcile may degrade to 3-way merge`,
            );
          }

          conflicts.raise({
            kind: 'reconcile',
            file: conflicts.fileOf(docName),
            reason: 'disk-markers',
            stages: { base: priorBase, ours: ours ?? priorBase, theirs: event.content },
          });
          log.info({ docName }, `[reconcile] conflict markers detected: ${docName}`);
          break;
        }

        case 'asset-create': {
          basenameIndex.add(event.relativePath);
          signalChannel('files');
          scheduleAssetRerender(basename(event.relativePath));
          break;
        }
        case 'asset-delete': {
          basenameIndex.remove(event.relativePath);
          signalChannel('files');
          scheduleAssetRerender(basename(event.relativePath));
          break;
        }
        case 'folder-create':
        case 'folder-delete': {
          signalChannel('files');
          scheduleSubdirectoryIndexRegeneration(event.relativePath);
          break;
        }
        case 'file-create':
        case 'file-update': {
          await derivedDocumentIndex.recordFileTargetUpsert(event.relativePath);
          invalidateReferencedAssetsCache?.();
          signalChannel('files');
          await takeInEnginelessChange(event.relativePath);
          break;
        }
        case 'file-delete': {
          await derivedDocumentIndex.recordFileTargetDelete(event.relativePath);
          invalidateReferencedAssetsCache?.();
          signalChannel('files');
          break;
        }
        default:
          assertNeverDiskEvent(event);
      }
    } catch (err) {
      const label = diskEventLabel(event);
      log.error(
        { err, kind: event.kind, label },
        `[reconcile] failed to handle ${event.kind} for ${label}`,
      );
    }
  }

  const eventBuffer: DiskEvent[] = [];

  async function onDiskEvent(event: DiskEvent): Promise<void> {
    if (documentAdmissionClosed) return;
    if ((event.kind === 'delete' || event.kind === 'rename') && !bufferedRemovalScopes.has(event)) {
      bufferedRemovalScopes.set(
        event,
        beginRemoval(
          event.kind === 'delete' ? event.docName : event.oldDocName,
          getMarkdownRemovalCurrentness(event),
        ),
      );
    }
    if (isBatchInProgress() || draining !== null) {
      eventBuffer.push(event);
      return;
    }
    await handleDiskEvent(event);
  }

  let draining: Promise<void> | null = null;

  function drainEventBuffer(): Promise<void> {
    if (draining) return draining;
    if (eventBuffer.length === 0) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    draining = done.promise;
    void (async () => {
      try {
        while (eventBuffer.length > 0) {
          const events = eventBuffer.splice(0, eventBuffer.length);
          for (const event of events) await handleDiskEvent(event);
        }
        done.resolve();
      } catch (err) {
        done.reject(err);
      } finally {
        draining = null;
      }
    })();
    return done.promise;
  }

  function disposeBufferedRemovalScopes(): void {
    for (const scope of bufferedRemovalScopes.values()) scope.dispose();
    bufferedRemovalScopes.clear();
  }

  let watcher: WatcherHandle | null = null;

  function isEnginelessDoc(docName: string): boolean {
    return isMermaidDoc(docName) || isExcalidrawDoc(docName) || isEditableTextDoc(docName);
  }

  async function takeInEnginelessChange(docName: string): Promise<boolean> {
    if (!isEnginelessDoc(docName)) return false;
    const document = hocuspocus.documents.get(docName);
    if (!document) return false;
    const outcome = await applyExternalEnginelessChange(
      document,
      docName,
      persistence.mermaidPersistenceCtx,
    );
    return outcome !== 'unchanged';
  }

  async function refreshDocumentsFromDisk(
    docNames: readonly string[],
    trigger: DocumentRefreshTrigger,
  ): Promise<DocumentRefreshResult> {
    if (!watcher) return { checked: 0, found: 0 };
    const aliases = watcher.getAliasMap();
    const index = watcher.getFileIndex();
    const paths: string[] = [];
    const engineless = { checked: 0, found: 0 };
    for (const requested of new Set(docNames)) {
      const docName = aliases.get(requested) ?? requested;
      if (isReservedForUserTree(docName)) continue;
      if (isEnginelessDoc(docName)) {
        engineless.checked++;
        if (await takeInEnginelessChange(docName)) engineless.found++;
        continue;
      }
      const indexed = index.get(docName)?.canonicalPath;
      if (indexed !== undefined) {
        paths.push(indexed);
        continue;
      }
      try {
        paths.push(safeContentPath(docName, contentDir));
      } catch (err) {
        log.debug(
          { err, trigger },
          '[reconcile] skipped a re-read for a name outside the content tree',
        );
      }
    }
    const rechecked =
      paths.length === 0 ? { checked: 0, found: 0 } : await watcher.recheckPaths(paths);
    const result = {
      checked: rechecked.checked + engineless.checked,
      found: rechecked.found + engineless.found,
    };
    const summary = { trigger, ...result };
    if (result.found > 0)
      log.info(summary, `[reconcile] re-read on ${trigger} found outside changes`);
    else log.debug(summary, `[reconcile] re-read on ${trigger} found nothing new`);
    return result;
  }
  let syncEngine: SyncEngine | null = null;
  let inflightDestroy: Promise<void> | null = null;

  const rescueDocToShadowBuffer = (
    docName: string,
    context:
      | 'refused-store-shutdown'
      | 'refused-store-mark'
      | 'flush-timeout'
      | 'disk-authoritative-ingest',
  ): 'rescued' | 'lost' => {
    const shadow = shadowRef.current;
    if (!shadow) {
      log.warn(
        { docName, context },
        `[rescue] shadow repo unavailable — cannot buffer ${docName} (${context})`,
      );
      incrementRescueBufferWriteFailures();
      return 'lost';
    }
    try {
      const ours = isPersistenceExcludedDoc(docName)
        ? (hocuspocus.documents.get(docName)?.getText('source').toString() ?? null)
        : serializeDoc(docName);
      if (ours === null) {
        log.warn(
          { docName, context },
          `[rescue] skipping ${docName} — document dropped from map mid-rescue (${context})`,
        );
        incrementRescueBufferWriteFailures();
        return 'lost';
      }
      const rescuePath = safeRescuePath(shadow.gitDir, docName);
      if (!rescuePath) {
        log.warn(
          { docName, gitDir: shadow.gitDir, context },
          `[rescue] path-traversal guard rejected docName: ${docName} (${context})`,
        );
        incrementRescueBufferWriteFailures();
        return 'lost';
      }
      tracedMkdirSync(dirname(rescuePath), { recursive: true });
      tracedWriteFileSync(rescuePath, ours, 'utf-8');
      incrementRescueBuffer();
      log.info({ docName, context }, `[rescue] rescue buffer saved (${context}): ${docName}`);
      return 'rescued';
    } catch (e) {
      log.error(
        { err: e, docName, context },
        `[rescue] failed to write rescue buffer for ${docName} (${context})`,
      );
      incrementRescueBufferWriteFailures();
      return 'lost';
    }
  };

  async function flushAllStoresAndWait(timeoutMs: number): Promise<void> {
    if (hocuspocus.documents.size === 0) return;

    let settled = false;
    let flushDeadline = Date.now() + timeoutMs;
    const raceFloorMs = 250;
    let timeoutState: { id: ReturnType<typeof setTimeout>; expire: () => void } | undefined;
    const allDone = Promise.withResolvers<void>();
    const stopObserving = observeShutdownDocumentRetirements(hocuspocus, () => {
      if (settled) return;
      flushDeadline = Date.now() + timeoutMs;
      if (timeoutState) {
        clearTimeout(timeoutState.id);
        timeoutState.id = setTimeout(
          timeoutState.expire,
          Math.max(flushDeadline - Date.now(), raceFloorMs),
        );
      }
    });
    const allDoneExtension: Extension = {
      async afterUnloadDocument({ instance }) {
        if (!settled && instance.getDocumentsCount() === 0) {
          settled = true;
          allDone.resolve();
        }
      },
    };
    hocuspocus.configuration.extensions.push(allDoneExtension);

    try {
      const pendingDocNames = Array.from(hocuspocus.documents.keys());

      hocuspocus.closeConnections();
      hocuspocus.flushPendingStores();

      for (const doc of hocuspocus.documents.values()) {
        if (doc.getConnectionsCount() === 0) {
          void hocuspocus.unloadDocument(doc).catch((err: unknown) => {
            console.warn(
              JSON.stringify({
                event: 'ok-shutdown-unload-document-failed',
                docName: doc.name,
                reason: err instanceof Error ? err.message : String(err),
              }),
            );
          });
        }
      }

      while (Date.now() < flushDeadline - raceFloorMs) {
        const unsettled = Array.from(hocuspocus.documents.values()).some(
          (doc) => doc.getConnectionsCount() === 0 && !defaultShouldUnloadDocument(doc),
        );
        if (!unsettled) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const perDocUnloadFloorMs = 50;
      for (const docName of durabilityState.getRefusedStoreDocNames()) {
        if (isReservedForUserTree(docName)) continue;
        const doc = hocuspocus.documents.get(docName);
        if (!doc) continue;
        if (!defaultShouldUnloadDocument(doc)) continue;
        if (flushDeadline - Date.now() < perDocUnloadFloorMs) {
          log.warn(
            { docName },
            `[rescue] refused-store pass out of budget before ${docName}; leaving it and any remaining refused docs to the flush timeout path`,
          );
          break;
        }
        if (rescueDocToShadowBuffer(docName, 'refused-store-shutdown') !== 'rescued') {
          log.warn(
            { docName },
            `[rescue] refused-store doc rescue failed; leaving ${docName} to the flush timeout path`,
          );
          continue;
        }
        let unloadSettled = false;
        let unloadFailed = false;
        const unload = forceUnloadDocument(doc)
          .then(() => {
            unloadSettled = true;
          })
          .catch((err: unknown) => {
            unloadFailed = true;
            unloadSettled = true;
            log.warn(
              { docName, err },
              `[rescue] refused-store doc unload failed at shutdown: ${docName}`,
            );
          });
        let unloadDeadline = 0;
        do {
          const unloadSlice = Math.max(flushDeadline - Date.now(), perDocUnloadFloorMs);
          unloadDeadline += unloadSlice;
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              unload,
              new Promise<void>((resolve) => {
                waitTimer = setTimeout(resolve, unloadSlice);
              }),
            ]);
          } finally {
            if (waitTimer !== undefined) clearTimeout(waitTimer);
          }
        } while (!unloadSettled && Date.now() < flushDeadline);
        if (!unloadSettled) {
          log.warn(
            { docName, unloadDeadline },
            `[rescue] refused-store doc unload did not finish before the flush deadline; leaving ${docName} to the flush timeout path`,
          );
          void unload.then(() => {
            if (!unloadFailed) {
              log.info(
                { docName },
                `[rescue] refused-store doc unload completed after the flush deadline: ${docName}`,
              );
            }
          });
          continue;
        }
        if (!unloadFailed) {
          log.info(
            { docName },
            `[rescue] refused-store doc rescued and unloaded at shutdown: ${docName}`,
          );
        }
      }

      const timeout = new Promise<never>((_, reject) => {
        const expire = () => {
          if (settled) return;
          settled = true;
          stopObserving();
          const stillLoaded = Array.from(hocuspocus.documents.keys());

          const rescued: string[] = [];
          const rescueFailed: string[] = [];
          if (shadowRef.current) {
            for (const docName of stillLoaded) {
              if (isReservedForUserTree(docName)) continue;
              if (rescueDocToShadowBuffer(docName, 'flush-timeout') === 'rescued') {
                rescued.push(docName);
              } else {
                rescueFailed.push(docName);
              }
            }
          } else {
            log.warn(
              { stillLoadedCount: stillLoaded.length },
              `[rescue] shadow repo unavailable at flush timeout — ${stillLoaded.length} doc(s) will be lost: [${stillLoaded.join(', ')}]`,
            );
            for (const docName of stillLoaded) {
              if (isReservedForUserTree(docName)) continue;
              rescueFailed.push(docName);
              incrementRescueBufferWriteFailures();
            }
          }

          const rescueSummary =
            rescued.length > 0 || rescueFailed.length > 0
              ? ` — rescued [${rescued.join(', ')}]${
                  rescueFailed.length > 0 ? `, lost [${rescueFailed.join(', ')}]` : ''
                }`
              : '';

          reject(
            new Error(
              `flushAllStoresAndWait timeout: no document retired for ${timeoutMs}ms — ${stillLoaded.length}/${pendingDocNames.length} docs did not unload: [${stillLoaded.join(', ')}]${rescueSummary}`,
            ),
          );
        };
        timeoutState = {
          id: setTimeout(expire, Math.max(flushDeadline - Date.now(), raceFloorMs)),
          expire,
        };
      });

      await Promise.race([allDone.promise, timeout]);
    } finally {
      settled = true;
      stopObserving();
      const extensions = hocuspocus.configuration.extensions;
      const index = extensions.indexOf(allDoneExtension);
      if (index !== -1) extensions.splice(index, 1);
      if (timeoutState) clearTimeout(timeoutState.id);
    }
  }

  async function destroy(): Promise<void> {
    if (inflightDestroy) return inflightDestroy;

    inflightDestroy = (async () => {
      const t0 = Date.now();
      const phaseErrors: Array<{ phase: string; error: string }> = [];
      const graceShareMs = Math.min(destroyTimeoutMs, DEFAULT_SIGTERM_GRACE_MS / 5);
      const preludeDeadline = Date.now() + graceShareMs;
      const preludeRemaining = () => Math.max(1, preludeDeadline - Date.now());
      const joinPrelude = async <T>(operation: Promise<T>, phase: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${phase} did not retire before the pre-flush deadline`)),
                preludeRemaining(),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      shutdownAllowsUnload = true;
      const authShutdown = Promise.allSettled([shutdownLocalOps()]);
      let authResult: PromiseSettledResult<void> | undefined;
      try {
        [authResult] = await joinPrelude(authShutdown, 'mutation-drain');
      } catch (err) {
        phaseErrors.push({ phase: 'mutation-drain', error: String(err) });
        log.error({ err }, '[server] shutdown mutation drain failed');
      }
      vanishClock.clearTimeout(vanishRecheckTimer);
      vanishRecheckTimer = null;
      supersedeBranchSwitchFollowUps();
      for (const entry of vanishedDocuments.all()) {
        persistence.discardDeferredStore(entry.docName, { kind: 'shutdown' });
        rescueUnflushedEditsBeforeTeardown(
          entry.docName,
          getStorageBranch() ?? 'main',
          'delete',
          true,
        );
        recordVanishOutcome('shutdown');
        durabilityState.releaseStores(entry.docName);
      }
      vanishedDocuments.clear();
      durabilityState.endAllRenameCarries();
      reportedUnreadableReturns.clear();
      overdueFaults.clear();
      documentAdmissionClosed = true;
      disposeBufferedRemovalScopes();
      for (const removals of activeRemovals.values()) {
        for (const removal of removals) {
          removal.namespaceAllowed = false;
          removal.residentAllowed = false;
        }
      }
      activeRemovals.clear();
      residentOccurrences = new WeakMap();

      try {
        await joinPrelude(closeIndexRegeneration(), 'generated-index');
      } catch (err) {
        log.warn({ err }, '[index] generated index shutdown drain failed');
        phaseErrors.push({ phase: 'generated-index-drain', error: String(err) });
      }

      for (const unregister of unregisterWorkloadProviders.splice(0)) {
        unregister();
      }
      try {
        await joinPrelude(Promise.resolve(stalenessWatchdog?.dispose()), 'staleness-watchdog');
      } catch (err) {
        log.warn({ err }, '[server] staleness watchdog drain failed during destroy');
        phaseErrors.push({ phase: 'staleness-watchdog-drain', error: String(err) });
      }
      stalenessWatchdog = null;

      try {
        markServerLockDraining(lockDir);
      } catch (err) {
        log.warn({ err }, '[server] failed to mark server.lock draining');
      }

      maintenanceCoordinator?.destroy();

      try {
        await joinPrelude(closeShadowHousekeeping(), 'shadow-housekeeping');
      } catch (err) {
        log.warn({ err }, '[shadow-housekeeping] shutdown drain failed');
        phaseErrors.push({ phase: 'shadow-housekeeping-drain', error: String(err) });
      }

      if (removedDocsJournalTimer !== null) {
        clearTimeout(removedDocsJournalTimer);
        removedDocsJournalTimer = null;
      }
      if (removedDocsJournalWritable) {
        try {
          saveRemovedDocsJournal(projectDir, recentlyRemovedDocs.entries());
        } catch (err) {
          log.warn(
            { err },
            '[removed-docs-journal] failed to persist removal journal during shutdown',
          );
          phaseErrors.push({ phase: 'removed-docs-journal-flush', error: String(err) });
        }
      }

      let initTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const initSettled = await Promise.race([
        ready.then(
          () => 'completed' as const,
          (err) => {
            log.debug({ err }, '[server] init incomplete during shutdown');
            return 'failed' as const;
          },
        ),
        new Promise<'timeout'>((r) => {
          initTimeoutId = setTimeout(() => r('timeout'), preludeRemaining());
        }),
      ]);
      if (initTimeoutId !== undefined) clearTimeout(initTimeoutId);
      if (initSettled === 'timeout') {
        log.warn({}, '[server] init did not complete before the pre-flush deadline');
        phaseErrors.push({
          phase: 'initialization-drain',
          error: 'Initialization remains pending',
        });
      }

      let loadDrainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(hocuspocus.loadingDocuments.values()),
          new Promise<never>((_, reject) => {
            loadDrainTimer = setTimeout(
              () => reject(new Error('Pending document loads did not retire')),
              preludeRemaining(),
            );
          }),
        ]);
      } catch (err) {
        phaseErrors.push({ phase: 'document-load-drain', error: String(err) });
        log.error({ err }, '[server] shutdown document load drain failed');
      } finally {
        clearTimeout(loadDrainTimer);
      }

      const documentCount = hocuspocus.documents.size;
      const releaseWatcher = async (
        release: { unsubscribe(): Promise<void> } | null,
        watched: 'head' | 'content',
      ): Promise<void> => {
        if (release === null) return;
        try {
          await release.unsubscribe();
        } catch (err) {
          phaseErrors.push({
            phase: 'watcher-unsubscribe',
            error: err instanceof Error ? err.message : String(err),
          });
          log.error({ err, watched }, '[server] shutdown phase-1 watcher unsubscribe failed');
        }
      };

      try {
        try {
          if (inPlaceRescanTimer) {
            clearTimeout(inPlaceRescanTimer);
            inPlaceRescanTimer = null;
          }
          if (shadowWarmupTimer) {
            clearTimeout(shadowWarmupTimer);
            shadowWarmupTimer = null;
          }
          await releaseWatcher(headWatcher, 'head');
          headWatcher = null;
          await releaseWatcher(watcher, 'content');
          watcher = null;
          for (const { docName, cleanup } of configFileWatcherCleanups) {
            try {
              await cleanup();
            } catch (cfgErr) {
              log.warn(
                { err: cfgErr, docName },
                `[server] failed to stop config-file-watcher for ${docName}`,
              );
            }
          }
          configFileWatcherCleanups.length = 0;
          configFileWatcherResyncs.clear();

          try {
            cc1Broadcaster?.destroy();
            agentPresenceBroadcaster?.destroy();
            if (systemDocConnection) {
              await systemDocConnection.disconnect();
              systemDocConnection = null;
            }
            for (const [docName, connection] of configDocConnections) {
              try {
                await connection.disconnect();
              } catch (configErr) {
                log.warn(
                  { err: configErr, docName },
                  `[server] failed to disconnect ${docName} during shutdown`,
                );
              }
            }
            configDocConnections.clear();
          } catch (err) {
            phaseErrors.push({
              phase: 'cc1-teardown',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-1b CC1 teardown failed');
          }

          try {
            await sessionManager.closeAll();
          } catch (err) {
            phaseErrors.push({
              phase: 'agent-session-drain',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-2 agent session drain failed');
          }

          try {
            await destroyParsePool();
          } catch (err) {
            phaseErrors.push({
              phase: 'parse-pool-teardown',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-2b parse pool teardown failed');
          }

          try {
            await flushAllStoresAndWait(destroyTimeoutMs);
          } catch (err) {
            phaseErrors.push({
              phase: 'flush-all-stores',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-3 flush failed');
          }

          let derivedIndexCloseTimeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              derivedDocumentIndex.close(),
              new Promise<never>((_, reject) => {
                derivedIndexCloseTimeoutId = setTimeout(
                  () =>
                    reject(
                      new Error(`derived index close did not settle within ${graceShareMs}ms`),
                    ),
                  graceShareMs,
                );
              }),
            ]);
          } catch (err) {
            phaseErrors.push({
              phase: 'derived-index-close',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown derived-index close failed');
          } finally {
            if (derivedIndexCloseTimeoutId !== undefined) clearTimeout(derivedIndexCloseTimeoutId);
          }

          let l2TimeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                await persistence.flushPendingGitCommit();
                await persistence.waitForPendingCommits();
              })(),
              new Promise<void>((_, reject) => {
                l2TimeoutId = setTimeout(
                  () => reject(new Error('L2 git flush timeout')),
                  destroyTimeoutMs,
                );
              }),
            ]);
          } catch (err) {
            phaseErrors.push({
              phase: 'git-commit-flush',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-4 git commit flush failed');
          } finally {
            if (l2TimeoutId !== undefined) clearTimeout(l2TimeoutId);
          }
          try {
            if (syncEngine) {
              await syncEngine.destroy();
              syncEngine = null;
            }
          } catch (err) {
            phaseErrors.push({
              phase: 'sync-engine-stop',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown sync-engine-stop failed');
          }
        } finally {
          if (shadowRef.current) {
            let shadowDrainTimeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                shadowOpGateFor(shadowRef.current).drain(),
                new Promise<void>((_, reject) => {
                  shadowDrainTimeoutId = setTimeout(
                    () => reject(new Error('shadow mutator drain timeout')),
                    destroyTimeoutMs,
                  );
                }),
              ]);
            } catch (err) {
              phaseErrors.push({
                phase: 'shadow-mutator-drain',
                error: err instanceof Error ? err.message : String(err),
              });
              log.error({ err }, '[server] shutdown phase-5 shadow mutator drain failed');
            } finally {
              if (shadowDrainTimeoutId !== undefined) clearTimeout(shadowDrainTimeoutId);
            }

            try {
              const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 5_000 } });
              const currentHead = (await projectGit.revparse('HEAD')).trim();
              if (currentHead) {
                writeFileSync(
                  resolve(shadowRef.current.gitDir, 'last-known-head'),
                  currentHead,
                  'utf-8',
                );
              }
            } catch {}

            try {
              destroyShadowRepo(shadowRef.current);
            } catch (err) {
              phaseErrors.push({
                phase: 'shadow-repo-release',
                error: err instanceof Error ? err.message : String(err),
              });
              log.error({ err }, '[server] shutdown phase-5 destroyShadowRepo failed');
            }
          }

          if (authResult?.status === 'rejected') {
            const reason: unknown = authResult.reason;
            const failures = reason instanceof AggregateError ? reason.errors : [reason];
            phaseErrors.push({
              phase: 'local-op-subprocess-shutdown',
              error: failures
                .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
                .join('; '),
            });
            log.error({ err: reason }, '[server] shutdown local-op subprocess drain failed');
          }
          const durationMs = Date.now() - t0;
          if (phaseErrors.length === 0) {
            authorityRetired = true;
            try {
              authority.release();
            } catch (err) {
              phaseErrors.push({ phase: 'authority-release', error: String(err) });
              log.error({ err }, '[server] shutdown authority release failed');
            }
            log.info(
              { documentCount, durationMs },
              `[server] shutdown flushed ${documentCount} documents in ${durationMs}ms`,
            );
          } else {
            log.warn(
              { documentCount, durationMs, phaseErrors },
              `[server] shutdown flushed ${documentCount} documents in ${durationMs}ms with ${phaseErrors.length} phase error(s)`,
            );
          }
        }
      } finally {
        try {
          releaseServerLock(lockDir, { deferUnlinkToExit: true });
        } catch (err) {
          phaseErrors.push({
            phase: 'server-lock-release',
            error: err instanceof Error ? err.message : String(err),
          });
          log.error({ err }, '[server] shutdown phase-6 releaseServerLock failed');
        }
        try {
          await shutdownTelemetry();
        } catch (err) {
          phaseErrors.push({
            phase: 'telemetry-shutdown',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (authResult?.status === 'rejected') throw authResult.reason;
    })();

    return inflightDestroy;
  }

  const degraded: string[] = [];

  async function initAsync(): Promise<void> {
    try {
      loadedPrincipal = await loadPrincipal(projectDir);
      log.info({ principalId: loadedPrincipal.id }, '[server] principal loaded');
    } catch (e) {
      log.warn(
        { err: e },
        '[server] principal load failed — browser writes will use SERVICE_WRITER',
      );
    }

    if (!shadowRef.current) {
      try {
        shadowRef.current = await initShadowRepo(projectDir, { deferGcConfig: true });
        log.info(
          { gitDir: shadowRef.current.gitDir },
          `[server] history repo initialized at ${shadowRef.current.gitDir}`,
        );
        if (isShadowExcludesDegraded(shadowRef.current) && !degraded.includes('shadow-excludes')) {
          degraded.push('shadow-excludes');
        }
      } catch (e) {
        log.error({ err: e }, '[server] history repo init failed');
        degraded.push('shadow-repo');
      }
    }

    if (shadowRef.current) {
      try {
        const renameLogIndex = loadRenameLogIndex(shadowRef.current.gitDir);
        sweepLazyPopOrphans(shadowRef.current.gitDir, renameLogIndex);
        setRenameLogIndex(shadowRef.current.gitDir, renameLogIndex);
        bootRenameLogIndex = renameLogIndex;
        log.info(
          { entries: renameLogIndex.byTo.size },
          `[server] rename log loaded (${renameLogIndex.byTo.size} entries)`,
        );
      } catch (e) {
        log.warn(
          { err: e },
          '[rename-log] boot-time load/sweep failed; rename history unavailable',
        );
      }
    }

    if (shadowRef.current) {
      try {
        const sg = shadowGit(shadowRef.current);
        await sg.raw('rev-parse', '--git-dir');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not a git repository') || msg.includes('invalid object')) {
          log.warn({}, '[server] history repo appears corrupted — reinitializing');
          try {
            shadowRef.current = await initShadowRepo(projectDir, { deferGcConfig: true });
            if (
              isShadowExcludesDegraded(shadowRef.current) &&
              !degraded.includes('shadow-excludes')
            ) {
              degraded.push('shadow-excludes');
            }
          } catch (e2) {
            log.error({ err: e2 }, '[server] history repo reinit failed');
            shadowRef.current = undefined;
            if (!degraded.includes('shadow-repo')) degraded.push('shadow-repo');
          }
        } else {
          log.error({ err: e }, '[server] history repo check failed (transient?)');
        }
      }
    }

    if (shadowRef.current && inflightDestroy === null) {
      const warmShadow = shadowRef.current;
      const warmContentRoot = toPosix(relative(projectDir, contentDir)) || '.';
      shadowWarmupTimer = setTimeout(() => {
        shadowWarmupTimer = null;
        void buildWipTree(warmShadow, warmContentRoot).catch((e) => {
          log.debug({ err: e }, '[shadow] fan-out index warm-up failed (non-fatal)');
        });
      }, SHADOW_FANOUT_WARMUP_MS);
      shadowWarmupTimer.unref?.();
    }

    if (shadowRef.current) {
      try {
        const lastKnownHeadPath = resolve(shadowRef.current.gitDir, 'last-known-head');

        let lastKnownHead: string | null = null;
        try {
          lastKnownHead = readFileSync(lastKnownHeadPath, 'utf-8').trim() || null;
        } catch {}

        let currentHead: string | null = null;
        try {
          const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
          currentHead = (await projectGit.revparse('HEAD')).trim() || null;
        } catch {}

        if (currentHead !== null) {
          if (currentHead !== lastKnownHead) {
            let branch = 'main';
            try {
              const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
              const b = (await projectGit.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
              if (b && b !== 'HEAD') branch = b;
            } catch {}

            log.info(
              { lastKnownHead, currentHead, branch },
              `[head-drift] lastKnownHead=${lastKnownHead ?? 'null'}, currentHead=${currentHead}, action=import`,
            );

            try {
              await commitUpstreamImport(
                shadowRef.current,
                contentRoot ?? '',
                lastKnownHead,
                currentHead,
                branch,
              );
              incrementUpstreamImport();
            } catch (e) {
              log.warn({ err: e }, '[head-drift] commitUpstreamImport failed — continuing');
            }
          } else {
            log.info(
              { currentHead },
              `[head-drift] lastKnownHead=${lastKnownHead ?? 'null'}, currentHead=${currentHead}, action=noop`,
            );
          }

          try {
            writeFileSync(lastKnownHeadPath, currentHead, 'utf-8');
          } catch (e) {
            log.warn({ err: e }, '[head-drift] failed to write last-known-head');
          }
        }
      } catch (e) {
        log.warn({ err: e }, '[head-drift] check failed — continuing');
      }
    }

    try {
      const recovery = recoverPendingManagedRename(contentDir, projectDir);
      if (recovery.recovered && recovery.journal) {
        const fromPath =
          recovery.journal.version === 2
            ? recovery.journal.fromPath
            : recovery.journal.sourceDocName;
        const toPath =
          recovery.journal.version === 2
            ? recovery.journal.toPath
            : recovery.journal.destinationDocName;
        log.warn(
          {
            journalVersion: recovery.journal.version,
            fromPath,
            toPath,
            restoredDocNames: recovery.restoredDocNames,
          },
          `[managed-rename] recovered pending rename ${fromPath} -> ${toPath}`,
        );
      }
    } catch (err) {
      log.error({ err }, '[server] managed rename recovery failed');
      degraded.push('managed-rename-recovery');
    }

    try {
      const sweep = cleanupOrphanUploadTempfiles(projectDir);
      if (sweep.deleted > 0 || sweep.errors > 0) {
        log.info(
          {
            scanned: sweep.scanned,
            deleted: sweep.deleted,
            errors: sweep.errors,
          },
          `[upload-tempfile-sweep] swept ${sweep.deleted} orphan tempfile(s)`,
        );
      }
    } catch (err) {
      log.error({ err }, '[server] upload-tempfile sweep failed');
      degraded.push('upload-tempfile-sweep');
    }

    try {
      systemDocConnection = await hocuspocus.openDirectConnection(SYSTEM_DOC_NAME);
      cc1Broadcaster?.emitServerInfo(serverInstanceId, getReportedBranch() ?? undefined);
    } catch (err) {
      log.error(
        { err },
        '[server] failed to open __system__ direct connection — CC1 push disabled',
      );
      degraded.push('cc1-push');
    }

    const configDocNamesToBind = ephemeral ? [] : CONFIG_DOC_NAMES;

    for (const configDocName of configDocNamesToBind) {
      try {
        const connection = await hocuspocus.openDirectConnection(configDocName);
        configDocConnections.set(configDocName, connection);
      } catch (err) {
        log.error(
          { err, docName: configDocName },
          `[server] failed to open ${configDocName} direct connection — config bind degraded`,
        );
        degraded.push(`config-doc:${configDocName}`);
      }
    }

    const configPathByDoc = new Map<string, string>([
      [CONFIG_DOC_NAME_PROJECT, resolveConfigPath('project', projectDir)],
      [CONFIG_DOC_NAME_PROJECT_LOCAL, resolveConfigPath('project-local', projectDir)],
      [CONFIG_DOC_NAME_USER, resolveConfigPath('user', projectDir, configHomedirOverride)],
    ]);
    for (const configDocName of configDocNamesToBind) {
      const absPath = configPathByDoc.get(configDocName);
      if (!absPath) continue;
      try {
        log.info({ docName: configDocName, path: absPath }, '[config-file-watcher] starting');
        const takeInConfigChange = async (content: string): Promise<void> => {
          const document = hocuspocus.documents.get(configDocName);
          const alreadyApplied = isConfigEcho(
            configDocName,
            content,
            persistence.configPersistenceCtx,
          );
          log.info(
            {
              docName: configDocName,
              hasDocument: document !== undefined,
              contentLength: content.length,
            },
            '[config-file-watcher] file changed',
          );
          const outcome = await applyExternalConfigChange(
            document ?? null,
            configDocName,
            content,
            persistence.configPersistenceCtx,
          );
          log.info(
            { docName: configDocName, outcome, isEcho: alreadyApplied },
            '[config-file-watcher] applyExternalConfigChange outcome',
          );
          applyPersistedConfigToConsumers(configDocName);
          if (!alreadyApplied) {
            logConfigDiagnostics(configDocName);
          }
        };
        const cleanup = await startConfigFileWatcher(absPath, (content) => {
          void takeInConfigChange(content).catch((err: unknown) => {
            log.warn(
              { err, docName: configDocName },
              '[config-file-watcher] change handler failed',
            );
          });
        });
        configFileWatcherCleanups.push({ docName: configDocName, cleanup });
        configFileWatcherResyncs.set(configDocName, cleanup.resync);
        log.info({ docName: configDocName, path: absPath }, '[config-file-watcher] started');
      } catch (err) {
        log.warn(
          { err, docName: configDocName, path: absPath },
          `[config-file-watcher] failed to start for ${configDocName}`,
        );
        degraded.push(`config-file-watcher:${configDocName}`);
      }
    }

    if (!ephemeral) {
      let globalSkillNodesTimer: NodeJS.Timeout | null = null;
      const scheduleGlobalSkillNodesRefresh = (docName: string): void => {
        if (globalSkillNodesTimer !== null) clearTimeout(globalSkillNodesTimer);
        globalSkillNodesTimer = setTimeout(() => {
          globalSkillNodesTimer = null;
          void derivedDocumentIndex.refreshGlobalSkillNodes().catch((err) => {
            log.warn({ err, docName }, '[backlinks] global skill bundle re-ingest failed');
          });
        }, 300);
      };
      const reconcileManagedArtifactDisk = async (absPath: string, content: string) => {
        const docName = managedArtifactDocNameForPath(absPath, persistence.managedArtifactCtx);
        if (!docName) return;
        const document = hocuspocus.documents.get(docName);
        const outcome = await applyExternalManagedArtifactChange(
          document ?? null,
          docName,
          content,
          persistence.managedArtifactCtx,
        );
        log.info({ docName, outcome }, '[managed-artifact-watcher] external change');
        signalChannel('files');
        if (parseGlobalSkillBundleDoc(docName)) {
          scheduleGlobalSkillNodesRefresh(docName);
        }
      };

      const handleManagedArtifactUnlink = (absPath: string): void => {
        const docName = managedArtifactDocNameForPath(absPath, persistence.managedArtifactCtx);
        signalChannel('files');
        if (docName && parseGlobalSkillBundleDoc(docName)) {
          scheduleGlobalSkillNodesRefresh(docName);
        }
      };

      try {
        const skillsRoots = managedArtifactSkillsRoots(persistence.managedArtifactCtx);
        const skillsCleanup = await startManagedArtifactWatcher(
          skillsRoots,
          reconcileManagedArtifactDisk,
          handleManagedArtifactUnlink,
        );
        configFileWatcherCleanups.push({ docName: '__skill-files__', cleanup: skillsCleanup });
        log.info({ roots: skillsRoots }, '[managed-artifact-watcher] skills started');
      } catch (err) {
        log.warn({ err }, '[managed-artifact-watcher] skills failed to start');
        degraded.push('managed-artifact-watcher:skills');
      }

      try {
        const skillStatePath = skillStateYamlPath(homeFor(persistence.managedArtifactCtx));
        const skillStateCleanup = await startConfigFileWatcher(skillStatePath, () => {
          signalChannel('files');
        });
        configFileWatcherCleanups.push({ docName: '__skill-state__', cleanup: skillStateCleanup });
        log.info({ path: skillStatePath }, '[skill-state-watcher] started');
      } catch (err) {
        log.warn({ err }, '[skill-state-watcher] failed to start');
        degraded.push('skill-state-watcher');
      }
    }

    try {
      const okignorePath = resolve(contentDir, '.okignore');
      const gitignorePath = resolve(projectDir, '.gitignore');
      let gitInfoExcludePath: string | null = null;
      try {
        const probe = spawnSync(
          'git',
          ['rev-parse', '--git-common-dir'],
          withHiddenWindowsConsole({
            cwd: projectDir,
            encoding: 'utf-8',
            timeout: 5_000,
          }),
        );
        if (probe.status === 0 && probe.stdout) {
          const commonDir = resolve(projectDir, probe.stdout.trim());
          const candidate = join(commonDir, 'info', 'exclude');
          if (existsSync(dirname(candidate))) gitInfoExcludePath = candidate;
        }
      } catch {}
      const ignorePaths = gitInfoExcludePath
        ? [okignorePath, gitignorePath, gitInfoExcludePath]
        : [okignorePath, gitignorePath];
      const ignoreLog = log;
      ignoreLog.info(
        { okignorePath, gitignorePath, gitInfoExcludePath, ephemeral },
        '[ignore-watcher] starting multi-path watcher for .okignore + .gitignore (+ .git/info/exclude when present)',
      );
      const ignoreCleanup = ephemeral
        ? null
        : await startMultiPathConfigFileWatcher(ignorePaths, (changedPath, content) => {
            void (async () => {
              if (changedPath === okignorePath) {
                try {
                  const document = hocuspocus.documents.get(CONFIG_DOC_NAME_OKIGNORE) ?? null;
                  const outcome = await applyExternalConfigChange(
                    document,
                    CONFIG_DOC_NAME_OKIGNORE,
                    content,
                    persistence.configPersistenceCtx,
                  );
                  ignoreLog.info(
                    { docName: CONFIG_DOC_NAME_OKIGNORE, outcome },
                    '[ignore-watcher] applyExternalConfigChange outcome',
                  );
                } catch (err) {
                  ignoreLog.error(
                    { err, changedPath: relative(projectDir, changedPath) },
                    '[ignore-watcher] applyExternalConfigChange failed; rebuild proceeds independently',
                  );
                }
              }

              const result = await contentFilter.rebuildIgnorePatterns();
              if (result.ok) {
                ignoreLog.info(
                  {
                    changedPath: relative(projectDir, changedPath),
                    patternCount: result.patternCount,
                    nestedFileCount: result.nestedFileCount,
                    durationMs: result.durationMs,
                  },
                  '[ignore-watcher] rebuild succeeded — broadcasting files channel',
                );
                cc1Broadcaster?.signal('files');
              } else {
                const projectRelPath = relative(projectDir, changedPath) || '.';
                ignoreLog.warn(
                  { changedPath: projectRelPath, error: result.error.message },
                  '[ignore-watcher] rebuild failed — emitting config-ignore-nested-error',
                );
                cc1Broadcaster?.emitConfigIgnoreNestedError(projectRelPath, result.error.message);
              }
            })().catch((err) => {
              ignoreLog.error(
                { err, changedPath: relative(projectDir, changedPath) || '.' },
                '[ignore-watcher] handler threw',
              );
            });
          });
      if (ignoreCleanup) {
        configFileWatcherCleanups.push({ docName: '__ignore-files__', cleanup: ignoreCleanup });
        configFileWatcherResyncs.set(CONFIG_DOC_NAME_OKIGNORE, ignoreCleanup.resync);
        ignoreLog.info(
          { okignorePath, gitignorePath },
          '[ignore-watcher] multi-path watcher started',
        );
      }
    } catch (err) {
      log.warn(
        { err, projectDir, contentDir },
        '[ignore-watcher] failed to start multi-path watcher',
      );
      degraded.push('ignore-files-watcher');
    }

    const startupBranch = readProjectHeadState(projectDir).branch ?? 'main';
    switchReconciledBaseScope(startupBranch);
    resolveBranchScopeAligned();
    const derivedIndexStartup = derivedDocumentIndex.beginStartup(startupBranch);
    let derivedIndexStartupSettled = false;

    const indexesStartMono = performance.now();
    try {
      await withSpan('ok.boot.indexes', undefined, async () => {
        const deletedDocNames = await derivedIndexStartup.offlineDeletionsReady;
        let tombstonedOffline = 0;
        for (const deletedDocName of deletedDocNames) {
          if (isReservedForUserTree(deletedDocName)) continue;
          if (recentlyRemovedDocs.peek(deletedDocName)?.kind === 'renamed') continue;
          recentlyRemovedDocs.setDeleted(deletedDocName);
          tombstonedOffline++;
        }
        if (tombstonedOffline > 0) {
          log.info(
            { count: tombstonedOffline },
            '[removal-guard] tombstoned docs deleted while the server was down',
          );
        }
        offlineRemovalsReconciled.resolve();
        const { backlinkIndexDegraded } = await derivedIndexStartup.backlinksReady;
        if (backlinkIndexDegraded) degraded.push('backlink-index');
        const seedWalkStartMono = performance.now();
        const HOST_SKILLS_EVENT_RE = /^\.(?!ok\/)[A-Za-z0-9_-]+\/skills\//;
        let lastInPlaceDirs: ReadonlySet<string> = contentFilter
          ? new Set(scanInPlaceSkills(contentDir).map((skill) => skill.dir))
          : new Set<string>();
        const onRawBatch = (absPaths: readonly string[]): void => {
          if (
            !absPaths.some((p) =>
              HOST_SKILLS_EVENT_RE.test(relative(canonicalContentDir, p).split(sep).join('/')),
            )
          ) {
            return;
          }
          if (inPlaceRescanTimer) clearTimeout(inPlaceRescanTimer);
          inPlaceRescanTimer = setTimeout(() => {
            inPlaceRescanTimer = null;
            try {
              void resyncRecordedSkillCopies(projectDir, contentDir)
                .then((n) => {
                  if (n > 0) {
                    log.info({ refreshed: n }, '[in-place-skills] re-synced recorded copies');
                    cc1Broadcaster?.signal('files');
                  }
                })
                .catch((err) => log.warn({ err }, '[in-place-skills] copy re-sync failed'));
              const next = scanInPlaceSkillDirs(contentDir, lastInPlaceDirs);
              const changed =
                next.size !== lastInPlaceDirs.size ||
                [...next].some((d) => !lastInPlaceDirs.has(d));
              if (!changed) return;
              lastInPlaceDirs = next;
              void contentFilter
                .rebuildIgnorePatterns()
                .then((result) => {
                  if (result.ok) {
                    log.info(
                      { skillDirs: next.size },
                      '[in-place-skills] canonical set changed — filter rebuilt',
                    );
                    cc1Broadcaster?.signal('files');
                  } else {
                    log.warn(
                      { error: result.error.message },
                      '[in-place-skills] filter rebuild failed after skill re-scan',
                    );
                  }
                })
                .catch((err) => log.warn({ err }, '[in-place-skills] rebuild threw'));
            } catch (err) {
              log.warn({ err }, '[in-place-skills] re-scan trigger failed');
            }
          }, IN_PLACE_RESCAN_DEBOUNCE_MS);
        };
        watcher = await withSpan('ok.boot.seed-walk', undefined, async () =>
          startWatcher(canonicalContentDir, onDiskEvent, contentFilter, {
            onRawBatch,
            onRecoveryComplete: () => derivedDocumentIndex.recordInventoryReconciled(),
            onRecoveryPassCompleted: (pass, whole) => settleVanishedDocuments(pass, whole),
            nativeBackend: options.watcherBackend,
            clock: options.watcherClock,
            freshnessIntervalMs:
              options.freshnessIntervalMs === undefined
                ? FRESHNESS_BASE_INTERVAL_MS
                : options.freshnessIntervalMs,
          }),
        );
        void resyncRecordedSkillCopies(projectDir, contentDir)
          .then((n) => {
            if (n > 0) log.info({ refreshed: n }, '[in-place-skills] boot copy re-sync');
          })
          .catch((err) => log.warn({ err }, '[in-place-skills] boot copy re-sync failed'));
        {
          const home = configHomedirOverride ?? homedir();
          void scanGlobalInPlaceSkillsAsync(home)
            .then((inPlace) => resyncRecordedSkillCopies(home, home, inPlace))
            .then((n) => {
              if (n > 0) log.info({ refreshed: n }, '[in-place-skills] global boot copy re-sync');
            })
            .catch((err) => log.warn({ err }, '[in-place-skills] global copy re-sync failed'));
        }
        recordBootPhase('seedWalkMs', Math.round(performance.now() - seedWalkStartMono));

        {
          const sweepContentDir = resolve(contentDir);
          let healedJournalEntries = 0;
          for (const [removedDocName] of recentlyRemovedDocs.entries()) {
            if (!isSafeDocName(removedDocName)) continue;
            const filePath = resolve(
              sweepContentDir,
              `${removedDocName}${getDocExtension(removedDocName)}`,
            );
            if (isWithinDir(filePath, sweepContentDir) && existsSync(filePath)) {
              recentlyRemovedDocs.delete(removedDocName);
              healedJournalEntries++;
            }
          }
          if (healedJournalEntries > 0) {
            log.info(
              { count: healedJournalEntries },
              '[removal-guard] dropped journaled removal entries whose file re-appeared while the server was down',
            );
          }
        }
        const derivedIndexSettlement = await derivedDocumentIndex.settleStartupAfterWatcherSeed();
        derivedIndexStartupSettled = true;
        if (derivedIndexSettlement.tagIndexDegraded) degraded.push('tag-index');
        let seedSkipCount = 0;
        try {
          if (singleDocRelPath !== undefined) {
            seedSingleDirBasenameIndex({
              contentDir,
              basenameIndex,
              onSkip: (reason, code, path) => {
                seedSkipCount++;
                log.warn(
                  { reason, code, path },
                  `[basename-index] skipped entry during single-file seed (${reason}${code ? ` ${code}` : ''})`,
                );
              },
            });
          } else {
            await seedBasenameIndex({
              contentDir,
              contentFilter,
              basenameIndex,
              onSkip: (reason, code, path) => {
                seedSkipCount++;
                log.warn(
                  { reason, code, path },
                  `[basename-index] skipped entry during seed (${reason}${code ? ` ${code}` : ''})`,
                );
              },
            });
          }
          if (seedSkipCount > 0) {
            log.warn(
              { count: seedSkipCount },
              `[basename-index] startup seed completed with ${seedSkipCount} skipped entries — embeds under inaccessible subtrees will not resolve`,
            );
            degraded.push('basename-index-partial');
          }
        } catch (err) {
          log.error({ err }, '[basename-index] startup seed failed');
          degraded.push('basename-index');
        }
      });
    } catch (err) {
      log.error({ err }, '[server] disk bridge watcher failed to start');
      degraded.push('file-watcher');
      if (!derivedIndexStartupSettled) {
        const settlement = await derivedDocumentIndex.settleStartupAfterWatcherSeed();
        derivedIndexStartupSettled = true;
        if (settlement.tagIndexDegraded) degraded.push('tag-index');
      }
    } finally {
      recordBootPhase('indexesMs', Math.round(performance.now() - indexesStartMono));
      if (watcher) setBootField('fileCount', watcher.getFileIndex().size);
      refreshStartupEmbeds();
    }

    let releaseHeadBatchAdmission = () => {};
    try {
      headWatcher = await startHeadWatcher(
        projectDir,
        async ({ trigger }) => {
          log.info({ trigger }, `[batch] begin trigger=${trigger}`);
          incrementBatch();
          hocuspocus.flushPendingStores();
          await persistence.flushPendingGitCommit();

          holdBatch('head-watcher');
          releaseHeadBatchAdmission();
          releaseHeadBatchAdmission = durabilityState.holdWriteAdmission();

          if (shadowRef.current) {
            const currentBranch = getActiveBranch();
            const newBranch = readProjectHeadState(projectDir).branch ?? currentBranch;
            const docs: ParkableDoc[] = [];
            let absentBaseParkSkips = 0;
            for (const [docName, document] of hocuspocus.documents) {
              if (isReservedForUserTree(docName)) continue;
              let markdown: string | null = null;
              document.transact(() => {
                markdown = serializeDoc(docName);
              }, PARK_SNAPSHOT_ORIGIN);
              if (markdown === null) continue;
              const diskSnapshot = getReconciledBase(docName);
              if (diskSnapshot === undefined) {
                absentBaseParkSkips++;
                continue;
              }
              docs.push({ docName, markdown, diskSnapshot });
            }
            if (absentBaseParkSkips > 0) {
              log.warn(
                { count: absentBaseParkSkips, branch: currentBranch },
                `[history] skipped parking ${absentBaseParkSkips} doc(s) with no reconciled base; their content was not parked to the shadow history`,
              );
            }
            if (docs.length > 0) {
              try {
                const sha = await parkBranch(
                  shadowRef.current,
                  currentBranch,
                  SERVICE_WRITER.id,
                  docs,
                  newBranch,
                );
                if (sha) {
                  incrementPark();
                  log.info(
                    { count: docs.length, branch: currentBranch, sha: sha.slice(0, 8) },
                    `[history] parked ${docs.length} docs on ${currentBranch} → ${sha.slice(0, 8)}`,
                  );
                }
              } catch (e) {
                log.error({ err: e }, '[shadow] park failed');
              }
            }
          }
        },
        async (info) => {
          const bufferedCount = eventBuffer.length;
          const newBranch = info.newBranch ?? 'main';

          log.info(
            {
              kind: info.batchKind,
              headMoved: info.headMoved,
              docs: bufferedCount,
              timeout: !!info.timeout,
            },
            `[batch] end kind=${info.batchKind} headMoved=${info.headMoved} docs=${bufferedCount}${info.timeout ? ' timeout' : ''}`,
          );

          if (info.batchKind === 'within-branch') {
            try {
              try {
                await drainEventBuffer();
              } finally {
                disposeBufferedRemovalScopes();
              }

              if (info.headMoved && info.newHead) {
                const changes = resolveUpstreamChanges(
                  projectDir,
                  resolve(contentDir),
                  info.oldHead,
                  info.newHead,
                );
                if (changes.size > 0) {
                  dropPendingDocs(changes.keys());
                  for (const [docName, author] of changes) {
                    recordContributor(
                      docName,
                      gitAuthorWriterId(author.email),
                      author.name,
                      author.email,
                      formatReconcileSubject(docName),
                    );
                  }
                  await persistence.flushContributors();
                }
              }
            } finally {
              try {
                if (releaseBatchHold('head-watcher')) await finishBatch();
              } finally {
                releaseHeadBatchAdmission();
              }
            }
            try {
              await conflicts.pruneMergeNativeAgainstGit();
            } catch (err) {
              log.warn({ err }, '[head-watcher] conflict prune against git failed');
            }
          } else {
            incrementBranchSwitch();
            supersedeBranchSwitchFollowUps();
            let batchReleased = false;
            let switchPassFellShort = false;
            let branchTransition: DerivedDocumentIndexBranchTransition | undefined;
            try {
              switchReconciledBaseScope(newBranch);
              conflicts.setBranch(newBranch);
              hydrateStaleExternalWrites();
              branchTransition = await derivedDocumentIndex.beginBranchSwitch(newBranch);

              contentFilter.rebuildDirCount();

              try {
                let reseedSkipCount = 0;
                basenameIndex.clear();
                await seedBasenameIndex({
                  contentDir,
                  contentFilter,
                  basenameIndex,
                  onSkip: (reason, code, path) => {
                    reseedSkipCount++;
                    log.warn(
                      { reason, code, path, branch: newBranch },
                      `[basename-index] skipped entry during branch-switch reseed (${reason}${code ? ` ${code}` : ''})`,
                    );
                  },
                });
                if (reseedSkipCount > 0) {
                  log.warn(
                    { count: reseedSkipCount, branch: newBranch },
                    `[basename-index] branch-switch reseed completed with ${reseedSkipCount} skipped entries — embeds under inaccessible subtrees will not resolve on this branch`,
                  );
                  if (!degraded.includes('basename-index-partial')) {
                    degraded.push('basename-index-partial');
                  }
                }
              } catch (err) {
                log.error(
                  { err, branch: newBranch },
                  '[basename-index] branch-switch reseed failed',
                );
              }

              try {
                await derivedDocumentIndex.settleBranchFromDisk(branchTransition);
              } catch (err) {
                derivedDocumentIndex.abortBranchSwitch(branchTransition);
                log.error(
                  { err, branch: newBranch },
                  '[derived-index] branch-switch rebuild failed; relationship views may be stale',
                );
              }

              try {
                await drainEventBuffer();
                const switchPass = await watcher?.recheck('full');
                if (switchPass && (switchPass.status !== 'completed' || switchPass.partial)) {
                  switchPassFellShort = true;
                  incrementBranchSwitchRecheckShortfalls();
                  log.warn(
                    {
                      branch: newBranch,
                      status: switchPass.status,
                      partial: switchPass.partial === true,
                    },
                    `[branch-switch] the re-check after switching to ${newBranch} did not observe the whole tree; another one runs once the switch ends`,
                  );
                }
                await drainEventBuffer();
              } finally {
                disposeBufferedRemovalScopes();
              }
              tombstoneResidentsResolvingIntoPrivateState(newBranch);
              log.info(
                { branch: newBranch, docCount: hocuspocus.documents.size },
                `[branch-switch] loaded branch ${newBranch} (${hocuspocus.documents.size} docs)`,
              );

              if (info.oldBranch?.startsWith('detached-') && shadowRef.current) {
                try {
                  const sg = shadowGit(shadowRef.current);
                  const refs = (
                    await sg.raw(
                      'for-each-ref',
                      `refs/wip/${info.oldBranch}/`,
                      '--format=%(refname)',
                    )
                  ).trim();
                  if (refs) {
                    await shadowOpGateFor(shadowRef.current).withMutator(async () => {
                      for (const ref of refs.split('\n')) {
                        if (ref) {
                          await sg.raw('update-ref', '-d', ref);
                        }
                      }
                    });
                    log.info(
                      { context: info.oldBranch },
                      `[branch-switch] cleaned up detached context ${info.oldBranch}`,
                    );
                  }
                } catch (e) {
                  log.error({ err: e }, '[branch-switch] detached cleanup failed');
                }
              }

              batchReleased = true;
              if (releaseBatchHold('head-watcher')) await finishBatch();
              cc1Broadcaster?.emitBranchSwitched(newBranch);
              if (switchPassFellShort) followUpBranchSwitchRecheck(newBranch);
            } finally {
              try {
                derivedDocumentIndex.abortBranchSwitch(branchTransition);
                if (!batchReleased && releaseBatchHold('head-watcher')) await finishBatch();
              } finally {
                releaseHeadBatchAdmission();
              }
            }
          }

          if (info.headMoved && info.newHead && shadowRef.current && bufferedCount > 0) {
            const contentRootForShadow = contentRoot ?? '.';
            try {
              const sha = await commitUpstreamImport(
                shadowRef.current,
                contentRootForShadow,
                info.oldHead,
                info.newHead,
                newBranch,
              );
              incrementUpstreamImport();
              log.info(
                {
                  oldHead: info.oldHead?.slice(0, 8) ?? 'null',
                  newHead: info.newHead.slice(0, 8),
                  sha: sha.slice(0, 8),
                },
                `[history] upstream-import from ${info.oldHead?.slice(0, 8) ?? 'null'}..${info.newHead.slice(0, 8)} → ${sha.slice(0, 8)}`,
              );
            } catch (e) {
              log.error({ err: e }, '[shadow] upstream-import failed');
            }
          }
        },
        {
          nativeBackend: options.watcherBackend,
          clock: options.watcherClock,
          onGaveUp: () => {
            if (!degraded.includes('head-watcher')) degraded.push('head-watcher');
          },
          onBack: () => {
            const at = degraded.indexOf('head-watcher');
            if (at !== -1) degraded.splice(at, 1);
          },
        },
      );
    } catch (err) {
      log.error({ err }, '[server] HEAD watcher failed to start');
      degraded.push('head-watcher');
    }

    conflicts.subscribe((change) => {
      if (change.type !== 'raised') return;
      if (change.conflict.kind === 'reconcile') return;
      const docName = change.docName;
      if (docName === null) return;
      if (!hocuspocus.documents.get(docName)) return;
      const ours = serializeDoc(docName);
      if (ours !== null) {
        setReconciledBase(docName, ours);
      } else {
        log.warn(
          { docName, file: change.conflict.file },
          '[sync] content conflict: serializeDoc returned null; reconciledBase snapshot skipped',
        );
      }
    });

    try {
      await conflicts.pruneMergeNativeAgainstGit();
    } catch (err) {
      log.warn({ err }, '[conflicts] boot prune of merge-native entries failed');
    }

    const syncCredentialConfig = await resolveSyncCredentialConfig();
    const bootAutoSyncMode = readProjectAutoSyncMode();
    const bootAutoSyncIntervals = readProjectAutoSyncIntervals();
    if (bootAutoSyncMode.mode !== 'off') {
      log.info(
        { mode: bootAutoSyncMode.mode, source: bootAutoSyncMode.source },
        '[sync] mode active at boot',
      );
    }
    try {
      syncEngine = new SyncEngine({
        declaredGitHubHosts,
        projectDir,
        contentDir,
        contentFilter,
        contentRoot,
        mcpTomlEditor: options.mcpTomlEditor,
        mode: bootAutoSyncMode.mode,
        pullIntervalSeconds:
          options.pullIntervalSeconds ?? bootAutoSyncIntervals.pullIntervalSeconds,
        pushIntervalSeconds:
          options.pushIntervalSeconds ?? bootAutoSyncIntervals.pushIntervalSeconds,
        credentialConfig: syncCredentialConfig,
        resolveCredentialConfig: resolveSyncCredentialConfig,
        cc1Broadcaster,
        conflicts,
        detectGh: options.detectGh,
        detectGhAccounts: options.detectGhAccounts,
        tokenStore: options.tokenStore,
        checkPushPermissionFn: options.checkPushPermissionFn,
        setBatchInProgress: batchFlagFor('sync-engine'),
        onStateChange: (state) => {
          log.info({ state }, `[sync] state → ${state}`);
        },
        checkpointBeforeStrandedConversion: async ({ branch, ahead }) => {
          const shadow = shadowRef.current;
          if (!shadow) return;
          await safetyCheckpoint(
            shadow,
            contentRoot ?? '',
            { action: 'pull-only-stranded-conversion', context: { ahead } },
            branch,
          );
        },
        checkpointBeforeOverlayRestore: async ({ branch, paths }) => {
          const shadow = shadowRef.current;
          if (!shadow) return;
          await safetyCheckpoint(
            shadow,
            contentRoot ?? '',
            { action: 'pull-only-overlay-restore', context: { paths } },
            branch,
          );
        },
        onAutoDisable: async (reason) => {
          log.warn({ reason }, '[sync] auto-disabled — persisting to project-local config');
          const result = await writeConfigPatch({
            cwd: projectDir,
            scope: 'project-local',
            patch: { autoSync: { enabled: false } },
          });
          if (!result.ok) {
            log.error(
              {
                result,
                reason,
                humanError: humanFormat(result.error),
                configPath: resolveConfigPath('project-local', projectDir),
              },
              '[sync] failed to persist auto-disable — next restart WILL re-enable sync and re-trigger the same failure. Check permissions on the config path.',
            );
          }
        },
      });
      await syncEngine.start();
    } catch (err) {
      log.warn({ err }, '[server] SyncEngine failed to start — sync disabled');
      syncEngine = null;
    }

    signalChannel('files');
    derivedDocumentIndex.announceReadyViews();

    const readyElapsed = bootElapsedMs();
    if (readyElapsed !== undefined) recordBootPhase('readyMs', readyElapsed);

    logConfigDiagnostics();
  }

  initAsync().then(
    () => {
      indexRegenerationReady = true;
      resolveReady();
      setImmediate(() => {
        const pruned = diskReceipts.pruneGone(receiptFileIsGone);
        if (pruned > 0)
          log.info({ pruned }, `[disk-receipts] dropped ${pruned} receipt(s) whose file is gone`);
      }).unref();
      deferBootIndexSweep();
      deferShadowHousekeeping();
    },
    (err) => {
      indexRegenerationClosed = true;
      indexRegenerationAbort.abort();
      settleGeneratedIndexSweep({ status: 'failed', indexCount: 0 });
      void derivedDocumentIndex.close();
      resolveBranchScopeAligned();
      rejectReady(err);
    },
  );

  return {
    hocuspocus,
    durabilityState,
    sessionManager,
    nativeApi,
    localApi,
    cc1Broadcaster,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    contentFilter,
    basenameIndex,
    serverInstanceId,
    destroy,
    ready,
    generatedIndexSweepReady,
    degraded,
    lockDir,
    get syncEngine() {
      return syncEngine;
    },
    conflicts,
    getLinkPreviewsEnabled: readLinkPreviewsEnabled,
    resolveEmbed,
    resolveTrackedFile,
    acpRegistry,
    acpPermissions,
    recheckDisk: () => {
      if (!watcher) {
        return Promise.reject(
          new Error('the file watcher is not running, so there is nothing to re-check'),
        );
      }
      return watcher.recheck();
    },
  };
}
