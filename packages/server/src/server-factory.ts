import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
  type ConfigIssue,
  createBasenameIndex,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DOCUMENT_OPEN_BYTE_LIMIT,
  humanFormat,
  isKnownConfigError,
  type LinksValidationSetting,
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
  formatReconcileSubject,
  gitAuthorWriterId,
  resolveGitDir,
  resolveShadowDir,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { AcpPermissionStore } from './acp/permissions.ts';
import { AcpRegistry, loadCustomAgents } from './acp/registry.ts';
import { AgentFocusBroadcaster } from './agent-focus.ts';
import { AgentPresenceBroadcaster } from './agent-presence.ts';
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
  isManagedArtifactDoc,
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
import { applyExternalConfigChange } from './config-persistence.ts';
import { isDocInConflict } from './conflict-errors.ts';
import {
  createConflictLifecycleSeedExtension,
  entryMatchesDocName,
} from './conflict-lifecycle-seed.ts';
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
import { type ContentFilter, createContentFilter } from './content-filter.ts';
import { isWithinContentDir, safeContentPath } from './content-path.ts';
import { dropPendingDocs, recordContributor } from './contributor-tracker.ts';
import {
  DerivedDocumentIndex,
  type DerivedDocumentIndexBranchTransition,
} from './derived-document-index.ts';
import { applyDiskContentToDoc } from './disk-content-intake.ts';
import {
  canonicalDocName,
  docNameToRelativePath,
  getDocExtension,
  stripDocExtension,
} from './doc-extensions.ts';
import { runDocLineageGuard } from './doc-lineage-guard.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import {
  type Embedder,
  type EmbeddingsKeyStore,
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
  serializeYDocSource,
} from './external-change.ts';
import {
  assertNeverDiskEvent,
  contentHash,
  type DiskEvent,
  pathToDocName,
  reconcileFileIndexAfterFilterRebuild,
  registerWrite,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import { normalizeFsPath, tracedAtomicFs, tracedMkdirSync } from './fs-traced.ts';
import { buildSyncCredentialConfig } from './git-handle.ts';
import type {
  CheckPushPermissionOptions,
  DetectGhAccountsFn,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { type HeadWatcherHandle, readProjectHeadState, startHeadWatcher } from './head-watcher.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { NativeApiHandle } from './http/http-app.ts';
import type { LocalApiDispatch } from './http/local-api-dispatch.ts';
import type { GeneratedIndexSettingsStatus } from './http/workspace-tools-routes.ts';
import {
  scanGlobalInPlaceSkills,
  scanInPlaceSkillDirs,
  skillRootPathsFor,
} from './in-place-skills.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import { ensureOkfSchemaFiles } from './lint/write-okf-schemas.ts';
import { createLiveDerivedIndexExtension } from './live-derived-index.ts';
import { localTargetInventoryFromWatcher } from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
import { LossCaptureRing } from './loss-capture.ts';
import {
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
} from './maintenance-coordinator.ts';
import {
  applyExternalManagedArtifactChange,
  homeFor,
  managedArtifactDocNameForPath,
  managedArtifactSkillsRoots,
} from './managed-artifact-persistence.ts';
import { startManagedArtifactWatcher } from './managed-artifact-watcher.ts';
import { recoverPendingManagedRename } from './managed-rename-journal.ts';
import type { NativeTomlMcpEditor } from './mcp-config-reconciler.ts';
import { mdManager, schema } from './md-manager.ts';
import {
  incrementBatch,
  incrementBranchSwitch,
  incrementConflict,
  incrementPark,
  incrementRecentlyRemovedDocsEviction,
  incrementReconcile,
  incrementRescueBuffer,
  incrementUpstreamImport,
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
import { reconcile } from './reconciliation.ts';
import { reconcileRecoveredFileTarget } from './recovered-file-target.ts';
import { runRemovalRedirectGuard } from './removal-redirect-guard.ts';
import { loadRemovedDocsJournal, saveRemovedDocsJournal } from './removed-docs-journal.ts';
import {
  gcRenameLog,
  loadRenameLogIndex,
  setRenameLogIndex,
  sweepLazyPopOrphans,
} from './rename-log.ts';
import { acquireServerLock, markServerLockDraining, releaseServerLock } from './server-lock.ts';
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
  initShadowRepo,
  OK_GENERATOR_WRITER,
  type ParkableDoc,
  parkBranch,
  readParkedState,
  SERVICE_WRITER,
  type ShadowHandle,
  type ShadowRef,
  safetyCheckpoint,
  saveInMemoryCheckpoint,
  shadowGit,
} from './shadow-repo.ts';
import { readOriginGitHubRepo, shouldResetAmbientCredentials } from './share/git-context.ts';
import { resyncRecordedSkillCopies } from './skill-placements.ts';
import { assertCompatibleStateManifest } from './state-manifest.ts';
import { SyncEngine } from './sync-engine.ts';
import { createSyncHandshakeSpanExtension } from './sync-handshake-span-extension.ts';
import { initTelemetry, shutdownTelemetry, withSpan } from './telemetry.ts';
import { trustSystemCertificates } from './trust-system-ca.ts';
import { cleanupOrphanUploadTempfiles } from './upload-streaming.ts';

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
  onAgentWrite?: () => void;
  localOpCliArgs?: string[];
  authStreamHeartbeatMs?: number;
  lockKind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
  skipStateManifestCheck?: boolean;
  configHomedirOverride?: string;
  mdManager?: MarkdownManager;
  detectGh?: DetectGhFn;
  detectGhAccounts?: DetectGhAccountsFn;
  tokenStore?: ProbeTokenStore | null;
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  pullIntervalSeconds?: number;
  pushIntervalSeconds?: number;
  embeddingsKeyStore?: EmbeddingsKeyStore | null;
  embedderLoader?: () => Promise<Embedder | null>;
  singleDocRelPath?: string;
  ephemeral?: boolean;
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
  readonly getLinkPreviewsEnabled: () => boolean;
  readonly resolveEmbed: (basename: string, sourcePath: string) => string | null;
  readonly acpRegistry: AcpRegistry;
  readonly acpPermissions: AcpPermissionStore;
}

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

  const log = getLogger('server');
  const durabilityState = new DocumentDurabilityState();
  const getActiveBranch = () => durabilityState.getActiveBranch();
  const getReconciledBase = (docName: string) => durabilityState.getReconciledBase(docName);
  const setReconciledBase = (docName: string, content: string) =>
    durabilityState.setReconciledBase(docName, content);
  const deleteReconciledBase = (docName: string) => durabilityState.deleteReconciledBase(docName);
  const switchReconciledBaseScope = (branch: string) =>
    durabilityState.switchReconciledBaseScope(branch);
  const setBatchInProgress = (value: boolean) => durabilityState.setBatchInProgress(value);
  const isBatchInProgress = () => durabilityState.isBatchInProgress();

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

  function readLinksValidationSetting(): LinksValidationSetting {
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) =>
        log.warn({ message }, '[config] could not read project config for link validation'),
    });
    return project.value.validation?.links ?? DEFAULT_LINKS_VALIDATION;
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

  function logConfigDiagnosticsOnce(): void {
    for (const finding of readConfigDiagnostics().diagnostics) {
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

  let lastAppliedAttachmentFolderPath: string | undefined;

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
    });
    if (configDocName === CONFIG_DOC_NAME_PROJECT) {
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

  const lockDir = getLocalDir(projectDir);

  const acpRegistry = new AcpRegistry({
    localDir: lockDir,
    log: getLogger('acp-registry'),
    fetchImpl: options.acpRegistryFetchImpl,
  });
  const acpPermissions = new AcpPermissionStore(lockDir, getLogger('acp-permissions'));

  acquireServerLock(lockDir, {
    port: 0,
    worktreeRoot: projectDir,
    kind: options.lockKind ?? 'interactive',
    capabilities: options.capabilities ?? ['http', 'ws'],
  });

  if (!skipStateManifestCheck) {
    try {
      assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir: resolveShadowDir(projectDir),
      });
    } catch (err) {
      releaseServerLock(lockDir);
      throw err;
    }
  }

  const basenameIndex: BasenameIndex = createBasenameIndex();

  const resolveEmbed = (basename: string, sourcePath: string): string | null =>
    basenameIndex.resolveEmbed(basename, sourcePath);

  const resolveSize = (basename: string, sourcePath: string): number | null => {
    let candidatePath: string | null = basenameIndex.resolveEmbed(basename, sourcePath);
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
  let bridgeLossReporter: BridgeDeriveLossReporter | undefined;
  let cc1Broadcaster: CC1Broadcaster | null = null;
  let inPlaceRescanTimer: ReturnType<typeof setTimeout> | null = null;
  const IN_PLACE_RESCAN_DEBOUNCE_MS = 500;
  let agentFocusBroadcaster: AgentFocusBroadcaster | null = null;
  let agentPresenceBroadcaster: AgentPresenceBroadcaster | null = null;
  let invalidateReferencedAssetsCache: (() => void) | null = null;
  let stalenessWatchdog: StalenessWatchdogHandle | null = null;

  const initialSemanticConfig = readSemanticSearchConfig();
  const semanticSearch = new SemanticSearchService({
    loadEmbedder:
      options.embedderLoader ??
      (() => {
        const cfg = readSemanticSearchConfig();
        return loadOpenAiEmbedder({
          keyStore: options.embeddingsKeyStore ?? null,
          projectDir,
          config: { baseUrl: cfg.baseUrl, model: cfg.model, dimensions: cfg.dimensions },
        });
      }),
    cacheDir: join(getLocalDir(projectDir), 'embeddings'),
    enabled: initialSemanticConfig.enabled,
    providerFingerprint: semanticProviderFingerprint(initialSemanticConfig),
  });

  let loadedPrincipal: Principal | null = null;
  const forceUnloadSet = new Set<Document>();
  let shutdownAllowsUnload = false;
  const unregisterWorkloadProviders: Array<() => void> = [];
  let forceUnloadDocument!: (document: Document) => Promise<void>;

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

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
    isConflict: (docName) =>
      syncEngine
        ?.getConflicts()
        .some((entry) => entryMatchesDocName(entry, docName, projectDir, contentDir)) === true,
    getDocument: (docName) => hocuspocus.documents.get(docName),
    writeDisk: async (absPath, markdown) => {
      tracedMkdirSync(dirname(absPath), { recursive: true });
      await atomicWriteFile(absPath, markdown, { fs: tracedAtomicFs });
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
      applyExternalConfigChange(
        hocuspocus.documents.get(CONFIG_DOC_NAME_PROJECT) ?? null,
        CONFIG_DOC_NAME_PROJECT,
        content,
        persistence.configPersistenceCtx,
      );
    } catch (err) {
      log.warn({ err }, '[index] generated-index settings reflection deferred to config watcher');
    }
    applyPersistedConfigToConsumers(CONFIG_DOC_NAME_PROJECT, enabled);
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
    commentDocHooksRef.current?.deleted(docName);
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
      singleDocRelPath,
      attachmentFolderPath: initialAttachmentFolderPath,
      inPlaceSkillDirs: scanInPlaceSkillDirs(contentDir),
      rescanInPlaceSkillDirs: () => scanInPlaceSkillDirs(contentDir),
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
      getLocalTargetInventory: () => localTargetInventoryFromWatcher(watcher, contentDir),
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
          getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
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
      projectDir,
      gitEnabled,
      commitDebounceMs,
      wipRef,
      shadowRef,
      ephemeral,
      contentRoot,
      derivedDocumentIndex,
      configHomedirOverride,
      getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
      resolveEmbed,
      resolveSize,
      getPrincipal: () => loadedPrincipal,
      onAgentCommit: () => cc1Broadcaster?.signal('session-activity'),
      onFlushCommit: () => maintenanceCoordinator?.noteFlushCommit(),
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
      onConfigPersisted: applyPersistedConfigToConsumers,
      onManagedSkillPersisted: (docName) => {
        const parsed = parseManagedArtifactName(docName);
        if (parsed?.kind !== 'skill' || parsed.scope !== 'global') return;
        if (globalCopyResyncTimer !== null) clearTimeout(globalCopyResyncTimer);
        globalCopyResyncTimer = setTimeout(() => {
          globalCopyResyncTimer = null;
          const home = configHomedirOverride ?? homedir();
          void resyncRecordedSkillCopies(home, home, scanGlobalInPlaceSkills(home))
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
    };

    persistence = createPersistenceExtension({ ...persistenceOpts, durabilityState });

    hocuspocus = new Hocuspocus({
      quiet,
      debounce,
      maxDebounce,
      extensions: [persistence.extension],
    });

    const openDirect = hocuspocus.openDirectConnection.bind(hocuspocus);
    hocuspocus.openDirectConnection = ((documentName: string, context?: unknown) =>
      openDirect(
        canonicalDocName(documentName),
        context,
      )) as typeof hocuspocus.openDirectConnection;

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
        forceStore: (document, documentName) => persistence.forceStore(document, documentName),
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
          if (!isWithinContentDir(canonical, contentDir)) {
            throw new StructuralDiskReadError(
              `symlink-escape: ${requestedPath} resolves outside the content dir`,
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

    const defaultShouldUnloadDocument = hocuspocus.shouldUnloadDocument.bind(hocuspocus);
    hocuspocus.shouldUnloadDocument = (document) => {
      if (forceUnloadSet.has(document)) {
        return true;
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

    forceUnloadDocument = async (document: Document): Promise<void> => {
      forceUnloadSet.add(document);
      try {
        await hocuspocus.unloadDocument(document);
      } finally {
        forceUnloadSet.delete(document);
      }
    };

    cc1Broadcaster = new CC1Broadcaster(hocuspocus);
    agentFocusBroadcaster = new AgentFocusBroadcaster(hocuspocus);
    agentPresenceBroadcaster = new AgentPresenceBroadcaster(hocuspocus);

    sessionManager = new AgentSessionManager(hocuspocus, options.agentSessionOptions);
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
      async onAuthenticate(payload) {
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

    const resolvedContentDir = resolve(contentDir);
    function resolveDocFilePath(docName: string): string | null {
      if (!isSafeDocName(docName)) return null;
      const relativePath = docNameToRelativePath(docName);
      const filePath = resolve(resolvedContentDir, relativePath);
      if (!isWithinDir(filePath, resolvedContentDir)) {
        return null;
      }
      return filePath;
    }
    const removalRedirectGuard: Extension & { __kind: 'removal-redirect-guard' } = {
      __kind: 'removal-redirect-guard',
      async onAuthenticate(payload) {
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

    const apiExtension = createApiExtension({
      hocuspocus,
      durabilityState,
      ingressPolicy,
      sessionManager,
      commentDocHooksRef,
      contentDir,
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
          case 'conflict':
            scheduleIndexRegeneration(event.docName);
            break;
          case 'delete':
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
      rescanFiles: () => watcher?.rescanFromDisk(),
      enableTestRoutes,
      shadowRef,
      flushGitCommit: () => persistence.flushPendingGitCommit(),
      flushContributors: () => persistence.flushContributors(),
      getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
      getDiskAckSVs: () => cc1Broadcaster?.getLatestDiskAckSVsAsBase64() ?? {},
      getCollabClientCount: options.getCollabClientCount,
      contentRoot,
      derivedDocumentIndex,
      signalChannel,
      agentFocusBroadcaster,
      agentPresenceBroadcaster,
      onAgentWrite: options.onAgentWrite,
      getSyncEngine: () => syncEngine,
      localOpCliArgs,
      authStreamHeartbeatMs,
      projectDir,
      resolveEmbed,
      getBridgeLossReporter: () => bridgeLossReporter,
      getPrincipal: () => loadedPrincipal,
      acpRegistry,
      loadAcpCustomAgents: () => loadCustomAgents(lockDir, getLogger('acp-registry')),
      homeDirOverride: configHomedirOverride,
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
      getLinksValidationSetting: () => readLinksValidationSetting(),
      getLinkPreviewsEnabled: readLinkPreviewsEnabled,
      getConfigDiagnostics: readConfigDiagnostics,
      embeddingsSecretsFile: secretsFilePath(configHomedirOverride),
      readSemanticProviderConfig: readSemanticSearchConfig,
      ephemeral,
      onReferencedAssetsCacheInvalidator: (invalidate) => {
        invalidateReferencedAssetsCache = invalidate;
      },
    });
    hocuspocus.configuration.extensions.push(apiExtension);
    nativeApi = apiExtension.nativeApi;
    localApi = apiExtension.localApi;

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
        getBranch: () => headWatcher?.getLastKnownBranch() ?? 'main',
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
        getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
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

    hocuspocus.configuration.extensions.push(
      createConflictLifecycleSeedExtension({
        getSyncEngine: () => syncEngine,
        projectDir,
        contentDir,
      }),
    );
  } catch (err) {
    for (const unregister of unregisterWorkloadProviders.splice(0)) {
      unregister();
    }
    void stalenessWatchdog?.dispose();
    stalenessWatchdog = null;
    releaseServerLock(lockDir);
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

  const applyToDoc = (docName: string, content: string): void =>
    applyExternalChange(
      durabilityState,
      hocuspocus,
      docName,
      content,
      resolveEmbed,
      resolveSize,
      bridgeLossReporter,
    );

  function clearLifecycleConflict(document: Document): void {
    if (!isDocInConflict(document)) return;
    if (
      syncEngine
        ?.getConflicts()
        .some((entry) => entryMatchesDocName(entry, document.name, projectDir, contentDir))
    ) {
      return;
    }
    const lifecycleMap = document.getMap('lifecycle');
    lifecycleMap.delete('status');
    lifecycleMap.delete('reason');
  }

  const rerenderDocsReferencingAssetBasename = (assetBasename: string): void => {
    if (!assetBasename) return;
    const needle = `[[${assetBasename}]]`;
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
      } catch (err) {
        log.error(
          { err, docName, assetBasename },
          `[asset-event] failed to re-render ${docName} for asset basename ${assetBasename}`,
        );
      }
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

  const rescueUnflushedEditsBeforeTeardown = (
    docName: string,
    branch: string,
    site: 'delete' | 'rename' | 'branch-switch',
  ): boolean => {
    const base = getReconciledBase(docName) ?? '';
    const ours = serializeDoc(docName) ?? '';
    const isDirty = ours !== base;
    if (!isDirty || !shadowRef.current) return isDirty;
    const shadowForCheckpoint = shadowRef.current;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadowForCheckpoint, contentRoot ?? '', {
        kind: 'external-change-rescue',
        docName,
        contents: ours,
        label: `External change recovered @ ${new Date().toISOString()}`,
        branch,
        metadata: { incomingDiskSha: '' },
      })
        .then(() => {
          incrementRescueBuffer();
          log.info({ docName, site }, `[reconcile] rescue checkpoint saved (${site}): ${docName}`);
        })
        .catch((e: unknown) => {
          log.error({ docName, err: e }, `[reconcile] rescue checkpoint write failed: ${docName}`);
        });
    });
    return isDirty;
  };

  async function handleDiskEvent(event: DiskEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'create': {
          log.info({ docName: event.docName }, `[reconcile] create: ${event.docName}`);
          await derivedDocumentIndex.recordDiskUpsert(event.docName, event.content);
          signalChannel('files');
          scheduleIndexRegeneration(event.docName);
          onUpstreamAdd(event.docName);
          break;
        }

        case 'update': {
          const { docName, content: theirs } = event;
          if (indexedMetadataChanged(event.previousIndexedFields, theirs, docName)) {
            scheduleIndexRegeneration(docName);
          }
          const document = hocuspocus.documents.get(docName);
          if (!document) {
            await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
            return;
          }

          const base = getReconciledBase(docName) ?? '';
          const ours = serializeDoc(docName) ?? base;

          const result = reconcile({ docName, base, ours, theirs });

          const baseH = contentHash(base).slice(0, 6);
          const oursH = contentHash(ours).slice(0, 6);
          const theirsH = contentHash(theirs).slice(0, 6);
          log.info(
            { docName, base: baseH, ours: oursH, theirs: theirsH, result: result.kind },
            `[reconcile] ${docName} base=${baseH} ours=${oursH} theirs=${theirsH} result=${result.kind}`,
          );

          switch (result.kind) {
            case 'noop':
              clearLifecycleConflict(document);
              await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
              break;

            case 'clean':
              {
                let applied = false;
                try {
                  applyToDoc(docName, result.newContent);
                  setReconciledBase(docName, result.newContent);
                  incrementReconcile();
                  clearLifecycleConflict(document);
                  applied = true;
                } catch (e) {
                  log.error(
                    { err: e, docName },
                    `[reconcile] failed to apply clean content to Y.Doc for ${docName}`,
                  );
                  setReconciledBase(docName, theirs);
                  clearLifecycleConflict(document);
                }
                if (applied) {
                  await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
                }
              }
              break;

            case 'merged':
              {
                let applied = false;
                try {
                  applyToDoc(docName, result.newContent);
                  setReconciledBase(docName, theirs);
                  incrementReconcile();
                  clearLifecycleConflict(document);
                  applied = true;
                } catch (e) {
                  log.error(
                    { err: e, docName },
                    `[reconcile] failed to apply merged content to Y.Doc for ${docName}`,
                  );
                  setReconciledBase(docName, theirs);
                  clearLifecycleConflict(document);
                }
                if (applied) {
                  await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
                }
              }
              break;

            case 'conflicts': {
              let applied = false;
              try {
                applyToDoc(docName, result.newContent);
                setReconciledBase(docName, result.newContent);
                incrementReconcile();
                incrementConflict();
                applied = true;
              } catch (e) {
                log.error(
                  { err: e, docName },
                  `[reconcile] failed to apply conflict content to Y.Doc for ${docName}`,
                );
                setReconciledBase(docName, theirs);
              }
              {
                const lifecycleMap = document.getMap('lifecycle');
                lifecycleMap.set('status', 'conflict');
                lifecycleMap.set('reason', 'merged-with-markers');
              }
              if (applied) {
                await derivedDocumentIndex.recordDiskUpsert(docName, theirs);
              }
              break;
            }

            case 'refused': {
              incrementConflict();
              const lifecycleMap = document.getMap('lifecycle');
              lifecycleMap.set('status', 'conflict');
              lifecycleMap.set('reason', result.reason);
              break;
            }
          }
          break;
        }

        case 'delete': {
          const { docName } = event;
          const document = hocuspocus.documents.get(docName);
          if (!document) {
            await derivedDocumentIndex.recordDiskDelete(docName);
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
            return;
          }

          const isDirty = rescueUnflushedEditsBeforeTeardown(
            docName,
            headWatcher?.getLastKnownBranch() ?? 'main',
            'delete',
          );

          const lifecycleMap = document.getMap('lifecycle');
          lifecycleMap.set('status', 'deleted-upstream');

          deleteReconciledBase(docName);
          await derivedDocumentIndex.recordDiskDelete(docName);
          log.info({ docName, isDirty }, `[reconcile] delete: ${docName} (dirty=${isDirty})`);

          hocuspocus.closeConnections(docName);
          await forceUnloadDocument(document);
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
          break;
        }

        case 'rename': {
          const { oldDocName, newDocName, content } = event;
          const freezeAsRenamed = (doc: Document): void => {
            const lifecycleMap = doc.getMap('lifecycle');
            lifecycleMap.set('status', 'renamed');
            lifecycleMap.set('newPath', newDocName);
          };
          const loadedBeforeIndex = hocuspocus.documents.get(oldDocName);
          const isDirty = loadedBeforeIndex
            ? rescueUnflushedEditsBeforeTeardown(
                oldDocName,
                headWatcher?.getLastKnownBranch() ?? 'main',
                'rename',
              )
            : false;
          if (loadedBeforeIndex) freezeAsRenamed(loadedBeforeIndex);

          deleteReconciledBase(oldDocName);
          setReconciledBase(newDocName, content);

          log.info(
            { oldDocName, newDocName, isDirty },
            `[reconcile] rename: ${oldDocName} → ${newDocName} (dirty=${isDirty})`,
          );
          signalChannel('files');
          onUpstreamAdd(newDocName);
          onUpstreamRename(oldDocName, newDocName);

          try {
            await derivedDocumentIndex.recordDiskRename(oldDocName, newDocName, content);
          } catch (err) {
            log.error(
              { oldDocName, newDocName, err },
              `[reconcile] rename: index update failed for ${oldDocName} → ${newDocName}; completing client teardown anyway`,
            );
          }

          const document = hocuspocus.documents.get(oldDocName);
          if (document && document !== loadedBeforeIndex) freezeAsRenamed(document);

          const resident = hocuspocus.documents.get(newDocName);
          if (resident && resident.getMap('lifecycle').get('status') === 'renamed') {
            const residentLifecycle = resident.getMap('lifecycle');
            residentLifecycle.delete('status');
            residentLifecycle.delete('newPath');
            applyToDoc(newDocName, content);
            log.info(
              { newDocName },
              `[reconcile] rename: cleared stale renamed lifecycle on ${newDocName}`,
            );
          }

          await sessionManager.closeAllForDoc(oldDocName);
          const closedConnections = document?.getConnectionsCount() ?? 0;
          /* WARN: the `delete` branch above and `captureAndCloseDocuments` pair their
             close with `forceUnloadDocument`; this branch does not, so the frozen doc
             stays resident under the old name and template-watcher-capabilities.test.ts
             pins that residency. The destination clear above is what stops a move back
             to this path from being served that stale frozen doc. */
          hocuspocus.closeConnections(oldDocName);
          if (closedConnections > 0) {
            log.info(
              { oldDocName, newDocName, closedConnections },
              `[reconcile] rename: closed ${closedConnections} connection(s) on ${oldDocName}`,
            );
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
          scheduleIndexRegeneration(newDocName);
          break;
        }

        case 'conflict': {
          const { docName } = event;
          const document = hocuspocus.documents.get(docName);
          if (!document) return;

          const ours = serializeDoc(docName);
          if (ours !== null) {
            setReconciledBase(docName, ours);
          } else {
            log.warn(
              { docName },
              `[reconcile] case 'conflict': serializeDoc returned null for ${docName}; reconciledBase snapshot skipped — post-resolution reconcile may degrade to 3-way merge`,
            );
          }

          const lifecycleMap = document.getMap('lifecycle');
          lifecycleMap.set('status', 'conflict');
          lifecycleMap.set('reason', 'conflict-markers');
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
    if (isBatchInProgress()) {
      eventBuffer.push(event);
      return;
    }
    await handleDiskEvent(event);
  }

  async function drainEventBuffer(): Promise<void> {
    const events = eventBuffer.splice(0, eventBuffer.length);
    for (const event of events) {
      await handleDiskEvent(event);
    }
  }

  let watcher: WatcherHandle | null = null;
  let headWatcher: HeadWatcherHandle | null = null;
  let syncEngine: SyncEngine | null = null;
  let inflightDestroy: Promise<void> | null = null;

  async function flushAllStoresAndWait(timeoutMs: number): Promise<void> {
    if (hocuspocus.documents.size === 0) return;

    let resolved = false;
    const allDone = new Promise<void>((resolve) => {
      hocuspocus.configuration.extensions.push({
        async afterUnloadDocument({ instance }) {
          if (!resolved && instance.getDocumentsCount() === 0) {
            resolved = true;
            resolve();
          }
        },
      });
    });

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

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => {
        resolved = true;
        const stillLoaded = Array.from(hocuspocus.documents.keys());

        const rescued: string[] = [];
        const rescueFailed: string[] = [];
        if (shadowRef.current) {
          for (const docName of stillLoaded) {
            if (isReservedForUserTree(docName)) continue;
            try {
              const ours = serializeDoc(docName);
              if (ours === null) {
                log.warn(
                  { docName },
                  `[rescue] skipping ${docName} — document dropped from map mid-rescue`,
                );
                rescueFailed.push(docName);
                continue;
              }
              const rescuePath = safeRescuePath(shadowRef.current.gitDir, docName);
              if (!rescuePath) {
                log.warn(
                  { docName, gitDir: shadowRef.current.gitDir },
                  `[rescue] path-traversal guard rejected docName: ${docName}`,
                );
                rescueFailed.push(docName);
                continue;
              }
              mkdirSync(dirname(rescuePath), { recursive: true });
              writeFileSync(rescuePath, ours, 'utf-8');
              incrementRescueBuffer();
              rescued.push(docName);
              log.info({ docName }, `[rescue] rescue buffer saved on flush timeout: ${docName}`);
            } catch (e) {
              rescueFailed.push(docName);
              log.error(
                { err: e, docName },
                `[rescue] failed to write rescue buffer for ${docName}`,
              );
            }
          }
        } else {
          log.warn(
            { stillLoadedCount: stillLoaded.length },
            `[rescue] shadow repo unavailable at flush timeout — ${stillLoaded.length} doc(s) will be lost: [${stillLoaded.join(', ')}]`,
          );
          rescueFailed.push(...stillLoaded);
        }

        const rescueSummary =
          rescued.length > 0 || rescueFailed.length > 0
            ? ` — rescued [${rescued.join(', ')}]${
                rescueFailed.length > 0 ? `, lost [${rescueFailed.join(', ')}]` : ''
              }`
            : '';

        reject(
          new Error(
            `flushAllStoresAndWait timeout after ${timeoutMs}ms — ${stillLoaded.length}/${pendingDocNames.length} docs did not unload: [${stillLoaded.join(', ')}]${rescueSummary}`,
          ),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([allDone, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  async function destroy(): Promise<void> {
    if (inflightDestroy) return inflightDestroy;

    inflightDestroy = (async () => {
      const t0 = Date.now();
      const phaseErrors: Array<{ phase: string; error: string }> = [];
      shutdownAllowsUnload = true;

      try {
        await closeIndexRegeneration();
      } catch (err) {
        log.warn({ err }, '[index] generated index shutdown drain failed');
        phaseErrors.push({ phase: 'generated-index-drain', error: String(err) });
      }

      for (const unregister of unregisterWorkloadProviders.splice(0)) {
        unregister();
      }
      try {
        await stalenessWatchdog?.dispose();
      } catch (err) {
        log.warn({ err }, '[server] staleness watchdog drain failed during destroy');
      }
      stalenessWatchdog = null;

      try {
        markServerLockDraining(lockDir);
      } catch (err) {
        log.warn({ err }, '[server] failed to mark server.lock draining');
      }

      maintenanceCoordinator?.destroy();

      try {
        await closeShadowHousekeeping();
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
          initTimeoutId = setTimeout(() => r('timeout'), 5_000);
        }),
      ]);
      if (initTimeoutId !== undefined) clearTimeout(initTimeoutId);
      if (initSettled === 'timeout') {
        log.warn({}, '[server] init did not complete within 5s during shutdown');
      }

      const documentCount = hocuspocus.documents.size;

      try {
        try {
          try {
            if (inPlaceRescanTimer) {
              clearTimeout(inPlaceRescanTimer);
              inPlaceRescanTimer = null;
            }
            if (headWatcher) {
              await headWatcher.unsubscribe();
              headWatcher = null;
            }
            if (watcher) {
              await watcher.unsubscribe();
              watcher = null;
            }
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
          } catch (err) {
            phaseErrors.push({
              phase: 'watcher-unsubscribe',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-1 watcher unsubscribe failed');
          }

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

          void derivedDocumentIndex.close();

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

          const durationMs = Date.now() - t0;
          if (phaseErrors.length === 0) {
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

    if (shadowRef.current) {
      const warmShadow = shadowRef.current;
      const warmContentRoot = toPosix(relative(projectDir, contentDir)) || '.';
      setTimeout(() => {
        void buildWipTree(warmShadow, warmContentRoot).catch((e) => {
          log.debug({ err: e }, '[shadow] fan-out index warm-up failed (non-fatal)');
        });
      }, 3000).unref();
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
      cc1Broadcaster?.emitServerInfo(serverInstanceId, getActiveBranch());
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
        const cleanup = await startConfigFileWatcher(absPath, (content) => {
          const document = hocuspocus.documents.get(configDocName);
          log.info(
            {
              docName: configDocName,
              hasDocument: document !== undefined,
              contentLength: content.length,
            },
            '[config-file-watcher] file changed',
          );
          const outcome = applyExternalConfigChange(
            document ?? null,
            configDocName,
            content,
            persistence.configPersistenceCtx,
          );
          log.info(
            { docName: configDocName, outcome },
            '[config-file-watcher] applyExternalConfigChange outcome',
          );
          applyPersistedConfigToConsumers(configDocName);
        });
        configFileWatcherCleanups.push({ docName: configDocName, cleanup });
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
      const reconcileManagedArtifactDisk = (absPath: string, content: string): void => {
        const docName = managedArtifactDocNameForPath(absPath, persistence.managedArtifactCtx);
        if (!docName) return;
        const document = hocuspocus.documents.get(docName);
        const outcome = applyExternalManagedArtifactChange(
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
        const skillStatePath = resolve(
          homeFor(persistence.managedArtifactCtx),
          '.ok',
          'skill-state.yml',
        );
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
                  const outcome = applyExternalConfigChange(
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
        const { deletedDocNames, backlinkIndexDegraded } = await derivedIndexStartup.backlinksReady;
        if (backlinkIndexDegraded) degraded.push('backlink-index');
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
        const seedWalkStartMono = performance.now();
        const HOST_SKILLS_EVENT_RE = /^\.(?!ok\/)[A-Za-z0-9_-]+\/skills\//;
        let lastInPlaceDirs = contentFilter ? scanInPlaceSkillDirs(contentDir) : new Set<string>();
        const onRawBatch = (absPaths: readonly string[]): void => {
          if (
            !absPaths.some((p) =>
              HOST_SKILLS_EVENT_RE.test(relative(contentDir, p).split(sep).join('/')),
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
              const next = scanInPlaceSkillDirs(contentDir);
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
          startWatcher(contentDir, onDiskEvent, contentFilter, { onRawBatch }),
        );
        void resyncRecordedSkillCopies(projectDir, contentDir)
          .then((n) => {
            if (n > 0) log.info({ refreshed: n }, '[in-place-skills] boot copy re-sync');
          })
          .catch((err) => log.warn({ err }, '[in-place-skills] boot copy re-sync failed'));
        {
          const home = configHomedirOverride ?? homedir();
          void resyncRecordedSkillCopies(home, home, scanGlobalInPlaceSkills(home))
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
    }

    try {
      headWatcher = await startHeadWatcher(
        projectDir,
        async ({ trigger }) => {
          log.info({ trigger }, `[batch] begin trigger=${trigger}`);
          incrementBatch();
          hocuspocus.flushPendingStores();
          await persistence.flushPendingGitCommit();

          setBatchInProgress(true);

          if (shadowRef.current) {
            const currentBranch = getActiveBranch();
            const newBranch = readProjectHeadState(projectDir).branch ?? currentBranch;
            const docs: ParkableDoc[] = [];
            for (const [docName, document] of hocuspocus.documents) {
              if (isReservedForUserTree(docName)) continue;
              let markdown: string | null = null;
              document.transact(() => {
                markdown = serializeDoc(docName);
              }, PARK_SNAPSHOT_ORIGIN);
              if (markdown === null) continue;
              const diskSnapshot = getReconciledBase(docName) ?? markdown;
              docs.push({ docName, markdown, diskSnapshot });
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
            setBatchInProgress(false);
            await drainEventBuffer();

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
            await persistence.flushDeferredStores('within-branch');
            if (syncEngine !== null) {
              try {
                await syncEngine.reconcileConflictsFromGit();
              } catch (err) {
                log.warn({ err }, '[head-watcher] sync engine conflict reconcile failed');
              }
            }
          } else {
            incrementBranchSwitch();
            eventBuffer.splice(0, eventBuffer.length);
            let deferredStoresFlushed = false;
            let branchTransition: DerivedDocumentIndexBranchTransition | undefined;
            try {
              switchReconciledBaseScope(newBranch);
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

              for (const [docName, document] of hocuspocus.documents) {
                if (isReservedForUserTree(docName)) continue;
                try {
                  const filePath = safeContentPath(docName, contentDir);
                  if (!existsSync(filePath)) {
                    rescueUnflushedEditsBeforeTeardown(docName, newBranch, 'branch-switch');

                    const lifecycleMap = document.getMap('lifecycle');
                    lifecycleMap.set('status', 'deleted-upstream');
                    log.info(
                      { docName, branch: newBranch },
                      `[branch-switch] tombstone: ${docName} (not on ${newBranch})`,
                    );
                    continue;
                  }

                  const diskContent = readFileSync(filePath, 'utf-8');
                  applyToDoc(docName, diskContent);
                  setReconciledBase(docName, diskContent);
                  log.info({ docName }, `[branch-switch] reset: ${docName}`);
                } catch (e) {
                  log.error({ err: e, docName }, `[branch-switch] failed to reset ${docName}`);
                }
              }

              log.info(
                { branch: newBranch, docCount: hocuspocus.documents.size },
                `[branch-switch] loaded branch ${newBranch} (${hocuspocus.documents.size} docs)`,
              );
              try {
                await derivedDocumentIndex.settleBranchFromDisk(branchTransition);
              } catch (err) {
                derivedDocumentIndex.abortBranchSwitch(branchTransition);
                log.error(
                  { err, branch: newBranch },
                  '[derived-index] branch-switch rebuild failed; relationship views may be stale',
                );
              }

              if (shadowRef.current && info.batchKind === 'cross-branch') {
                let restoredCount = 0;
                for (const [docName] of hocuspocus.documents) {
                  if (isReservedForUserTree(docName)) continue;
                  try {
                    const parked = await readParkedState(
                      shadowRef.current,
                      newBranch,
                      SERVICE_WRITER.id,
                      docName,
                    );
                    if (!parked) continue;
                    if (parked.markdown === parked.diskSnapshot) continue;

                    const currentDisk = getReconciledBase(docName);
                    if (!currentDisk) continue;

                    const outcome = reconcile({
                      docName,
                      base: parked.diskSnapshot,
                      ours: parked.markdown,
                      theirs: currentDisk,
                    });

                    switch (outcome.kind) {
                      case 'merged':
                      case 'clean':
                        applyToDoc(docName, outcome.newContent);
                        setReconciledBase(docName, outcome.newContent);
                        restoredCount++;
                        break;
                      case 'conflicts': {
                        applyToDoc(docName, outcome.newContent);
                        setReconciledBase(docName, outcome.newContent);
                        incrementConflict();
                        restoredCount++;
                        {
                          const restoredDoc = hocuspocus.documents.get(docName);
                          if (restoredDoc) {
                            const lifecycleMap = restoredDoc.getMap('lifecycle');
                            lifecycleMap.set('status', 'conflict');
                            lifecycleMap.set('reason', 'merged-with-markers');
                          }
                        }
                        break;
                      }
                      case 'noop':
                      case 'refused':
                        break;
                    }
                  } catch (e) {
                    log.error(
                      { err: e, docName },
                      `[branch-switch] restore WIP failed for ${docName}`,
                    );
                  }
                }
                if (restoredCount > 0) {
                  log.info(
                    { count: restoredCount, branch: newBranch },
                    `[branch-switch] restored ${restoredCount} parked docs on ${newBranch}`,
                  );
                }
              }

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

              setBatchInProgress(false);
              await persistence.flushDeferredStores('discard-stale');
              deferredStoresFlushed = true;
              cc1Broadcaster?.emitBranchSwitched(newBranch);
            } finally {
              derivedDocumentIndex.abortBranchSwitch(branchTransition);
              if (!deferredStoresFlushed) {
                setBatchInProgress(false);
                await persistence.flushDeferredStores('discard-stale');
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
      );
    } catch (err) {
      log.error({ err }, '[server] HEAD watcher failed to start');
      degraded.push('head-watcher');
    }

    function markLoadedContentConflicts(files: string[]): void {
      for (const file of files) {
        try {
          const absPath = join(projectDir, file);
          const contentRelPath = toPosix(relative(contentDir, absPath));
          if (contentRelPath.startsWith('..')) continue;
          const docName = stripDocExtension(contentRelPath);
          const document = hocuspocus.documents.get(docName);
          if (!document) continue;

          const ours = serializeDoc(docName);
          if (ours !== null) {
            setReconciledBase(docName, ours);
          } else {
            log.warn(
              { docName, file },
              '[sync] content conflict: serializeDoc returned null; reconciledBase snapshot skipped',
            );
          }

          const lifecycleMap = document.getMap('lifecycle');
          lifecycleMap.set('status', 'conflict');
          lifecycleMap.set('reason', 'sync-merge-conflict');
          log.info({ docName, file }, '[sync] marked loaded content conflict');
        } catch (err) {
          log.warn({ err, file }, '[sync] failed to mark loaded content conflict');
        }
      }
    }

    function clearLoadedContentConflicts(files: string[]): void {
      for (const file of files) {
        try {
          const absPath = join(projectDir, file);
          const contentRelPath = toPosix(relative(contentDir, absPath));
          if (contentRelPath.startsWith('..')) continue;
          const document = hocuspocus.documents.get(stripDocExtension(contentRelPath));
          if (document) clearLifecycleConflict(document);
        } catch (err) {
          log.warn({ err, file }, '[sync] failed to clear resolved content conflict');
        }
      }
    }

    const resetAmbientCredentials = shouldResetAmbientCredentials(projectDir);
    log.debug(
      { resetAmbientCredentials, originKind: readOriginGitHubRepo(projectDir).kind },
      '[sync] ambient credential-chain reset decision at boot',
    );
    const syncCredentialConfig = buildSyncCredentialConfig(localOpCliArgs, {
      resetAmbient: resetAmbientCredentials,
    });
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
        cc1Broadcaster,
        detectGh: options.detectGh,
        detectGhAccounts: options.detectGhAccounts,
        tokenStore: options.tokenStore,
        checkPushPermissionFn: options.checkPushPermissionFn,
        setBatchInProgress: (value) => {
          setBatchInProgress(value);
          if (!value) {
            void persistence.flushDeferredStores('within-branch').catch((err) => {
              log.error({ err }, '[persistence] deferred store drain failed after sync batch');
            });
          }
        },
        onStateChange: (state) => {
          log.info({ state }, `[sync] state → ${state}`);
        },
        onContentConflictsDetected: markLoadedContentConflicts,
        onContentConflictsResolved: clearLoadedContentConflicts,
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

    logConfigDiagnosticsOnce();
  }

  initAsync().then(
    () => {
      indexRegenerationReady = true;
      resolveReady();
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
    getLinkPreviewsEnabled: readLinkPreviewsEnabled,
    resolveEmbed,
    acpRegistry,
    acpPermissions,
  };
}
