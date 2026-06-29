import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Document, Extension } from '@hocuspocus/server';
import { Hocuspocus, IncomingMessage, MessageType } from '@hocuspocus/server';
import {
  type BasenameIndex,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  createBasenameIndex,
  humanFormat,
  type MarkdownManager,
  type Principal,
  parseGlobalSkillBundleDoc,
} from '@inkeep/open-knowledge-core';
import {
  readConfigSafely,
  resolveConfigPath,
  writeConfigPatch,
} from '@inkeep/open-knowledge-core/server';
import { resolveGitDir, resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { AgentFocusBroadcaster } from './agent-focus.ts';
import { AgentPresenceBroadcaster } from './agent-presence.ts';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension, isSafeDocName } from './api-extension.ts';
import { assetReferencesChanged } from './asset-references.ts';
import { seedBasenameIndex, seedSingleDirBasenameIndex } from './asset-walk.ts';
import { HocuspocusAuthRejection, parseHocuspocusAuthToken } from './auth-token-schema.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { shellEscape } from './bash/shell-escape.ts';
import {
  CC1Broadcaster,
  isConfigDoc,
  isManagedArtifactDoc,
  isReservedForUserTree,
  SYSTEM_DOC_NAME,
} from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import {
  type ConfigFileWatcherUnsubscribe,
  startConfigFileWatcher,
  startMultiPathConfigFileWatcher,
} from './config-file-watcher.ts';
import { applyExternalConfigChange } from './config-persistence.ts';
import { isDocInConflict } from './conflict-errors.ts';
import { createConflictLifecycleSeedExtension } from './conflict-lifecycle-seed.ts';
import { resolveProjectTemplates } from './content/templates-resolver.ts';
import { type ContentFilter, createContentFilter } from './content-filter.ts';
import { getDocExtension, stripDocExtension } from './doc-extensions.ts';
import { runDocLineageGuard } from './doc-lineage-guard.ts';
import {
  DEFAULT_EMBEDDINGS_DIMENSIONS,
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
  applyDiskContentToDoc,
  applyExternalChange,
  FILE_WATCHER_ORIGIN,
  serializeYDocSource,
} from './external-change.ts';
import {
  assertNeverDiskEvent,
  contentHash,
  type DiskEvent,
  reconcileFileIndexAfterFilterRebuild,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import type {
  CheckPushPermissionOptions,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { type HeadWatcherHandle, readBranchFromHead, startHeadWatcher } from './head-watcher.ts';
import { createLiveDerivedIndexExtension } from './live-derived-index.ts';
import { getLogger } from './logger.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';
import {
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
} from './maintenance-coordinator.ts';
import {
  applyExternalManagedArtifactChange,
  managedArtifactDocNameForPath,
  managedArtifactSkillsRoots,
} from './managed-artifact-persistence.ts';
import { startManagedArtifactWatcher, TEMPLATE_WATCH_OPTIONS } from './managed-artifact-watcher.ts';
import { recoverPendingManagedRename } from './managed-rename-journal.ts';
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
import { isWithinDir, toPosix } from './path-utils.ts';
import {
  createPersistenceExtension,
  deleteReconciledBase,
  getActiveBranch,
  getReconciledBase,
  isBatchInProgress,
  type PersistenceOptions,
  safeContentPath,
  setBatchInProgress,
  setReconciledBase,
  switchReconciledBaseScope,
} from './persistence.ts';
import { loadPrincipal } from './principal.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { reconcile } from './reconciliation.ts';
import { runRemovalRedirectGuard } from './removal-redirect-guard.ts';
import {
  gcRenameLog,
  loadRenameLogIndex,
  setRenameLogIndex,
  sweepLazyPopOrphans,
} from './rename-log.ts';
import { acquireServerLock, releaseServerLock } from './server-lock.ts';
import { createServerObserverExtension } from './server-observer-extension.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import {
  commitUpstreamImport,
  destroyShadowRepo,
  initShadowRepo,
  type ParkableDoc,
  parkBranch,
  readParkedState,
  SERVICE_WRITER,
  type ShadowHandle,
  type ShadowRef,
  saveInMemoryCheckpoint,
  shadowGit,
} from './shadow-repo.ts';
import { assertCompatibleStateManifest } from './state-manifest.ts';
import { SyncEngine } from './sync-engine.ts';
import { createSyncHandshakeSpanExtension } from './sync-handshake-span-extension.ts';
import { TagIndex } from './tag-index.ts';
import { initTelemetry, shutdownTelemetry } from './telemetry.ts';
import { cleanupOrphanUploadTempfiles } from './upload-streaming.ts';

export interface ServerOptions {
  port?: number;
  host?: string;
  contentDir: string;
  projectDir?: string;
  quiet?: boolean;
  debounce?: number;
  maxDebounce?: number;
  gitEnabled?: boolean;
  commitDebounceMs?: number;
  wipRef?: string;
  enableTestRoutes?: boolean;
  shadowRepo?: ShadowHandle;
  contentRoot?: string;
  destroyTimeoutMs?: number;
  onAgentWrite?: () => void;
  localOpCliArgs?: string[];
  lockKind?: 'interactive' | 'mcp-spawned';
  skipStateManifestCheck?: boolean;
  configHomedirOverride?: string;
  mdManager?: MarkdownManager;
  detectGh?: DetectGhFn;
  tokenStore?: ProbeTokenStore | null;
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  embeddingsKeyStore?: EmbeddingsKeyStore | null;
  embedderLoader?: () => Promise<Embedder | null>;
  singleDocRelPath?: string;
  ephemeral?: boolean;
}

export interface ServerInstance {
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  cc1Broadcaster: CC1Broadcaster;
  agentFocusBroadcaster: AgentFocusBroadcaster;
  agentPresenceBroadcaster: AgentPresenceBroadcaster;
  maintenanceCoordinator?: MaintenanceCoordinator;
  contentFilter: ContentFilter;
  basenameIndex: BasenameIndex;
  readonly serverInstanceId: string;
  destroy: () => Promise<void>;
  ready: Promise<void>;
  readonly degraded: readonly string[];
  readonly lockDir: string;
  readonly syncEngine: SyncEngine | null;
}

const PARK_SNAPSHOT_ORIGIN = (() => {
  const ctx = Object.freeze({ origin: 'park-snapshot', paired: true as const });
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: ctx,
  }) satisfies PairedWriteOrigin;
})();

export function buildSyncCredentialArgs(localOpCliArgs?: string[]): string[] {
  const argv = localOpCliArgs && localOpCliArgs.length > 0 ? localOpCliArgs : ['open-knowledge'];
  const cliPrefix = argv.map(shellEscape).join(' ');
  return ['-c', `credential.helper=!${cliPrefix} auth git-credential`];
}

export function createServer(options: ServerOptions): ServerInstance {
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
    skipStateManifestCheck = false,
    singleDocRelPath,
    ephemeral = false,
  } = options;

  const log = getLogger('server');

  function readProjectAutoSyncEnabled(): boolean {
    const local = readConfigSafely({
      absPath: resolveConfigPath('project-local', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
    const localEnabled = local.value.autoSync?.enabled;
    if (localEnabled !== null && localEnabled !== undefined) {
      return localEnabled === true;
    }
    if (!local.valid) {
      log.warn(
        {},
        '[config] project-local autoSync.enabled unavailable (config invalid) — falling back to the committed project default',
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
    return project.value.autoSync?.default === true;
  }

  function readSemanticSearchConfig(): ResolvedSemanticConfig {
    return readProjectLocalSemanticConfig(projectDir, {
      configHomedirOverride,
      onWarn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
  }

  function semanticProviderFingerprint(cfg: ResolvedSemanticConfig): string {
    return `${normalizeProviderId(cfg.baseUrl)}|${cfg.model}|${cfg.dimensions ?? DEFAULT_EMBEDDINGS_DIMENSIONS}`;
  }

  initTelemetry();

  const serverInstanceId = randomUUID();

  const lockDir = getLocalDir(projectDir);
  acquireServerLock(lockDir, {
    port: options.port ?? 0,
    worktreeRoot: projectDir,
    kind: options.lockKind ?? 'interactive',
    capabilities: ['http', 'ws'],
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
  let backlinkIndex: BacklinkIndex;
  let tagIndex: TagIndex;
  let shadowRef: ShadowRef;
  let maintenanceCoordinator: MaintenanceCoordinator | undefined;
  let persistence: ReturnType<typeof createPersistenceExtension>;
  let hocuspocus: Hocuspocus;
  let sessionManager: AgentSessionManager;
  let cc1Broadcaster: CC1Broadcaster | null = null;
  let agentFocusBroadcaster: AgentFocusBroadcaster | null = null;
  let agentPresenceBroadcaster: AgentPresenceBroadcaster | null = null;
  let invalidateReferencedAssetsCache: (() => void) | null = null;

  const initialSemanticConfig = readSemanticSearchConfig();
  const semanticSearch = new SemanticSearchService({
    loadEmbedder:
      options.embedderLoader ??
      (() => {
        const cfg = readSemanticSearchConfig();
        return loadOpenAiEmbedder({
          keyStore: options.embeddingsKeyStore ?? null,
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
  let forceUnloadDocument!: (document: Document) => Promise<void>;

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  function signalChannel(channel: 'files' | 'backlinks' | 'graph' | 'tags'): void {
    cc1Broadcaster?.signal(channel);
  }

  const BACKLINK_SAVE_DEBOUNCE_MS = 2000;
  let backlinkSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSaveToDisk(): void {
    if (backlinkSaveTimer !== null) clearTimeout(backlinkSaveTimer);
    backlinkSaveTimer = setTimeout(() => {
      backlinkSaveTimer = null;
      void backlinkIndex.saveToDisk().catch((err) => {
        console.warn('[backlinks] Failed to persist debounced cache:', err);
      });
    }, BACKLINK_SAVE_DEBOUNCE_MS);
  }

  const recentlyRemovedDocs = new RecentlyRemovedDocs(undefined, {
    onEviction: () => incrementRecentlyRemovedDocsEviction(),
    onSizeChange: (size) => setRecentlyRemovedDocsSize(size),
  });
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
    contentFilter = createContentFilter({
      projectDir,
      contentDir,
      singleDocRelPath,
      onAfterRebuild: () => {
        void backlinkIndex.rebuildFromDisk(getActiveBranch()).catch((err) => {
          getLogger('server-factory').warn(
            { err },
            '[content-filter] backlink-index rebuild failed after onAfterRebuild',
          );
        });
        void tagIndex.init().catch((err) => {
          getLogger('server-factory').warn(
            { err },
            '[content-filter] tag-index rebuild failed after onAfterRebuild',
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
    backlinkIndex = new BacklinkIndex({ projectDir, contentDir, contentFilter });
    tagIndex = new TagIndex({ contentDir, contentFilter });
    void tagIndex.init().catch((err) => {
      getLogger('server-factory').warn(
        { err },
        '[server-factory] tag-index init failed; continuing with empty index',
      );
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

    const persistenceOpts: PersistenceOptions = {
      contentDir,
      projectDir,
      gitEnabled,
      commitDebounceMs,
      wipRef,
      shadowRef,
      ephemeral,
      contentRoot,
      backlinkIndex,
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
        if (!assetReferencesChanged(previousMarkdown, persistedMarkdown)) return;
        invalidateReferencedAssetsCache?.();
        signalChannel('files');
      },
      onConfigRejected: (docName, error) =>
        cc1Broadcaster?.emitConfigValidationRejected(docName, error),
      mdManager: options.mdManager,
    };

    persistence = createPersistenceExtension(persistenceOpts);

    hocuspocus = new Hocuspocus({
      quiet,
      debounce,
      maxDebounce,
      extensions: [persistence.extension],
    });

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

    sessionManager = new AgentSessionManager(hocuspocus);
    const liveDerivedIndexExtension = createLiveDerivedIndexExtension({
      backlinkIndex,
      tagIndex,
      signalChannel,
    });
    hocuspocus.configuration.extensions.push(liveDerivedIndexExtension);

    const principalAuthExtension: Extension & { __kind: 'principal-auth' } = {
      __kind: 'principal-auth',
      async onAuthenticate(payload) {
        const tokenStr = payload.token;
        const parsed = parseHocuspocusAuthToken(tokenStr);

        const claimed = parsed?.expectedServerInstanceId;
        if (typeof claimed === 'string' && claimed.length > 0 && claimed !== serverInstanceId) {
          throw new HocuspocusAuthRejection(
            'server-instance-mismatch',
            `server instance mismatch: client claimed ${claimed}, this server is ${serverInstanceId}`,
          );
        }

        const claimedBranch = parsed?.expectedBranch;
        const currentBranch = getActiveBranch();
        if (
          typeof claimedBranch === 'string' &&
          claimedBranch.length > 0 &&
          claimedBranch !== currentBranch
        ) {
          throw new HocuspocusAuthRejection(
            'branch-mismatch',
            `branch mismatch: client claimed ${claimedBranch}, server is on ${currentBranch}`,
          );
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
          }
          else {
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
        if (peer !== undefined && !isLoopbackAddress(peer)) {
          throw new Error(
            `config-doc admission requires loopback peer (peer=${peer}, doc=${payload.documentName})`,
          );
        }
        const headersBag = (payload as { requestHeaders?: Headers }).requestHeaders;
        const host =
          (headersBag && typeof headersBag.get === 'function' ? headersBag.get('host') : null) ??
          req.headers?.host ??
          undefined;
        if (!isAllowedWorkspaceHostHeader(host)) {
          throw new Error(
            `config-doc admission requires loopback Host header (host=${host ?? '<absent>'}, doc=${payload.documentName})`,
          );
        }
      },
    };
    hocuspocus.configuration.extensions.push(configDocAdmissionGuard);

    const resolvedContentDir = resolve(contentDir);
    function resolveDocFilePath(docName: string): string | null {
      if (!isSafeDocName(docName)) return null;
      const filePath = resolve(resolvedContentDir, `${docName}${getDocExtension(docName)}`);
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
      sessionManager,
      contentDir,
      contentFilter,
      serverInstanceId,
      getFileIndex: () => (watcher ? watcher.getFileIndex() : new Map()),
      getAllFilesIndex: () => (watcher ? watcher.getAllFilesIndex() : new Map()),
      getFileIndexGeneration: () => watcher?.getFileIndexGeneration() ?? 0,
      mutateFileIndex: (event) => watcher?.mutateFileIndex(event),
      getFolderIndex: () => (watcher ? watcher.getFolderIndex() : new Map()),
      getAliasMap: () => (watcher ? watcher.getAliasMap() : new Map()),
      getFolderAliasIndex: () => (watcher ? watcher.getFolderAliasIndex() : new Map()),
      rescanFiles: () => watcher?.rescanFromDisk(),
      enableTestRoutes,
      shadowRef,
      flushGitCommit: () => persistence.flushPendingGitCommit(),
      flushContributors: () => persistence.flushContributors(),
      takeStoreFailure: (docName: string) => persistence.takeStoreFailure(docName),
      takeStoreDivergence: (docName: string) => persistence.takeStoreDivergence(docName),
      markAgentWriteStore: (docName: string) => persistence.markAgentWriteStore(docName),
      getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
      getDiskAckSVs: () => cc1Broadcaster?.getLatestDiskAckSVsAsBase64() ?? {},
      contentRoot,
      backlinkIndex,
      tagIndex,
      signalChannel,
      agentFocusBroadcaster,
      agentPresenceBroadcaster,
      onAgentWrite: options.onAgentWrite,
      getSyncEngine: () => syncEngine,
      localOpCliArgs,
      projectDir,
      resolveEmbed,
      getPrincipal: () => loadedPrincipal,
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
      embeddingsSecretsFile: secretsFilePath(configHomedirOverride),
      ephemeral,
      onReferencedAssetsCacheInvalidator: (invalidate) => {
        invalidateReferencedAssetsCache = invalidate;
      },
    });
    hocuspocus.configuration.extensions.push(apiExtension);

    hocuspocus.configuration.extensions.push(
      createServerObserverExtension({
        mdManager,
        schema,
        shadowRef,
        contentRoot,
        getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
        resolveEmbed,
        resolveSize,
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
    const filePath = resolve(rescueBase, `${docName}${getDocExtension(docName)}`);
    if (!isWithinDir(filePath, rescueBase)) return null;
    return filePath;
  }

  function serializeDoc(docName: string): string | null {
    const document = hocuspocus.documents.get(docName);
    if (!document) return null;
    return serializeYDocSource(document);
  }

  const applyToDoc = (docName: string, content: string): void =>
    applyExternalChange(hocuspocus, docName, content, resolveEmbed, resolveSize);

  function clearLifecycleConflict(document: Document): void {
    if (!isDocInConflict(document)) return;
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

  async function handleDiskEvent(event: DiskEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'create': {
          log.info({ docName: event.docName }, `[reconcile] create: ${event.docName}`);
          backlinkIndex.updateDocumentFromMarkdown(event.docName, event.content);
          scheduleSaveToDisk();
          tagIndex.updateDocumentFromMarkdown(event.docName, event.content);
          signalChannel('files');
          signalChannel('backlinks');
          signalChannel('graph');
          signalChannel('tags');
          onUpstreamAdd(event.docName);
          break;
        }

        case 'update': {
          const { docName, content: theirs } = event;
          const document = hocuspocus.documents.get(docName);
          if (!document) {
            backlinkIndex.updateDocumentFromMarkdown(docName, theirs);
            scheduleSaveToDisk();
            tagIndex.updateDocumentFromMarkdown(docName, theirs);
            signalChannel('backlinks');
            signalChannel('graph');
            signalChannel('tags');
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
              backlinkIndex.updateDocumentFromMarkdown(docName, theirs);
              scheduleSaveToDisk();
              tagIndex.updateDocumentFromMarkdown(docName, theirs);
              signalChannel('backlinks');
              signalChannel('graph');
              signalChannel('tags');
              break;

            case 'clean':
              try {
                applyToDoc(docName, result.newContent);
                setReconciledBase(docName, result.newContent);
                incrementReconcile();
                clearLifecycleConflict(document);
                backlinkIndex.updateDocumentFromMarkdown(docName, theirs);
                scheduleSaveToDisk();
                tagIndex.updateDocumentFromMarkdown(docName, theirs);
                signalChannel('backlinks');
                signalChannel('graph');
                signalChannel('tags');
              } catch (e) {
                log.error(
                  { err: e, docName },
                  `[reconcile] failed to apply clean content to Y.Doc for ${docName}`,
                );
                setReconciledBase(docName, theirs);
                clearLifecycleConflict(document);
              }
              break;

            case 'merged':
              try {
                applyToDoc(docName, result.newContent);
                setReconciledBase(docName, theirs);
                incrementReconcile();
                clearLifecycleConflict(document);
                backlinkIndex.updateDocumentFromMarkdown(docName, theirs);
                scheduleSaveToDisk();
                tagIndex.updateDocumentFromMarkdown(docName, theirs);
                signalChannel('backlinks');
                signalChannel('graph');
                signalChannel('tags');
              } catch (e) {
                log.error(
                  { err: e, docName },
                  `[reconcile] failed to apply merged content to Y.Doc for ${docName}`,
                );
                setReconciledBase(docName, theirs);
                clearLifecycleConflict(document);
              }
              break;

            case 'conflicts': {
              try {
                applyToDoc(docName, result.newContent);
                setReconciledBase(docName, result.newContent);
                incrementReconcile();
                incrementConflict();
                backlinkIndex.updateDocumentFromMarkdown(docName, theirs);
                scheduleSaveToDisk();
                tagIndex.updateDocumentFromMarkdown(docName, theirs);
                signalChannel('backlinks');
                signalChannel('graph');
                signalChannel('tags');
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
            backlinkIndex.deleteDocument(docName);
            scheduleSaveToDisk();
            tagIndex.deleteDocument(docName);
            signalChannel('files');
            signalChannel('backlinks');
            signalChannel('graph');
            signalChannel('tags');
            onUpstreamDelete(docName);
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

          const base = getReconciledBase(docName) ?? '';
          const ours = serializeDoc(docName) ?? '';
          const isDirty = ours !== base;

          if (isDirty && shadowRef.current) {
            const shadowForCheckpoint = shadowRef.current;
            const branch = headWatcher?.getLastKnownBranch() ?? 'main';
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
                  log.info({ docName }, `[reconcile] rescue checkpoint saved (delete): ${docName}`);
                })
                .catch((e: unknown) => {
                  log.error(
                    { docName, err: e },
                    `[reconcile] rescue checkpoint write failed: ${docName}`,
                  );
                });
            });
          }

          const lifecycleMap = document.getMap('lifecycle');
          lifecycleMap.set('status', 'deleted-upstream');

          deleteReconciledBase(docName);
          backlinkIndex.deleteDocument(docName);
          scheduleSaveToDisk();
          tagIndex.deleteDocument(docName);
          log.info({ docName, isDirty }, `[reconcile] delete: ${docName} (dirty=${isDirty})`);

          hocuspocus.closeConnections(docName);
          await forceUnloadDocument(document);
          signalChannel('files');
          signalChannel('backlinks');
          signalChannel('graph');
          signalChannel('tags');
          onUpstreamDelete(docName);
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
          const document = hocuspocus.documents.get(oldDocName);

          deleteReconciledBase(oldDocName);
          setReconciledBase(newDocName, content);
          backlinkIndex.renameDocument(oldDocName, newDocName, content);
          scheduleSaveToDisk();
          tagIndex.renameDocument(oldDocName, newDocName, content);

          if (document) {
            const lifecycleMap = document.getMap('lifecycle');
            lifecycleMap.set('status', 'renamed');
            lifecycleMap.set('newPath', newDocName);
          }

          log.info({ oldDocName, newDocName }, `[reconcile] rename: ${oldDocName} → ${newDocName}`);
          signalChannel('files');
          signalChannel('backlinks');
          signalChannel('graph');
          signalChannel('tags');
          onUpstreamRename(oldDocName, newDocName);
          console.info(
            JSON.stringify({
              event: 'recently-removed-docs-populate',
              from: oldDocName,
              to: newDocName,
              kind: 'renamed',
              source: 'watcher-rename',
            }),
          );
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
          break;
        }
        case 'file-create':
        case 'file-update':
        case 'file-delete': {
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

      if (backlinkSaveTimer !== null) {
        clearTimeout(backlinkSaveTimer);
        backlinkSaveTimer = null;
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

      maintenanceCoordinator?.destroy();

      try {
        try {
          try {
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
            await flushAllStoresAndWait(destroyTimeoutMs);
          } catch (err) {
            phaseErrors.push({
              phase: 'flush-all-stores',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-3 flush failed');
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
            } catch {
            }

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
          releaseServerLock(lockDir);
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
        shadowRef.current = await initShadowRepo(projectDir);
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
      let renameLogIndex: ReturnType<typeof loadRenameLogIndex> | null = null;
      try {
        renameLogIndex = loadRenameLogIndex(shadowRef.current.gitDir);
        sweepLazyPopOrphans(shadowRef.current.gitDir, renameLogIndex);
        setRenameLogIndex(shadowRef.current.gitDir, renameLogIndex);
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
      if (renameLogIndex) {
        const BOOT_GC_TIMEOUT_MS = 10_000;
        try {
          await Promise.race([
            gcRenameLog(shadowRef.current, renameLogIndex, { rebuild: true }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`boot-time GC exceeded ${BOOT_GC_TIMEOUT_MS}ms`)),
                BOOT_GC_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (e) {
          log.warn({ err: e }, '[rename-log] boot-time GC/rebuild failed; index loaded without GC');
        }
      }

      try {
        await maintenanceCoordinator?.runBootMaintenance();
      } catch (e) {
        log.warn({ err: e }, '[shadow-maintenance] boot maintenance failed (non-fatal)');
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
            shadowRef.current = await initShadowRepo(projectDir);
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
      try {
        const lastKnownHeadPath = resolve(shadowRef.current.gitDir, 'last-known-head');

        let lastKnownHead: string | null = null;
        try {
          lastKnownHead = readFileSync(lastKnownHeadPath, 'utf-8').trim() || null;
        } catch {
        }

        let currentHead: string | null = null;
        try {
          const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
          currentHead = (await projectGit.revparse('HEAD')).trim() || null;
        } catch {
        }

        if (currentHead !== null) {
          if (currentHead !== lastKnownHead) {
            let branch = 'main';
            try {
              const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
              const b = (await projectGit.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
              if (b && b !== 'HEAD') branch = b;
            } catch {
            }

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
          if (
            configDocName === CONFIG_DOC_NAME_PROJECT ||
            configDocName === CONFIG_DOC_NAME_PROJECT_LOCAL
          ) {
            const enabled = readProjectAutoSyncEnabled();
            void syncEngine?.setEnabled(enabled).catch((err) => {
              log.warn({ err, enabled }, '[sync] failed to apply autoSync.enabled from config');
            });
          }
          const semCfg = readSemanticSearchConfig();
          semanticSearch.applyConfig({
            enabled: semCfg.enabled,
            providerFingerprint: semanticProviderFingerprint(semCfg),
          });
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
        if (parseGlobalSkillBundleDoc(docName)) {
          void backlinkIndex
            .ingestGlobalSkillBundles(
              managedArtifactSkillsRoots(persistence.managedArtifactCtx),
              getActiveBranch(),
            )
            .then(() => {
              signalChannel('backlinks');
              signalChannel('graph');
            })
            .catch((err) => {
              log.warn({ err, docName }, '[backlinks] global skill bundle re-ingest failed');
            });
        }
      };

      try {
        const skillsRoots = managedArtifactSkillsRoots(persistence.managedArtifactCtx);
        const skillsCleanup = await startManagedArtifactWatcher(
          skillsRoots,
          reconcileManagedArtifactDisk,
        );
        configFileWatcherCleanups.push({ docName: '__skill-files__', cleanup: skillsCleanup });
        log.info({ roots: skillsRoots }, '[managed-artifact-watcher] skills started');
      } catch (err) {
        log.warn({ err }, '[managed-artifact-watcher] skills failed to start');
        degraded.push('managed-artifact-watcher:skills');
      }

      try {
        const templateFolders = new Set<string>(['']);
        try {
          for (const t of resolveProjectTemplates(projectDir).templates) {
            templateFolders.add(t.source_folder);
          }
        } catch (err) {
          log.warn({ err }, '[managed-artifact-watcher] template enumeration failed; root only');
        }
        const templateRoots = [...templateFolders].map((f) =>
          f ? resolve(projectDir, f, '.ok', 'templates') : resolve(projectDir, '.ok', 'templates'),
        );
        const templateCleanup = await startManagedArtifactWatcher(
          templateRoots,
          reconcileManagedArtifactDisk,
          TEMPLATE_WATCH_OPTIONS,
        );
        configFileWatcherCleanups.push({ docName: '__template-files__', cleanup: templateCleanup });
        log.info(
          { rootCount: templateRoots.length },
          '[managed-artifact-watcher] templates started',
        );
      } catch (err) {
        log.warn({ err }, '[managed-artifact-watcher] templates failed to start');
        degraded.push('managed-artifact-watcher:templates');
      }
    }

    try {
      const okignorePath = resolve(contentDir, '.okignore');
      const gitignorePath = resolve(projectDir, '.gitignore');
      let gitInfoExcludePath: string | null = null;
      try {
        const probe = spawnSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: 5_000,
        });
        if (probe.status === 0 && probe.stdout) {
          const commonDir = resolve(projectDir, probe.stdout.trim());
          const candidate = join(commonDir, 'info', 'exclude');
          if (existsSync(dirname(candidate))) gitInfoExcludePath = candidate;
        }
      } catch {
      }
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

    const gitDirForInit = resolveGitDir(projectDir);
    const startupBranch = gitDirForInit ? (readBranchFromHead(gitDirForInit) ?? 'main') : 'main';
    switchReconciledBaseScope(startupBranch);
    backlinkIndex.switchBranch(startupBranch);

    try {
      {
        const branch = getActiveBranch();
        try {
          const cacheLoaded = await backlinkIndex.loadFromDisk(branch);
          if (cacheLoaded) {
            const diff = await backlinkIndex.reconcileWithDisk(branch);
            if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
              log.info(diff, '[backlinks] startup reconcile: offline changes applied');
            }
          } else {
            await backlinkIndex.rebuildFromDisk(branch);
          }
          try {
            await backlinkIndex.ingestGlobalSkillBundles(
              managedArtifactSkillsRoots(persistence.managedArtifactCtx),
              branch,
            );
          } catch (err) {
            log.warn({ err, branch }, '[backlinks] global skill bundle ingest failed');
          }
          void backlinkIndex.saveToDisk().catch((err) => {
            console.warn(`[backlinks] Failed to persist startup cache for ${branch}:`, err);
          });
        } catch (err) {
          log.error(
            { err, branch },
            '[backlinks] startup init failed; index will populate incrementally via watcher',
          );
        }
      }
      watcher = await startWatcher(contentDir, onDiskEvent, contentFilter);
      try {
        await tagIndex.init();
      } catch (err) {
        log.error(
          { err },
          '[tag-index] startup re-init failed; tag index updates incrementally via watcher events',
        );
        degraded.push('tag-index');
      }
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
    } catch (err) {
      log.error({ err }, '[server] disk bridge watcher failed to start');
      degraded.push('file-watcher');
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
            const gitDir = resolveGitDir(projectDir);
            const newBranch = gitDir
              ? (readBranchFromHead(gitDir) ?? currentBranch)
              : currentBranch;
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

            switchReconciledBaseScope(newBranch);
            if (backlinkSaveTimer !== null) {
              clearTimeout(backlinkSaveTimer);
              backlinkSaveTimer = null;
            }
            backlinkIndex.switchBranch(newBranch);

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
              log.error({ err, branch: newBranch }, '[basename-index] branch-switch reseed failed');
            }

            for (const [docName, document] of hocuspocus.documents) {
              if (isReservedForUserTree(docName)) continue;
              try {
                const filePath = safeContentPath(docName, contentDir);
                if (!existsSync(filePath)) {
                  const base = getReconciledBase(docName) ?? '';
                  const ours = serializeDoc(docName) ?? '';
                  const isDirty = ours !== base;

                  if (isDirty && shadowRef.current) {
                    const shadowForCheckpoint = shadowRef.current;
                    queueMicrotask(() => {
                      saveInMemoryCheckpoint(shadowForCheckpoint, contentRoot ?? '', {
                        kind: 'external-change-rescue',
                        docName,
                        contents: ours,
                        label: `External change recovered @ ${new Date().toISOString()}`,
                        branch: newBranch,
                        metadata: { incomingDiskSha: '' },
                      })
                        .then(() => {
                          incrementRescueBuffer();
                          log.info(
                            { docName },
                            `[reconcile] rescue checkpoint saved on branch switch: ${docName}`,
                          );
                        })
                        .catch((e: unknown) => {
                          log.error(
                            { docName, err: e },
                            `[reconcile] rescue checkpoint write failed: ${docName}`,
                          );
                        });
                    });
                  }

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
              const branchCacheLoaded = await backlinkIndex.loadFromDisk(newBranch);
              if (branchCacheLoaded) {
                const diff = await backlinkIndex.reconcileWithDisk(newBranch);
                if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
                  log.info(diff, `[backlinks] branch-switch reconcile for ${newBranch}`);
                }
              } else {
                await backlinkIndex.rebuildFromDisk(newBranch);
              }
              try {
                await backlinkIndex.ingestGlobalSkillBundles(
                  managedArtifactSkillsRoots(persistence.managedArtifactCtx),
                  newBranch,
                );
              } catch (err) {
                log.warn(
                  { err, branch: newBranch },
                  '[backlinks] branch-switch global skill bundle ingest failed',
                );
              }
              void backlinkIndex.saveToDisk(newBranch).catch((err) => {
                console.warn(`[backlinks] Failed to persist branch cache for ${newBranch}:`, err);
              });
            } catch (err) {
              log.error(
                { err, branch: newBranch },
                '[backlinks] branch-switch rebuild failed; backlinks may be stale',
              );
            }
            await tagIndex.init();

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
                  await sg.raw('for-each-ref', `refs/wip/${info.oldBranch}/`, '--format=%(refname)')
                ).trim();
                if (refs) {
                  for (const ref of refs.split('\n')) {
                    if (ref) {
                      await sg.raw('update-ref', '-d', ref);
                    }
                  }
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
            cc1Broadcaster?.emitBranchSwitched(newBranch);
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

    const syncCredentialArgs = buildSyncCredentialArgs(localOpCliArgs);
    try {
      syncEngine = new SyncEngine({
        projectDir,
        contentDir,
        contentFilter,
        contentRoot,
        syncEnabled: readProjectAutoSyncEnabled(),
        credentialArgs: syncCredentialArgs,
        cc1Broadcaster,
        detectGh: options.detectGh,
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
    signalChannel('backlinks');
    signalChannel('graph');
    signalChannel('tags');
  }

  initAsync().then(resolveReady, rejectReady);

  return {
    hocuspocus,
    sessionManager,
    cc1Broadcaster,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    contentFilter,
    basenameIndex,
    serverInstanceId,
    destroy,
    ready,
    degraded,
    lockDir,
    get syncEngine() {
      return syncEngine;
    },
  };
}
