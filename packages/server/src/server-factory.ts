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
  type ConfigIssue,
  createBasenameIndex,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  humanFormat,
  isKnownConfigError,
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
import { bootElapsedMs, recordBootPhase, setBootField } from './boot-timings.ts';
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
import { initTelemetry, shutdownTelemetry, withSpan } from './telemetry.ts';
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
  /**
   * When true, register test-only routes (`/api/test-reset`,
   * `/api/test-rescan-backlinks`). Defaults to `false` — these routes mutate
   * server state in ways unsafe for multi-client use and must never be
   * exposed in production. Enable only in tests.
   */
  enableTestRoutes?: boolean;
  /** Shadow repo handle — passed to persistence. */
  shadowRepo?: ShadowHandle;
  /** Content root relative to project dir. */
  contentRoot?: string;
  /**
   * Maximum time (ms) `destroy()` waits for all pending stores to drain
   * before giving up and continuing with the rest of the shutdown sequence.
   * Defaults to 10_000. Tune lower in tests (e.g., 500) to reclaim CI wall-time.
   * Tune higher on slow-disk / NFS environments where a legitimate L1 flush
   * could take more than 10s.
   */
  destroyTimeoutMs?: number;
  /**
   * Optional. Called after every successful agent write (write /
   * edit) via the MCP API. The CLI uses this to open the browser
   * on the first agent edit per session; consumers that don't care can omit.
   */
  onAgentWrite?: () => void;
  /**
   * CLI argv prefix for /api/local-op/* relay endpoints.
   * Defaults to ['open-knowledge'] (CLI on PATH).
   * Pass [process.execPath, process.argv[1]] from start.ts to use the exact
   * runtime that launched this server — necessary in dev (bun + .ts entry).
   */
  localOpCliArgs?: string[];
  /**
   * Server kind written into the lock metadata. `interactive` (default) for
   * user-facing boots; `mcp-spawned` for the MCP detach-spawn path. Desktop
   * attach validation refuses to attach to non-interactive locks.
   */
  lockKind?: 'interactive' | 'mcp-spawned';
  /**
   * Skip the durable state-manifest pre-flight gate
   * (`assertCompatibleStateManifest` from `state-manifest.ts`). Default `false`.
   *
   * Production paths (CLI `ok start`, Electron utility, Vite dev plugin) leave
   * this `false` so an incompatible cold start fails loud before the server
   * touches the shadow repo.
   *
   * The integration test harness passes `true` because each test allocates a
   * fresh tmpdir, so the manifest gate has nothing meaningful to assert and
   * the writes would just generate noise across thousands of tmpdirs.
   */
  skipStateManifestCheck?: boolean;
  /**
   * Override `os.homedir()` for config-doc persistence + file watching. Tests
   * scope user-global writes (`__user__/config.yml`) to a tempdir; if unset,
   * defaults to `os.homedir()` via `resolveConfigPath`. Production callers
   * leave this undefined.
   */
  configHomedirOverride?: string;
  /**
   * Override the MarkdownManager used by persistence's pre-write sanity
   * check (`storeDocumentNow`). Threaded into `PersistenceOptions.mdManager`.
   * Tests inject a dedicated `new MarkdownManager({ extensions: sharedExtensions })`
   * with `spyOn(...).serialize` to exercise the divergent-canonical /
   * serialize-throw paths without coupling the contract to the function's
   * stack frame. Production callers leave this undefined.
   */
  mdManager?: MarkdownManager;
  /**
   * Tier A `gh` CLI token detector. Wired through `SyncEngine` to the
   * push-permission probe so it can resolve a token via `gh auth token`
   * before falling back to Tier B/C. `packages/server` cannot import from
   * `packages/cli` (the implementation's home), so the wiring layer (CLI's
   * `ok start`) passes a concrete instance via this seam. Same shape as
   * `resolveGitIdentity` injection. Defaults to "no gh available" when
   * omitted — leaves the probe to anonymous resolution.
   */
  detectGh?: DetectGhFn;
  /**
   * Tier B/C OK credential store. Wired through `SyncEngine` to the
   * push-permission probe. Same dependency-injection rationale as
   * `detectGh` above. `null` is acceptable for "no token store available"
   * (e.g., test or embedded contexts); omit entirely for the same effect.
   */
  tokenStore?: ProbeTokenStore | null;
  /**
   * Override the push-permission probe function. Production callers leave
   * this undefined; tests pass a spy to verify the wiring chain
   * (`createServer` → `SyncEngine`) propagates `detectGh` / `tokenStore`
   * through to the probe without hitting `fetch()` against api.github.com.
   * Mirrors `SyncEngineOptions.checkPushPermissionFn`.
   */
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  /**
   * Read-only accessor for the embeddings API key (the CLI's 0600
   * `~/.ok/secrets.yml` file), injected from the CLI / desktop wiring layer.
   * Same dependency-injection seam as `tokenStore`.
   * `null` / omitted → semantic search relies on the `OK_EMBEDDINGS_API_KEY`
   * env fallback (dev / CI smoke) and is otherwise incapable (degrades to BM25).
   */
  embeddingsKeyStore?: EmbeddingsKeyStore | null;
  /**
   * Override the semantic-search embedder loader. Production leaves this
   * undefined and the OpenAI-compatible HTTP embedder is used; the integration
   * harness injects a deterministic concept embedder so a suite exercises the
   * real engine + cache + ranking with no network. Same rationale as
   * `detectGh` / `tokenStore`.
   */
  embedderLoader?: () => Promise<Embedder | null>;
  /**
   * Single-file content scope (no-project ephemeral open). When set to a
   * contentDir-relative path, the content filter admits ONLY that one document
   * (see `ContentFilterOptions.singleDocRelPath`), the full-tree refcount walk
   * is skipped, and the basename index for `![[sibling]]` embeds is seeded from
   * a bounded one-directory scan instead of the recursive asset walk. Set by
   * the `ok <file>` / desktop single-file open path; always paired with
   * `ephemeral: true` in production, but kept separate so the content-scope
   * mechanism is testable on its own.
   */
  singleDocRelPath?: string;
  /**
   * No-project ephemeral mode (the `ok <file>` single-file open with no
   * enclosing project). Distinct from `singleDocRelPath`, which scopes content:
   * `ephemeral` governs the no-project *behaviors* — config Y.Docs are NOT
   * pre-materialized, the config / ignore-file watchers do not start, the three
   * contentDir write paths (okignore config-doc, folder-rule, template) are
   * inert, and persistence suppresses load-canonicalization rewrites against
   * the as-loaded baseline (see `PersistenceOptions.ephemeral`). MCP is
   * unmounted by the boot layer (`bootServer`), not here. Default `false`.
   */
  ephemeral?: boolean;
}

export interface ServerInstance {
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  cc1Broadcaster: CC1Broadcaster;
  agentFocusBroadcaster: AgentFocusBroadcaster;
  agentPresenceBroadcaster: AgentPresenceBroadcaster;
  /**
   * Shadow-repo maintenance coordinator. Exposed so boot can wire the
   * session-close trigger through `mountMcpAndApi`. Undefined in plugin/ephemeral
   * modes that have no shadow repo.
   */
  maintenanceCoordinator?: MaintenanceCoordinator;
  contentFilter: ContentFilter;
  /**
   * In-memory basename → paths index used by the mdast→PM wiki-embed
   * handler. Seeded at boot from disk; updated live via the asset arms
   * of handleDiskEvent.
   */
  basenameIndex: BasenameIndex;
  /**
   * Random UUID generated once per `createServer()` call. Advertised to
   * clients via `GET /api/server-info` + the `__system__` CC1 `server-info`
   * channel. Clients cache the last-observed ID and include it in the
   * `expectedServerInstanceId` field of their auth token on every connect —
   * `onAuthenticate` rejects on mismatch, forcing a clean client recycle
   * before Yjs sync can merge stale-client state with a post-restart
   * server Y.Doc. Part of the CRDT server-restart recovery defense.
   */
  readonly serverInstanceId: string;
  destroy: () => Promise<void>;
  /** Resolves when async init (shadow repo, file watcher subscription) is complete. */
  ready: Promise<void>;
  /**
   * Names of subsystems that failed to initialize during boot.
   * Read AFTER `await ready` for a stable list; reads before may return a partial result.
   * Empty array means all subsystems initialized successfully.
   * Possible values: `'shadow-repo'`, `'managed-rename-recovery'`, `'file-watcher'`,
   * `'head-watcher'`.
   */
  readonly degraded: readonly string[];
  /**
   * Directory holding the server lock (`<contentDir>/.ok/local`).
   * Callers update the lock's port field via `updateServerLockPort(lockDir, port)`
   * once the HTTP listener has bound to a kernel-assigned port.
   */
  readonly lockDir: string;
  /** Active sync engine instance, or null if dormant / no remote detected. */
  readonly syncEngine: SyncEngine | null;
}

/**
 * Transaction origin for park-snapshot reads.
 *
 * Wrapping each serializeDoc() call inside doc.transact(..., PARK_SNAPSHOT_ORIGIN)
 * ensures Y.js serializes the snapshot capture atomically against concurrent
 * in-flight transactions. skipStoreHooks: false — the transact is read-only
 * (no Y.Doc mutations) so onStoreDocument will not fire. paired: true — if a
 * concurrent observer somehow fires, it short-circuits symmetrically.
 */
const PARK_SNAPSHOT_ORIGIN = (() => {
  const ctx = Object.freeze({ origin: 'park-snapshot', paired: true as const });
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: ctx,
  }) satisfies PairedWriteOrigin;
})();

/**
 * Build the git `-c credential.helper=…` args that let SyncEngine's fetch/push
 * authenticate by shelling out to our own CLI's `auth git-credential` helper.
 *
 * Git runs a `!`-prefixed credential helper through the shell, so every argv
 * element must be shell-quoted. The packaged macOS CLI path lives under
 * `/Applications/OpenKnowledge.app/…` — the space splits unquoted, the shell
 * fails to exec, the helper returns no credentials, and git falls back to an
 * interactive username prompt with no TTY ("could not read Username … Device
 * not configured"). `shellEscape` per argv element is the fix.
 */
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

  function readProjectAttachmentFolderPath(): string {
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
      log.warn(
        {},
        '[config] committed content.attachmentFolderPath unavailable (project config invalid) — using default attachment placement',
      );
    }
    return project.value.content.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH;
  }

  function readProjectAutoSyncEnabled(): boolean {
    const local = readConfigSafely({
      absPath: resolveConfigPath('project-local', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
    const localEnabled = local.value.autoSync?.enabled;
    if (localEnabled !== null && localEnabled !== undefined) {
      // This machine has answered (or the engine auto-disabled on a denied
      // push probe) — the per-machine choice always wins over the committed
      // default.
      return localEnabled === true;
    }
    // The file was present but failed validation — readConfigSafely already
    // logged the parse/schema detail. Surface the fallback decision so a
    // user staring at "sync started disabled" can correlate it with the
    // earlier read warning instead of two separate, unconnected log lines.
    if (!local.valid) {
      log.warn(
        {},
        '[config] project-local autoSync.enabled unavailable (config invalid) — falling back to the committed project default',
      );
    }
    // Unanswered on this machine: consult the committed project default
    // (`autoSync.default`), which a maintainer ships in `.ok/config.yml` to
    // pre-answer the onboarding prompt for everyone who clones the project.
    // `true` seeds sync on; `false`/`null`/absent leaves it off here (and when
    // the committed default is `null`/absent the onboarding gate prompts).
    //
    // We deliberately do NOT read a committed `autoSync.enabled`: that field is
    // project-local-scoped, so a committed value is a scope mismatch. The app
    // is unreleased, so none exist in the wild; ignoring it keeps the committed
    // sync knob singular (`autoSync.default`).
    const project = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
      warn: (message) => log.warn({ message }, '[config] could not read project config'),
    });
    // Mirror the project-local invalid-config correlation above: a corrupt
    // committed `.ok/config.yml` means we can't read the maintainer's
    // `autoSync.default`, so sync silently defaults to disabled. Surface the
    // downstream consequence so a user debugging "sync started disabled on a
    // project that ships default: true" can connect it to the parse warning.
    if (!project.valid) {
      log.warn(
        {},
        '[config] committed autoSync.default unavailable (project config invalid) — defaulting to disabled',
      );
    }
    return project.value.autoSync?.default === true;
  }

  // Project-local-only read (shared with `ok embeddings status` so they can't
  // disagree). Read fresh (not from the boot snapshot) so the config watcher's
  // re-evaluation picks up runtime edits.
  function readSemanticSearchConfig(): ResolvedSemanticConfig {
    return readProjectLocalSemanticConfig(projectDir, {
      configHomedirOverride,
      onWarn: (message) => log.warn({ message }, '[config] could not read project-local config'),
    });
  }

  // Provider identity for the cache key + the service's re-warm trigger. A change
  // here (provider/model/dims) re-loads the embedder and invalidates the cache.
  function semanticProviderFingerprint(cfg: ResolvedSemanticConfig): string {
    return `${normalizeProviderId(cfg.baseUrl)}|${cfg.model}|${cfg.dimensions ?? DEFAULT_EMBEDDINGS_DIMENSIONS}`;
  }

  // Re-apply a just-persisted config to the live in-process consumers by
  // re-reading it fresh from disk. Shared by two entry points: the producer-side
  // `onConfigPersisted` notification (self-originated Y.Doc writes) and the
  // config-file-watcher callback (genuinely external edits). The producer path is
  // load-bearing because the chokidar echo is a non-guaranteed, OS-mediated
  // filesystem-event channel — a dropped event otherwise leaves a consumer
  // diverged from disk until restart. Hoisted so `onConfigPersisted` can
  // reference it before `syncEngine` is assigned; both consumers resolve at call
  // time (persist time), always after their assignment.
  //
  // Both entry points can fire for the same change (producer notify + watcher
  // echo), so every consumer notified here MUST be idempotent on a same-value
  // re-apply: `SyncEngine.setEnabled` and `SemanticSearchService.applyConfig`
  // both early-return when the value is unchanged. A future non-idempotent
  // consumer added here would double-fire.
  function applyPersistedConfigToConsumers(configDocName: string): void {
    let appliedAutoSyncEnabled: boolean | undefined;
    if (
      configDocName === CONFIG_DOC_NAME_PROJECT ||
      configDocName === CONFIG_DOC_NAME_PROJECT_LOCAL
    ) {
      appliedAutoSyncEnabled = readProjectAutoSyncEnabled();
      void syncEngine?.setEnabled(appliedAutoSyncEnabled).catch((err) => {
        log.warn(
          { err, enabled: appliedAutoSyncEnabled, docName: configDocName },
          '[sync] failed to apply autoSync.enabled from config',
        );
      });
    }
    // Re-evaluate semantic search on every config-doc store. `readSemanticSearchConfig`
    // resolves the project-local layer only, so only a project-local `search.semantic.*`
    // edit changes the result; other layers re-read to the same value (a no-op via
    // `applyConfig`'s early-return). A live disable frees the resident vectors; a
    // provider/model/dims change re-warms. No eager embed — the next opt-in search
    // drives the corpus pass.
    const semCfg = readSemanticSearchConfig();
    semanticSearch.applyConfig({
      enabled: semCfg.enabled,
      providerFingerprint: semanticProviderFingerprint(semCfg),
    });
    log.info(
      {
        docName: configDocName,
        autoSyncEnabled: appliedAutoSyncEnabled,
        semanticEnabled: semCfg.enabled,
      },
      '[config] applied persisted config to in-process consumers',
    );
  }

  // Initialize OpenTelemetry before any spans could be emitted. No-op when
  // OTEL_SDK_DISABLED != 'false' (default — zero overhead). Idempotent; safe
  // to call multiple times (bootServer also calls it, but dev-plugin path
  // bypasses bootServer and enters createServer directly).
  initTelemetry();

  // Generated once per process. Advertised to clients so they can detect
  // restart-across-reconnect before Yjs sync merges stale state. See the
  // field docstring on ServerInstance.serverInstanceId for the full
  // defense-in-depth flow.
  const serverInstanceId = randomUUID();

  // Acquire server lock BEFORE any side effects (shadow repo init, file watcher,
  // HTTP listen, etc.). Collides fast with another running server in the same
  // project. Port may be 0 here — the CLI rewrites it post-listen via
  // `updateServerLockPort(lockDir, realPort)`.
  //
  // Anchored to projectDir, not contentDir: per-project runtime state lives at
  // the project root so one repo presents a single `.ok/local/` directory
  // regardless of `content.dir`. Two windows opening the same project with
  // different `content.dir` settings still collide on the same lock — desired,
  // because one server services one project.
  const lockDir = getLocalDir(projectDir);
  acquireServerLock(lockDir, {
    port: options.port ?? 0,
    worktreeRoot: projectDir,
    kind: options.lockKind ?? 'interactive',
    // Every server booted through `createServer` wires Hocuspocus + WS
    // upgrade in `boot.ts`. The capability flag lets future variants
    // (e.g. an HTTP-only relay) advertise differently.
    capabilities: ['http', 'ws'],
  });

  // Durable state-manifest gate. Runs AFTER lock acquisition so two
  // cold-starting binaries serialize through the lock first, then the loser
  // fails fast on ProcessLockCollisionError before reaching the manifest
  // check. Runs BEFORE any shadow-repo or persistence side effect so an
  // incompatible cold start refuses to boot before any durable mutation.
  //
  // Skipped when the caller passes `skipStateManifestCheck: true` — used by
  // the integration test harness, which allocates a fresh tmpdir per test
  // (no pre-existing state to gate on; writes would just generate noise
  // across thousands of throwaway content dirs).
  //
  // On throw, release the lock before propagating so other processes can
  // proceed (matches the cleanup path below for synchronous-init failures).
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

  // In-memory basename index for asset embed resolution. Populated from disk
  // at boot, kept in sync via the asset-event arms of handleDiskEvent. Plain
  // Map under the hood; rebuilds are cheap so no disk persistence.
  const basenameIndex: BasenameIndex = createBasenameIndex();

  // `![[photo.png]]` embed refs resolve via the basename index. Shared by
  // persistence (onLoadDocument), server Observer B (Y.Text → XmlFragment),
  // the agent-write path, and external-change (disk → CRDT), so wherever
  // markdown is parsed into the Y.Doc the embed's PM src/href reflects the
  // current vault state. Returns null on unknown basename — the PM dispatch
  // falls back to the literal target (broken-ref placeholder).
  const resolveEmbed = (basename: string, sourcePath: string): string | null =>
    basenameIndex.resolveEmbed(basename, sourcePath);

  // `![[doc.pdf]]` (and other FILE_ATTACHMENT_EXTENSIONS) resolves to a
  // disk path; statSync returns the byte size which the wikiLinkEmbed
  // parser handler formats via `formatFileSize` and stamps on the
  // resulting `WikiEmbedFile` jsxComponent's `size` prop. Two-stage
  // resolution: (1) basename-index lookup (matches `resolveEmbed`'s
  // shape — handles bare basename targets like `![[sample.pdf]]` whose
  // canonical path lives in some indexed subtree); (2) if that misses
  // and the target looks like a relative path with a directory prefix
  // (e.g. `![[showcase/sample.pdf]]`), treat the target as the path
  // directly and stat against contentDir. The fallback is critical for
  // path-prefixed wikilinks the basename-index doesn't carry as keys.
  //
  // Returns null on:
  //   - bare basename misses (basename-index lookup fails AND no
  //     directory prefix to fall back to)
  //   - any fs.statSync failure (file moved / permission denied / race)
  //
  // The renderer (`File.tsx`) handles a missing size by simply omitting
  // the size span — graceful degradation, no error UI needed.
  const resolveSize = (basename: string, sourcePath: string): number | null => {
    let candidatePath: string | null = basenameIndex.resolveEmbed(basename, sourcePath);
    if (!candidatePath && basename.includes('/')) {
      // Strip any leading `./` or `/` so the join below stays inside
      // contentDir. The handler upstream applies the same normalize step
      // to `srcOrTarget` for the rendered `<a href>`, so what statSync
      // checks lines up with what the browser will fetch.
      candidatePath = basename.replace(/^\.?\//, '');
    }
    if (!candidatePath) return null;
    // Containment check — `..` segments in a wikilink target must not
    // escape contentDir via `path.resolve`. Without this, a crafted
    // `![[../../etc/hostname]]` would let `statSync` probe the host
    // filesystem and leak file existence + byte size into the CRDT
    // (visible to all connected clients via the rendered `size` prop).
    // Mirrors the `resolve + startsWith` pattern used elsewhere in this
    // file for shadow-checkpoint base containment.
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

  // Synchronous init — if any constructor throws, release the lock before propagating.
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

  // Semantic-search service. Always constructed (cheap, inert until enabled +
  // keyed; the loader makes no network call). The api-extension drives the lazy
  // embed + query-time fusion on opt-in searches; the config watcher drives
  // enable/disable + provider re-warm. The loader reads config FRESH each call
  // so a runtime provider/model/dims change re-warms cleanly.
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

  // Mutable principal holder — populated by the async load in initAsync.
  let loadedPrincipal: Principal | null = null;
  const forceUnloadSet = new Set<Document>();
  let shutdownAllowsUnload = false;
  // Assigned synchronously in the init `try` immediately after `new Hocuspocus` (before the try
  // completes or awaits). Call sites (disk reconcile, API extension) only run after boot returns.
  let forceUnloadDocument!: (document: Document) => Promise<void>;

  // Deferred `ready` promise. Settled by `initAsync()`'s completion at the
  // bottom of this factory. Declared here (instead of `const ready = initAsync()`
  // at the call site) so callers like `createApiExtension` — which is wired
  // BEFORE `initAsync` runs — can receive a stable handle to await against.
  // Used by `handleDocumentList` (and any sibling handler reading the watcher
  // file/folder index) to park first-fetch responses until the seed walk has
  // populated those indexes, eliminating the cold-start "No files yet" flash.
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  function signalChannel(channel: 'files' | 'backlinks' | 'graph' | 'tags'): void {
    cc1Broadcaster?.signal(channel);
  }

  // Debounced saveToDisk for watcher-event paths. Collapses bursts (e.g. a git
  // clone landing many files) into a single write. Startup and branch-switch
  // paths call backlinkIndex.saveToDisk() directly — those are deliberate
  // full-state transitions that should not be deferred.
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

  // Per-process LRU cache of docNames renamed away or deleted since boot.
  // Read by `removalRedirectGuard` (registered below) to reject WebSocket
  // connections to stale docNames before any Y.Doc work runs (the single
  // enforcement point that prevents IDB-resync from recreating the file at
  // the OLD path). Populated by the rename spine + delete handler in
  // `api-extension.ts` and by the watcher reconcile callbacks below;
  // invalidated by `/api/create-page` and the watcher 'add' event.
  // Declared at createServer scope so `handleDiskEvent` and the api
  // extension factory both close over the same instance.
  const recentlyRemovedDocs = new RecentlyRemovedDocs(undefined, {
    onEviction: () => incrementRecentlyRemovedDocsEviction(),
    onSizeChange: (size) => setRecentlyRemovedDocsSize(size),
  });
  // Lambda-callback shape mirrors `onDiskFlush` (`persistenceOpts`) — keeps
  // the watcher reconcile cases free of direct cache references and avoids
  // extending `signalChannel`'s union for a per-event side effect.
  const onUpstreamRename = (oldDocName: string, newDocName: string): void => {
    if (isReservedForUserTree(oldDocName)) return;
    recentlyRemovedDocs.setRenamed(oldDocName, newDocName);
  };
  const onUpstreamDelete = (docName: string): void => {
    if (isReservedForUserTree(docName)) return;
    // Watcher rename-pairing heuristic (`@parcel/watcher`'s content-hash
    // match across delete+create) occasionally fails to pair a
    // managed-rename's split events. When that happens, the watcher fires
    // an isolated `delete` for the old path AFTER the spine has already
    // recorded a `'renamed'` entry, and a naive setDeleted would
    // overwrite the spine's authoritative redirect signal — degrading the
    // user-visible UX from "tab remaps to the new doc" to "tab navigates
    // home". Refuse the downgrade. A genuine delete that the spine never
    // observed (external `rm`, MCP `delete` after a rename) goes
    // through the explicit `handleDeletePath` populate and bypasses this
    // guard via `recentlyRemovedDocs.setDeleted` directly.
    if (recentlyRemovedDocs.peek(docName)?.kind === 'renamed') {
      // Surface the suppression so a degraded watcher heuristic (e.g. after
      // a `@parcel/watcher` upgrade) is detectable as a rate signal rather
      // than invisible drift.
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
        // Re-derive backlink + tag indexes against the new visible-set.
        // Both indexes hold a live reference to ContentFilter, so they
        // read the freshly-rebuilt state on their next call. Failures
        // are logged but never roll back the rebuild — the in-memory
        // ignore filter is correct; derived views may go stale until
        // the next external trigger.
        //
        // All three re-derivations below are fire-and-forget and run
        // concurrently. Rapid successive ignore-file edits can overlap
        // them; that's fine — each walk reads the live ContentFilter, so
        // the last rebuild's visible-set wins and the end state converges
        // (TagIndex additionally serializes its init calls internally).
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
        // Reconcile the watcher's in-memory file/folder indexes with the
        // new ContentFilter visible-set. Symmetric pair:
        //   1. Prune now-excluded entries (pattern added).
        //   2. Re-scan disk for now-included entries (pattern removed).
        // Ignore-file edits do NOT emit per-entry FSEvents for paths whose
        // included-ness flipped, so this reconcile is the only thing that
        // keeps `/api/documents` (and other index consumers) in sync with
        // disk across runtime `.okignore` / `.gitignore` edits.
        void reconcileFileIndexAfterFilterRebuild(watcher)
          .then(({ prunedFiles, prunedFolders }) => {
            const pruned = prunedFiles + prunedFolders;
            if (pruned > 0) {
              getLogger('server-factory').info(
                { pruned, prunedFiles, prunedFolders },
                '[content-filter] reconciled file indexes after onAfterRebuild',
              );
            } else {
              // The rescan direction (pattern removal → re-include) produces
              // zero prune counts, so the info log above doesn't fire for it.
              // A debug breadcrumb confirms the reconcile ran when the operator
              // needs a trail (no production overhead when debug is disabled).
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
    // Boot-time scan, fire-and-forget: the factory itself is synchronous.
    // `initAsync` awaits a second `init()` after the watcher starts; TagIndex
    // serializes the two internally, so by the time `ready` resolves the
    // index reflects disk.
    void tagIndex.init().catch((err) => {
      getLogger('server-factory').warn(
        { err },
        '[server-factory] tag-index init failed; continuing with empty index',
      );
    });

    shadowRef = { current: shadowRepo };

    // Shadow-repo maintenance coordinator. `getShadow` reads the live
    // ref so it stays correct across the deferred shadow re-init paths. The
    // liveness + branch deps are closure-deferred (sessionManager / presence
    // broadcaster are assigned below) — same pattern as onAgentCommit. Gated +
    // off the write path; only constructed when git is enabled (a shadow exists).
    maintenanceCoordinator = gitEnabled
      ? createMaintenanceCoordinator({
          getShadow: () => shadowRef.current ?? null,
          getCurrentBranch: () => headWatcher?.getLastKnownBranch() ?? null,
          contentRoot: contentRoot ?? '',
          projectGitDir: resolveGitDir(projectDir) ?? undefined,
          isWriterLive: (writerId) => {
            // A live keepalive heartbeat (presence map) is the primary signal; an
            // in-process session covers HTTP-only callers without keepalive.
            // Both deps are closure-deferred (assigned later in init). If BOTH are
            // still unset when this runs — a maintenance trigger somehow firing
            // before init wired them up — every writer reads as dead and the auto
            // path could over-consolidate. The boot-order invariant means this
            // should never happen, so log at debug rather than silently degrading.
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
      // Emit CC1 ch:'session-activity' after any agent writer commits so
      // Activity Panel clients get live invalidations. cc1Broadcaster is
      // initialized after persistence but captured by closure reference —
      // the callback always sees the latest value.
      onAgentCommit: () => cc1Broadcaster?.signal('session-activity'),
      // Count each shadow flush-commit toward the coordinator's ~200-commit gc
      // trigger. Cheap counter bump; gc fires off the write path.
      onFlushCommit: () => maintenanceCoordinator?.noteFlushCommit(),
      // Emit CC1 ch:'disk-ack' after each successful L1 write so clients
      // can advance their `lastDiskAckedSV` watermark. Same closure-deferred
      // pattern as `onAgentCommit` — broadcaster is initialized after
      // persistence but captured by reference.
      onDiskFlush: (docName, sv, persistedMarkdown, previousMarkdown) => {
        cc1Broadcaster?.emitDiskAck(docName, sv);
        if (isReservedForUserTree(docName)) return;
        if (!assetReferencesChanged(previousMarkdown, persistedMarkdown)) return;
        invalidateReferencedAssetsCache?.();
        signalChannel('files');
      },
      // L3 validation rejection. Fired when the config-doc branch reverts
      // Y.Text to LKG; the broadcast tells any open Settings pane to surface
      // the rejection toast + flash the affected field. Same closure-deferred
      // pattern.
      onConfigRejected: (docName, error) =>
        cc1Broadcaster?.emitConfigValidationRejected(docName, error),
      // Producer-side hot-apply. Fired when the config-doc branch durably
      // persists (or reconciles) a self-originated change; re-applies it to the
      // live consumers directly so a dropped chokidar echo can't strand them.
      // Closure-deferred: `syncEngine`/`semanticSearch` resolve at call time,
      // always after their assignment.
      onConfigPersisted: applyPersistedConfigToConsumers,
      mdManager: options.mdManager,
    };

    persistence = createPersistenceExtension(persistenceOpts);

    hocuspocus = new Hocuspocus({
      quiet,
      debounce,
      maxDebounce,
      extensions: [persistence.extension],
    });

    // Hocuspocus unloads documents as soon as the last WebSocket disconnects.
    // That is unsafe with client-side y-indexeddb: a browser refresh leaves a
    // durable client copy of the same Yjs items, while the server rebuilds a
    // fresh Y.Doc from markdown. The next sync union-merges both item sets and
    // duplicates the document. Keep normal user docs resident for the server
    // lifetime; explicit lifecycle paths opt into unload via `forceUnloadDocument`.
    //
    // Phantom-doc unload (memory-DoS defense): a Y.Doc that was never confirmed
    // to back an on-disk file (no `reconciledBase` set) AND holds no in-memory
    // content (empty XmlFragment + empty Y.Text) is releasable when its last
    // connection drops. The cache-epoch-recovery rationale above does not apply
    // — there's no on-disk baseline an IDB cache could duplicate against, and
    // the persistence layer's phantom-doc guard already refuses 0-byte writes
    // for these. Without this carve-out, a local caller (browser tab, MCP
    // agent, DNS-rebound origin) could connect to an arbitrary stream of
    // unique non-existent docNames and grow `hocuspocus.documents` without
    // bound for the server's lifetime, exhausting memory. The fragment-empty
    // + ytext-empty gate preserves transient connections that wrote real
    // content (the next persistence cycle will set `reconciledBase` and
    // future unload checks return false for them).
    const defaultShouldUnloadDocument = hocuspocus.shouldUnloadDocument.bind(hocuspocus);
    hocuspocus.shouldUnloadDocument = (document) => {
      // `forceUnloadDocument` (delete-path's `captureAndCloseDocuments`) bypasses
      // every guard — including the default's `hasPendingWork === false` AND
      // `getConnectionsCount() === 0` checks. The default's connection-count
      // gate races `closeConnections()`: WS close frames ship synchronously,
      // but each connection's teardown finishes on its own event-loop tick,
      // so the count is still non-zero when `forceUnloadDocument` awaits
      // `unloadDocument`. Without this bypass, the document stays resident
      // and the next client to reconnect rejoins the in-memory Y.Doc — which
      // surfaces as "I deleted this file and created a new one with the same
      // name, but the editor shows the old content" because no fresh
      // `onLoadDocument` runs to read the new (empty) file from disk.
      //
      // The pending-work check is also bypassed: the file is being unlinked,
      // so any pending `onStoreDocument` debounce for this doc is operating
      // on bytes that will never be reachable again. `captureAndCloseDocuments`
      // unconditionally snapshots `liveContents` for both renames and deletes
      // before closing; the rename path reapplies the snapshot via
      // `syncRenamedDocsToDisk`, the delete path discards it because the file
      // is unlinked.
      if (forceUnloadSet.has(document)) {
        return true;
      }
      // Shutdown drain (`shutdownAllowsUnload`) still requires the default
      // guards to pass — the orchestrating `flushAllStoresAndWait` calls
      // `flushPendingStores()` and `closeConnections()` first, then waits
      // for the resulting `onStoreDocument` writes + WS teardowns to settle
      // before unload becomes admissible. Bypassing the default's
      // pending-work check would forfeit those writes (the disk wouldn't
      // see the user's last unsynced state).
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

    // Browser tabs supply { principalId, tabSessionId } via the auth token.
    // onAuthenticate parses the JSON token and hoists identity into connection
    // context so persistence.resolveWriterFromOrigin sees source:'connection'
    // with ctx.principalId set. Missing or invalid tokens are silently ignored
    // (connection proceeds with SERVICE_WRITER fallback — non-browser clients
    // like test harness and MCP never send tokens).
    //
    // The token is unauthenticated — a rogue browser tab (or a page that
    // discovers the localhost port + passes the Origin allowlist) could claim
    // any principalId it invents. We pin ctx.principalId to loadedPrincipal.id
    // when the claim matches the server's loaded principal, and ignore the
    // claim otherwise (falling back to SERVICE_WRITER via resolveWriterFromOrigin).
    // This closes attribution-forgery on the single-user loopback deployment
    // without requiring a signed token. When multi-principal support is ever
    // added, upgrade this to a signed handshake from .ok/local/principal.json.
    const principalAuthExtension: Extension & { __kind: 'principal-auth' } = {
      // Named marker so test code can find THIS extension specifically rather
      // than "the first extension with an onAuthenticate hook" — future
      // additions of other onAuthenticate-carrying extensions won't silently
      // break identity-based extraction.
      __kind: 'principal-auth',
      async onAuthenticate(payload) {
        const tokenStr = payload.token;
        // Route the parse through the Zod schema so the v3→v4 forward-compat
        // story stays honest (fields we haven't seen yet survive via
        // `.loose()`). Legacy untokened clients and malformed tokens both
        // return `undefined` — we continue through the existing accept path.
        const parsed = parseHocuspocusAuthToken(tokenStr);

        // CRDT server-restart recovery: if the client claimed a specific
        // serverInstanceId and it doesn't match OUR instance ID, throw with
        // `reason: 'server-instance-mismatch'` so the client's
        // `authenticationFailed` handler can recycle all providers BEFORE
        // any Yjs sync runs (which would merge ghost items under the stale
        // clientID — the root cause this defends).
        // Empty-string claim is treated as absent (matches client-side
        // `buildAuthToken` behavior). Legacy clients without the field
        // are accepted unconditionally for backward compat.
        const claimed = parsed?.expectedServerInstanceId;
        if (typeof claimed === 'string' && claimed.length > 0 && claimed !== serverInstanceId) {
          throw new HocuspocusAuthRejection(
            'server-instance-mismatch',
            `server instance mismatch: client claimed ${claimed}, this server is ${serverInstanceId}`,
          );
        }

        // Cross-branch invalidation late-join backstop. Mirrors the
        // expectedServerInstanceId pattern. CC1 `branch-switched` is a
        // stateless broadcast with no replay; clients offline during the
        // emit, or fresh tabs restored from stale-branch IDB, would
        // otherwise re-sync against the new branch with branch-A items
        // still in IDB. Comparing the claimed branch against the live
        // `getActiveBranch()` and rejecting on mismatch routes those
        // clients through `handleBranchSwitched` BEFORE Yjs sync can
        // union-merge stale-branch state. Empty / absent claim = legacy
        // path (accepted unconditionally).
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
          // Pin to loaded principal when the claim matches; ignore on mismatch.
          if (loadedPrincipal && parsed.principalId === loadedPrincipal.id) {
            ctx.principalId = loadedPrincipal.id;
          } else if (loadedPrincipal) {
            // Claim doesn't match — log at warn and omit principalId so the
            // write falls through to SERVICE_WRITER. Preserves observability
            // without letting the claim through.
            console.warn(
              JSON.stringify({
                event: 'principal-token-mismatch',
                claimed: parsed.principalId,
                loaded: loadedPrincipal.id,
              }),
            );
          }
          // When loadedPrincipal is null (not yet loaded), accept the claim
          // — the async load is best-effort and browser writes need a writer
          // ID even in the brief pre-load window. Classified writer fallback
          // happens via resolveWriterFromOrigin when loaded fields aren't
          // available for display-name lookup.
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

    // Config-doc admission gate. The synthetic `__config__/project` and
    // `__user__/config.yml` Y.Docs are pre-materialized via
    // `hocuspocus.openDirectConnection()` at boot and remain resident for the
    // server's lifetime. Any client that reaches the `/collab` WebSocket can
    // open them by name — at which point Y.Text mutations flow through
    // `storeConfigDoc` → `atomicWriteConfig` and persist to disk under the
    // user's `.ok/config.yml` (project) or `~/.ok/global.yml` (user). A valid
    // YAML payload from an unauthenticated peer therefore mutates real
    // settings such as `autoSync.enabled`, `server.host`, `mcp.autoStart`,
    // etc., which the file-watcher pipeline then reflects into runtime
    // behavior (e.g. flipping git auto-sync on).
    //
    // The /collab WS upgrade in `mcp-mount.ts` does NOT enforce loopback or
    // host-header validation today (the keepalive sibling does). Even if it
    // did, the server's `host` option allows binding non-loopback addresses
    // (`0.0.0.0`/`::`), so config-doc admission must be gated independently
    // at the document level. Match the DNS-rebinding defense pattern used by
    // /api/* mutating routes (`api-extension.ts`) and /mcp + keepalive
    // (`mcp-mount.ts`):
    //   - TCP peer must be loopback (when the socket is observable).
    //   - Host header must be a loopback shape (`localhost` / `127.x.y.z` /
    //     `[::1]`, with optional port) — defends against a rebinding page
    //     whose hostname resolves to 127.0.0.1 after the initial fetch.
    //
    // Other documents are unaffected; this gate fires only when the client
    // requests a config doc. `openDirectConnection` (used at boot for
    // pre-materialization) bypasses `onAuthenticate` entirely, so the gate
    // does not interfere with server-internal admission.
    const configDocAdmissionGuard: Extension & { __kind: 'config-doc-admission-guard' } = {
      __kind: 'config-doc-admission-guard',
      async onAuthenticate(payload) {
        // Same loopback/rebinding defense for config AND managed-artifact docs
        // (skills/templates write to `.ok/` + `~/.ok/` — same threat class).
        if (!isConfigDoc(payload.documentName) && !isManagedArtifactDoc(payload.documentName)) {
          return;
        }
        // `payload.request` is typed as Web `Request` by Hocuspocus but is in
        // fact the Node `IncomingMessage` we hand to `handleConnection` in
        // `mcp-mount.ts` — `req as unknown as Request`. Read the runtime
        // shape via a structural cast so we can inspect the underlying
        // socket and headers. Test harnesses that invoke `onAuthenticate`
        // directly with a synthetic payload may omit the socket; treat
        // a missing socket as test-context (matches `api-extension.ts`'s
        // mutating-route gate convention) and fall through to the
        // host-header check, which still enforces the rebinding defense.
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
        // Headers can arrive either as the Node IncomingMessage `headers`
        // bag or, when Hocuspocus surfaces a real Web `Request`, as a
        // `Headers` instance via `payload.requestHeaders`. Prefer the
        // structured `requestHeaders.get('host')` because it is consistent
        // across both code paths; fall back to `req.headers.host` when the
        // Headers object is absent (synthetic test payloads).
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

    // Phantom-resurrection defense: reject WebSocket connections to docNames
    // that have been renamed away or deleted since boot, redirecting clients
    // to the live target (rename) or sending them home (delete) before any
    // Y.Doc work runs. Without this guard, a browser tab with an open
    // provider for the OLD docName auto-reconnects after the disk move and
    // pushes its IDB-cached Y.Doc state via syncStep2, recreating the file
    // at the OLD path.
    //
    // Algorithm + STOP-rule wrapping live in `runRemovalRedirectGuard` so
    // the file-existence-first check, the cycle-protected chain walk, and
    // the defensive try/catch fall-through can be unit-tested without a
    // full Hocuspocus instance.
    const resolvedContentDir = resolve(contentDir);
    function resolveDocFilePath(docName: string): string | null {
      // Refuse paths that escape the content root, then concatenate the
      // recorded extension (`.md` / `.mdx` / `.MD`) so the existsSync check
      // matches the real on-disk casing rather than always probing for `.md`.
      // The traversal-character set lives in `isSafeDocName` (api-extension.ts)
      // so the security-relevant validation only exists in one place.
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

    // Per-doc lineage fence — third axis of the stale-client-persistence
    // defense (instance → branch → doc lineage). The server mints a fresh
    // Yjs lineage epoch whenever persistence seeds a doc from disk
    // (`persistence.ts` onLoadDocument), but the client's IDB cache is
    // keyed per (branch, instance, doc) — so a doc the server unloaded and
    // re-seeded WITHIN one instance presents a new lineage to a client
    // that still persists the old one, and no instance/branch recovery
    // fires. Clients claim the epoch they last synced per doc;
    // `runDocLineageGuard` rejects stale claims with
    // `doc-lineage-mismatch` BEFORE Yjs sync can union-merge the two
    // materializations (which duplicates every block — see the
    // shouldUnloadDocument rationale above). Placement after
    // `removalRedirectGuard` preserves rename-redirect / doc-deleted
    // priority; placement after `principalAuthExtension` preserves
    // instance → branch precedence on the restart axis.
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

    // CC1 forgery guard. Hocuspocus's MessageReceiver relays every
    // BroadcastStateless message from any peer to all peers on the
    // same document with NO source filter.
    // The `__system__` doc is server→client only by design — every CC1
    // channel (`server-info`, `branch-switched`, `disk-ack`, derived-
    // view) flows out via the server's own DirectConnection through
    // Document.broadcastStateless. A malicious client that opens a
    // `__system__` WebSocket and sends a BroadcastStateless can forge
    // any payload dispatchCC1Stateless accepts: a forged
    // `branch-switched` would wipe IDB on every other peer, and a
    // forged `disk-ack` would advance lastDiskAckedSV past unsynced
    // bytes (re-opening the content-loss bug class).
    //
    // Reject inbound BroadcastStateless on `__system__` from every
    // client. The hook throws to abort message dispatch — Hocuspocus's
    // Connection.ts catches and closes the offending connection,
    // which is the right outcome (legitimate subscribers only receive,
    // never broadcast). The IncomingMessage decoder reads the
    // documentName prefix first, then the message type varUint.
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
      getAttachmentFolderPath: readProjectAttachmentFolderPath,
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
      // CC1 broadcaster is initialized after persistence but captured by
      // closure reference (same pattern as `onAgentCommit` + `onDiskFlush`
      // above). `getLatestDiskAckSVsAsBase64()` returns `{}` when the
      // server has flushed nothing yet, matching the schema's
      // empty-object case.
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
      // Reuse the single user-home override that also resolves `~/.ok/global.yml`
      // so global-scope skills (`<home>/.ok/skills`) resolve under the same
      // home (tests pass a tempdir; production leaves it undefined → homedir()).
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

    // `sync.handshake` span emission — sibling to `persistence.onLoadDocument`.
    // Provides per-cycle correlation by mountId for the convention-cap-
    // graduation sweep's Tempo queries. No-op when OTel is disabled.
    hocuspocus.configuration.extensions.push(createSyncHandshakeSpanExtension());

    // Seed `lifecycle.status='conflict'` on doc load when the file is tracked
    // in the SyncEngine's ConflictStore. Closes the mid-session race that
    // `case 'conflict'` in `handleDiskEvent` can't cover (unloaded-doc
    // early-return), and complements `restoreLifecycleFromConflictsJson`
    // (which covers the boot/restart race). Both this and the mutating-
    // handler refusal gate read the same ConflictStore as the authoritative
    // tracking signal.
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
  // Config doc connections. Held open for the server's lifetime so the
  // synthetic Y.Docs stay materialized — clients (Settings pane + chrome
  // controls) attach via WS. The bridge bypass is in
  // `server-observer-extension.ts`; persistence/file-watcher/agent-sessions
  // short-circuits in their respective modules.
  const configDocConnections = new Map<
    string,
    Awaited<ReturnType<Hocuspocus['openDirectConnection']>>
  >();

  // Config file-watcher unsubscribes. One per admitted config doc whose
  // on-disk file exists at startup (or appears via lazy first-write).
  // Drained at server shutdown phase-1 alongside the content-watcher
  // cleanup; failures during startup degrade but never block.
  const configFileWatcherCleanups: Array<{
    docName: string;
    cleanup: ConfigFileWatcherUnsubscribe;
  }> = [];

  /** Resolve a safe rescue buffer path, returning null if traversal is detected. */
  function safeRescuePath(shadowGitDir: string, docName: string): string | null {
    const rescueBase = resolve(shadowGitDir, 'rescue');
    const filePath = resolve(rescueBase, `${docName}${getDocExtension(docName)}`);
    if (!isWithinDir(filePath, rescueBase)) return null;
    return filePath;
  }

  /**
   * Serialize current Y.Doc to markdown for reconciliation, rescue, park,
   * and branch-buffer paths.
   *
   * Y.Text-is-truth contract: body bytes come from `Y.Text('source')`
   * directly, NOT from `serialize(fragment)`. The fragment-derived
   * canonical form would normalize away source-form attrs (inline-code
   * fence form, blockquote spacing, setext underline length, ATX trailing
   * hashes, link URL/title-marker form, etc.) on every serialization,
   * defeating the per-attr work for any path that doesn't write back to
   * ytext via `composeAndWriteRawBody`.
   *
   * Three-way merge (`mergeThreeWay` algorithm unchanged) consumes raw
   * user bytes for `ours` and `base`; `theirs` is already raw disk bytes.
   * The diff3 line-level merge preserves whole-line user form in
   * non-conflict regions; the within-conflict-region char-level DMP can
   * still canonicalize source-form characters (residual canonicalization
   * within conflict spans is a known limitation of DMP, not this caller).
   *
   * The FM split + prepend stays for symmetry with downstream consumers
   * that expect a `prependFrontmatter(fm, body)`-shaped string. Both
   * halves come from ytext under contract; the split is defensive.
   */
  function serializeDoc(docName: string): string | null {
    const document = hocuspocus.documents.get(docName);
    if (!document) return null;
    return serializeYDocSource(document);
  }

  /** Apply markdown content to Y.Doc — delegates to the shared throwing helper. */
  const applyToDoc = (docName: string, content: string): void =>
    applyExternalChange(hocuspocus, docName, content, resolveEmbed, resolveSize);

  /**
   * Clear the conflict status set by `case 'conflict'` once a subsequent
   * `case 'update'` has reconciled the resolved bytes onto the Y.Doc. Without
   * this, UI surfaces gating on `lifecycle.status === 'conflict'` (banner,
   * read-only mode) stay stuck even after the data has converged.
   */
  function clearLifecycleConflict(document: Document): void {
    if (!isDocInConflict(document)) return;
    const lifecycleMap = document.getMap('lifecycle');
    lifecycleMap.delete('status');
    lifecycleMap.delete('reason');
  }

  /**
   * Re-render any open doc whose source contains `[[<assetBasename>]]` —
   * fallback re-resolution when an asset is created or deleted outside of a
   * cross-branch git operation. Without this, an open doc's PM image `src`
   * stays frozen at the parse-time resolution: asset events update
   * `basenameIndex` correctly, but documents whose markdown is byte-identical
   * pre/post-event have no other re-render trigger.
   *
   * Why a substring scan instead of a reverse index: this fires only on
   * asset create/delete (rare relative to text edits) and handles both
   * `![[name.ext]]` (image embed) and `[[name.ext]]` (wiki-link with
   * resolved href) shapes via the same `[[<name>]]` substring. A reverse
   * index would buy throughput we don't need.
   *
   * Why Y.Text source instead of disk: the Y.Text already includes the user's
   * pending edits within the persistence-debounce window. Reading disk content
   * here would diff a stale tree against the live XmlFragment via
   * `updateYFragment` — silently reverting unsaved edits. The pure CRDT helper
   * `applyDiskContentToDoc` re-parses with the new resolveEmbed but doesn't
   * call `recordContributor` or `setReconciledBase` (no actual disk write
   * happened — only the embed resolution changed).
   *
   * Idempotent: `updateYFragment` diffs the computed PM tree against the live
   * XmlFragment and only writes changed positions; re-parsing the same source
   * with the same basenameIndex is a no-op on the Y.Doc.
   */
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
        // Caller wraps for atomicity + paired-write origin identity
        // (precedent #24). Re-render uses the same FILE_WATCHER
        // origin since the bytes are functionally a re-import of the source.
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

  /**
   * Schedule a deduplicated rerender for an asset basename. Multiple events
   * arriving in the same parcel-watcher batch (e.g. `asset-delete photo.png`
   * + `asset-create assets/photo.png` from a single `mv`) collapse into ONE
   * rerender pass per unique basename — eliminating the broken-ref flicker
   * during the inter-event window and halving the parse cost on N-asset
   * folder moves.
   *
   * `setImmediate` runs in Node's check phase, AFTER the current macrotask's
   * for-loop over batched events completes (microtask drains between awaits
   * leave the loop intact). All asset events in a single parcel callback
   * therefore land in the same pending Set before the deferred render fires.
   */
  let pendingAssetRerenderBasenames: Set<string> | null = null;
  const scheduleAssetRerender = (assetBasename: string): void => {
    if (!assetBasename) return;
    if (pendingAssetRerenderBasenames === null) {
      pendingAssetRerenderBasenames = new Set();
      setImmediate(() => {
        // Snapshot + reset BEFORE the try-block: these three lines are
        // provably non-throwing (variable read, assignment, null check) and
        // hoisting `toRender` out of the try makes it visible to the catch
        // for log context.
        const toRender = pendingAssetRerenderBasenames;
        pendingAssetRerenderBasenames = null;
        if (!toRender) return;
        // Top-level catch — `setImmediate` runs outside the file-watcher's
        // handleDiskEvent try-catch scope. The per-doc body inside
        // `rerenderDocsReferencingAssetBasename` already guards each
        // `applyDiskContentToDoc` call, but Set iteration + the inner
        // function's scaffolding are technically reachable here. An uncaught
        // throw would crash the server with no actionable log; logging the
        // basenames in scope at crash-time keeps any future regression
        // immediately diagnosable without timestamp correlation.
        try {
          for (const b of toRender) rerenderDocsReferencingAssetBasename(b);
        } catch (err) {
          log.error({ err, basenames: [...toRender] }, '[asset-event] dedup rerender pass crashed');
        }
      });
    }
    pendingAssetRerenderBasenames.add(assetBasename);
  };

  /** Helper to extract a logging label from any DiskEvent variant. */
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

  /** Reconciliation-aware dispatch for all DiskEvent types. */
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

          // Structured log with content hashes
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
                // Disk is source of truth — keep base in sync even if Y.Doc update failed
                setReconciledBase(docName, theirs);
                clearLifecycleConflict(document);
              }
              break;

            case 'merged':
              try {
                applyToDoc(docName, result.newContent);
                // Base tracks the DISK bytes (theirs), not the merged content
                // — the merge exists only in memory until a later store
                // flushes it. A base pointing past disk makes every
                // disk-vs-base comparator misread the world: the
                // L1 before-agent-write reconcile would see a phantom
                // divergence and clean-ingest disk (reverting this merge),
                // the L3 store backstop would abort the next agent flush the
                // same way, and the no-op store skip (ytext === base) would
                // keep the merged content off disk indefinitely. With
                // base = theirs, the next store writes the merge through and
                // re-events reconcile to noop (theirs === base).
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
                // Disk is source of truth — keep base in sync even if Y.Doc update failed
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
                // Disk is source of truth — keep base in sync even if Y.Doc update failed
                setReconciledBase(docName, theirs);
              }
              // Block-level reconcile produced marker-laden content. Mirror the
              // `case 'conflict'` lifecycle set so the UI swap and the
              // mutating-MCP-handler refusal gate fire for reconciliation
              // conflicts the same way they fire for disk-level marker detection.
              // Raw Y.Map.set, no transact — matches the sibling `case 'conflict'`
              // branch convention.
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
            // Silent rescue checkpoint — preserve in-memory
            // content on a timeline ref so TimelinePanel renders it as an
            // 'external-change-rescue' row. Fire-and-forget; failures warn
            // but don't block the delete lifecycle.
            const shadowForCheckpoint = shadowRef.current;
            const branch = headWatcher?.getLastKnownBranch() ?? 'main';
            queueMicrotask(() => {
              saveInMemoryCheckpoint(shadowForCheckpoint, contentRoot ?? '', {
                kind: 'external-change-rescue',
                docName,
                contents: ours,
                label: `External change recovered @ ${new Date().toISOString()}`,
                branch,
                // Delete event has no incoming disk content — sentinel empty
                // string so the TimelineRescueEntry shape round-trips.
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

          // Unload document to prevent re-creation on next persistence cycle
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

          // Snapshot current ytext as the new reconciledBase so the
          // post-resolution 'update' event reconciles base==ours -> clean
          // and applyToDoc lands theirs verbatim. Without this, a
          // reconciledBase that has drifted from ytext (e.g. when the user
          // typed between persistence's last flush and the merge appearing
          // on disk) makes the post-resolution reconcile a 3-way merge of
          // {user-edits, theirs} instead of a clean accept-theirs.
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

        // Asset events update the basename index and fire CC1 'files' only.
        // They do NOT touch backlinkIndex (markdown-only). They DO trigger
        // a fallback re-render of any open doc that references the changed
        // basename via `[[name.ext]]` (see
        // `rerenderDocsReferencingAssetBasename`) — without this, a doc
        // whose markdown is unchanged across the asset move (e.g. the user
        // organizes files into `assets/` while the doc still says
        // `![[photo.png]]`) keeps its parse-time-resolved `src` and the
        // rendered preview goes stale.
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
        // file-* events maintain the in-memory fileIndex as `kind:'file'`. Like
        // asset events they signal `files` (cache-invalidate /api/documents and
        // the workspace search corpus) but do NOT touch backlinkIndex or
        // tagIndex (relationship surfaces stay markdown-scoped). updateFileIndex
        // in handleRawEvents already mutated the index by the time we arrive
        // here.
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

  // ─── Batch buffering ──────────────────────────────────────────────────────

  const eventBuffer: DiskEvent[] = [];

  /** Wrapper that buffers events during batch operations. */
  async function onDiskEvent(event: DiskEvent): Promise<void> {
    if (isBatchInProgress()) {
      eventBuffer.push(event);
      return;
    }
    await handleDiskEvent(event);
  }

  /** Drain buffered events after batch ends. */
  async function drainEventBuffer(): Promise<void> {
    const events = eventBuffer.splice(0, eventBuffer.length);
    for (const event of events) {
      await handleDiskEvent(event);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  let watcher: WatcherHandle | null = null;
  let headWatcher: HeadWatcherHandle | null = null;
  let syncEngine: SyncEngine | null = null;
  let inflightDestroy: Promise<void> | null = null;

  // This helper mirrors @hocuspocus/server's internal Server.destroy() pattern
  // We can't use
  // Server.destroy() directly because Server owns its own httpServer + crossws
  // WebSocket adapter + signal binding, which conflicts with OK's shared HTTP
  // server + /api/* routing + static asset serving + /collab-only upgrade.
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

    // Capture doc names before the race so the timeout error can name the
    // documents that failed to unload — actionable context for operators
    // debugging hung flushes, and the target list for the rescue-buffer
    // dump below.
    const pendingDocNames = Array.from(hocuspocus.documents.keys());

    hocuspocus.closeConnections();
    hocuspocus.flushPendingStores();

    // shouldUnloadDocument blocks normal unloads while the server is running.
    // `destroy()` assigns `shutdownAllowsUnload = true` synchronously at the
    // start of its async IIFE (before the first await), so by the time this
    // flush runs, explicit `unloadDocument` calls below are allowed through.
    // Clients that disconnected before destroy() was called (e.g. pool.dispose()
    // in test teardown) will have left documents resident with 0 connections.
    // closeConnections() above is a no-op for those docs, so no unload events
    // fire. Explicitly unload any document with no remaining connections so
    // afterUnloadDocument can resolve.
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

        // Rescue-buffer dump on flush timeout. onStoreDocument did not
        // complete for these docs, so the in-memory Y.Doc state IS the
        // data-of-record — dump it to the shadow rescue/ tree so the user can
        // recover via the existing /api/rescue endpoints. Best-effort per doc
        // so one serialization failure doesn't block the others. Unconditional
        // (no isDirty check like the reconcile-path rescue uses) because the
        // hang semantic means diff-vs-reconciled-base is not the right gate.
        const rescued: string[] = [];
        const rescueFailed: string[] = [];
        if (shadowRef.current) {
          for (const docName of stillLoaded) {
            if (isReservedForUserTree(docName)) continue;
            try {
              const ours = serializeDoc(docName);
              if (ours === null) {
                // Doc was removed from hocuspocus.documents between the
                // stillLoaded snapshot and this loop — race during teardown.
                log.warn(
                  { docName },
                  `[rescue] skipping ${docName} — document dropped from map mid-rescue`,
                );
                rescueFailed.push(docName);
                continue;
              }
              const rescuePath = safeRescuePath(shadowRef.current.gitDir, docName);
              if (!rescuePath) {
                // Path-traversal guard fired — docName tried to escape the
                // rescue/ directory. Log at warn level since this is
                // security-relevant, not just a write failure.
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
          // Shadow repo unavailable (initAsync failed earlier) — nothing to
          // write into. Warn rather than fail silently so operators seeing a
          // `lost [...]` array in the timeout error can distinguish "no shadow
          // repo" from per-doc write failures.
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

      // Cancel any pending debounced backlink cache write so the timer doesn't
      // fire after resources are torn down.
      if (backlinkSaveTimer !== null) {
        clearTimeout(backlinkSaveTimer);
        backlinkSaveTimer = null;
      }

      // Wait for async init to complete before cleanup — prevents leaked watcher
      // subscriptions if destroy() is called during startup (e.g., Ctrl+C).
      // Bounded to 5s so destroy() doesn't hang indefinitely if init is stuck
      // (e.g., waiting for a shadow repo git lock held by another process).
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

      // Capture after ready so the count reflects documents loaded during init
      const documentCount = hocuspocus.documents.size;

      // Stop the maintenance coordinator FIRST, before any flush phase. A
      // background gc/consolidation — fired by the flush-counter during the L1/L2
      // drains, or by a session-close during the agent-session drain — would
      // otherwise race the final commit flush against the same shadow repo.
      // `destroy()` flips the gate so no NEW maintenance op starts; combined with
      // the single-op gate, the shutdown flush then has the repo to itself.
      maintenanceCoordinator?.destroy();

      try {
        try {
          // Phase 1: stop watchers FIRST so L1 disk writes don't trigger reconcile loops
          try {
            if (headWatcher) {
              await headWatcher.unsubscribe();
              headWatcher = null;
            }
            if (watcher) {
              await watcher.unsubscribe();
              watcher = null;
            }
            // Config file watchers. Independent of the content watcher;
            // teardown failures per-doc shouldn't block other cleanups, so
            // each cleanup is wrapped in its own try/catch.
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

          // Phase 1b: tear down CC1 broadcaster + agent-presence broadcaster +
          // __system__ direct connection. Both broadcasters share the same
          // `__system__` Y.Doc — their destroys clear internal state (debounce
          // timers for CC1; idempotent no-op for agent-presence today but
          // symmetric with the broadcaster-lifecycle contract). The single
          // systemDocConnection handle is torn down last.
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

          // Phase 2: drain agent sessions (intrinsic per-session try/catch)
          try {
            await sessionManager.closeAll();
          } catch (err) {
            phaseErrors.push({
              phase: 'agent-session-drain',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-2 agent session drain failed');
          }

          // Phase 3: drain L1 (Y.Doc → markdown → disk) via afterUnloadDocument hook
          try {
            await flushAllStoresAndWait(destroyTimeoutMs);
          } catch (err) {
            phaseErrors.push({
              phase: 'flush-all-stores',
              error: err instanceof Error ? err.message : String(err),
            });
            log.error({ err }, '[server] shutdown phase-3 flush failed');
          }

          // Phase 4: drain L2 (disk → git) — only meaningful AFTER L1 has run
          // Bounded to destroyTimeoutMs so a stuck git process doesn't hang shutdown.
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
          // Phase 4.5: stop sync engine
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
          // Phase 5: shadow repo release — ALWAYS runs. The maintenance
          // coordinator was already stopped at the top of shutdown, so no late
          // background gc can run against the repo being torn down here.
          if (shadowRef.current) {
            // Persist current HEAD before releasing shadow lock
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
              // Fresh repo with no commits, or git not available — skip silently
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
        // Phase 6: release server lock LAST — after shadow repo release,
        // agent session drain, L1/L2 flush. If an earlier phase threw, we still
        // release so a subsequent start can succeed. Invariant: no other process
        // may acquire this lock until every prior phase has run.
        try {
          releaseServerLock(lockDir);
        } catch (err) {
          phaseErrors.push({
            phase: 'server-lock-release',
            error: err instanceof Error ? err.message : String(err),
          });
          log.error({ err }, '[server] shutdown phase-6 releaseServerLock failed');
        }
        // Telemetry shutdown runs outside the lock-release try so a telemetry
        // flush failure can never prevent the lock from being released. 5s
        // internal timeout prevents a hung OTLP exporter from stalling teardown.
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

  /** Subsystems that failed during initAsync — populated on catch, read after `await ready`. */
  const degraded: string[] = [];

  /** Async initialization: shadow repo, file watcher, HEAD watcher. */
  async function initAsync(): Promise<void> {
    // Load (or create) the principal record — non-blocking best-effort.
    try {
      loadedPrincipal = await loadPrincipal(projectDir);
      log.info({ principalId: loadedPrincipal.id }, '[server] principal loaded');
    } catch (e) {
      log.warn(
        { err: e },
        '[server] principal load failed — browser writes will use SERVICE_WRITER',
      );
    }

    // Auto-initialize shadow repo if not provided
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

    // Boot-time rename log:
    //   1) load the JSONL into the in-memory index (load failure → no index
    //      published; runtime calls fall through to lazy disk reads);
    //   2) sweep mid-rename-crash orphans (load+sweep are critical — they
    //      prepare the index for runtime use);
    //   3) publish the index (setRenameLogIndex) BEFORE GC so a GC failure
    //      doesn't leave the cache empty;
    //   4) run reachability GC + rebuild from `OkActorEntry.previous_paths`
    //      as best-effort — its failure must not undo the loaded index.
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
        // Wall-clock cap on boot-time GC. The internal git invocations have
        // their own per-call timeouts (`OK_GIT_TIMEOUT_MS`), but a corrupt or
        // lock-contended shadow repo could still chain timeouts and stall the
        // server boot for tens of seconds. Boot must remain bounded — a slow
        // GC defers to the next iteration's GC trigger rather than blocking
        // the editor from coming online.
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

      // Shadow-repo maintenance at boot. Time-capped to ≤ ~1s of
      // boot blocking; a large backlog packs in the background after the cap so
      // existing degraded repos heal on first boot post-upgrade. Runs after the
      // rename-log GC (shares the shadow); gated + off the write path.
      try {
        await maintenanceCoordinator?.runBootMaintenance();
      } catch (e) {
        log.warn({ err: e }, '[shadow-maintenance] boot maintenance failed (non-fatal)');
      }
    }

    // Verify history repo integrity — reinit only on structural corruption, not transient errors
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

    // HEAD-drift check: detect git operations that occurred while offline.
    // Compare stored last-known-head against current HEAD SHA and import if diverged.
    if (shadowRef.current) {
      try {
        const lastKnownHeadPath = resolve(shadowRef.current.gitDir, 'last-known-head');

        // Read last persisted HEAD SHA
        let lastKnownHead: string | null = null;
        try {
          lastKnownHead = readFileSync(lastKnownHeadPath, 'utf-8').trim() || null;
        } catch {
          // File doesn't exist yet — first run
        }

        // Read current HEAD SHA from project repo
        let currentHead: string | null = null;
        try {
          const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
          currentHead = (await projectGit.revparse('HEAD')).trim() || null;
        } catch {
          // Fresh repo with no commits — skip drift check
        }

        if (currentHead !== null) {
          if (currentHead !== lastKnownHead) {
            // Drift detected (includes null → SHA for fresh clone T0 case)
            let branch = 'main';
            try {
              const projectGit = simpleGit({ baseDir: projectDir, timeout: { block: 10_000 } });
              const b = (await projectGit.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
              if (b && b !== 'HEAD') branch = b;
            } catch {
              // Detached HEAD or error — fallback to 'main'
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

          // Always persist current HEAD so next startup has an accurate baseline
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

    // Reap orphaned tempfiles from .ok/local/tmp/ older than the 24h grace
    // window. Adversarial or buggy clients that abort mid-upload leave a
    // tempfile behind; the in-request cleanup handles the common path but
    // a SIGKILL between pipeline completion and rename/unlink leaks the
    // inode. Boot sweep is the correctness backstop.
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

    // Pre-materialize __system__ Y.Doc so CC1 broadcaster has a target before
    // any browser connects. Must happen before the file watcher starts.
    try {
      systemDocConnection = await hocuspocus.openDirectConnection(SYSTEM_DOC_NAME);
      // Emit the server-info signal once __system__ is materialized so any
      // late-arriving client that subscribes to the channel gets the current
      // serverInstanceId (part of the CRDT restart-recovery defense — clients
      // cache this + claim it in their auth token on every connect).
      cc1Broadcaster?.emitServerInfo(serverInstanceId, getActiveBranch());
    } catch (err) {
      log.error(
        { err },
        '[server] failed to open __system__ direct connection — CC1 push disabled',
      );
      degraded.push('cc1-push');
    }

    // No-project ephemeral mode does NOT materialize the synthetic config
    // Y.Docs (nor watch the config files below): the Settings / folder chrome
    // is hidden, so the only contentDir-pollution path in a split
    // projectDir/contentDir boot — the `__config__/okignore` config-doc write
    // — is unreachable. `__system__` (CC1 / restart-recovery) stays
    // materialized above; only the config docs are skipped.
    const configDocNamesToBind = ephemeral ? [] : CONFIG_DOC_NAMES;

    // Pre-materialize config Y.Docs. One per well-known synthetic name.
    // Connections held for the server's lifetime so the docs stay loaded
    // — Settings pane + chrome controls attach via the existing collab WS.
    // Bridge bypass + agent-session short-circuits live in the respective
    // modules; admission failure is non-fatal (Settings pane's first
    // connect would re-materialize).
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

    // Config file watchers. Watch both well-known config paths so external
    // edits (CLI, IDE hand-edit, MCP from another instance) propagate to any
    // open Settings pane via Y.Text observer. Workspace path is created
    // lazily via `applyConfigPatch`; user-global path is created lazily via
    // `writeConfigPatch`. chokidar's single-file watch handles non-existent
    // paths by waiting for them, so
    // we start watchers unconditionally — `add` events fire when a lazy
    // first-write lands.
    //
    // Self-write feedback loop is broken by `applyExternalConfigChange`'s
    // LKG-equality short-circuit: when persistence writes content `C` to
    // disk, it sets `lkgCache[doc] = C`; the watcher reads `C` back, sees
    // it match LKG, and returns 'no-op' before mutating Y.Text.
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

    // Managed-artifact (skills) file watcher. `.ok/skills/<name>/SKILL.md` is
    // under `.ok/`, which the content file-watcher excludes by default — so a
    // hand/CLI/cross-instance edit would never reach a live `__skill__/...` doc
    // without this explicit watch. On a change, map the leaf path
    // back to its doc name and reconcile into the open doc (if any) via the same
    // LKG-guarded path the onLoad/onStore hooks share. A doc that isn't open is
    // a no-op — its next open re-reads disk fresh. Ephemeral (no-disk) servers
    // skip this entirely.
    if (!ephemeral) {
      // Shared reconcile: map a changed leaf path back to its doc name and
      // import disk bytes into the open doc (if any) via the LKG-guarded path
      // the onLoad/onStore hooks share. A doc that isn't open is a no-op (its
      // next open re-reads disk fresh).
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
        // A global SKILL.md add/change reconciles the whole bundle into the graph:
        // re-ingest registers the SKILL node + its current references (and prunes
        // any that vanished). Node-only + idempotent, so the (cheap, bounded) full
        // re-scan is safe on each event. The watcher only fires on SKILL.md leaves,
        // so reference-only edits ride the next SKILL.md touch / restart; a SKILL.md
        // unlink does NOT fire onChange, so a deleted skill is pruned on restart.
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

      // Template watcher. Templates live in any folder's `.ok/templates/`, so the
      // watch roots are enumerated from the existing templates at boot (plus the
      // project root). Bounded — a template created in a BRAND-NEW folder mid-
      // session is reconciled only after a restart; the common case (editing a
      // template that existed at boot) is covered.
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

    // Multi-path ignore-file watcher: root `.okignore` + root `.gitignore`.
    // ONE chokidar instance + ONE debouncer. On each debounced disk event:
    //   - Rebuild ContentFilter (re-walks root + nested ignore files,
    //     refreshes the singleton `Ignore` instance in-place; `onAfterRebuild`
    //     re-derives backlink/tag indexes against the new visible-set).
    //   - On rebuild success, emit on the existing `files` CC1 channel so
    //     any open file tree re-fetches `/api/documents`.
    //   - On rebuild failure, fall back to the previous filter (the
    //     ContentFilter rolls back internally) and emit a payload-bearing
    //     `config-ignore-nested-error` CC1 with the triggering file's
    //     project-relative path so a Settings toast can surface it.
    //
    // For the `.okignore` path specifically, also call
    // `applyExternalConfigChange` to mirror the file content into the
    // `__config__/okignore` Y.Text so any open Settings pane re-renders
    // its row list. The LKG-equality short-circuit prevents the
    // self-write feedback loop when the persistence-hook's atomic write
    // is what triggered the watcher event in the first place.
    //
    // `.gitignore` has no Y.Text association — it's a read-only signal
    // here. Editing `.gitignore` from inside OK is permanently out of scope.
    try {
      const okignorePath = resolve(contentDir, '.okignore');
      const gitignorePath = resolve(projectDir, '.gitignore');
      // `.git/info/exclude` is per-clone, untracked, and consulted by
      // `git add`. Without watching it, an external edit (or our own
      // `ensureOkExcludedFromGit` from the clone path) only takes effect
      // on the next ContentFilter construction. Resolve via
      // `git rev-parse --git-common-dir` so linked worktrees (where
      // `<projectDir>/.git` is a file, not a dir) point at the shared
      // common dir — the same resolution `loadGitExcludeSources` uses.
      // Only add to the watch list when the resolution succeeded AND the
      // `info/` dir already exists — the watcher's recursive mkdir would
      // otherwise spawn `.git/info/` inside non-git projectDirs, which
      // downstream git tooling would misclassify as a corrupted repo.
      // The global excludesfile is NOT watched here — it lives outside
      // projectDir and changes extremely rarely; a session restart picks
      // it up.
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
        // git missing / spawn failure: leave null, watcher just skips.
      }
      const ignorePaths = gitInfoExcludePath
        ? [okignorePath, gitignorePath, gitInfoExcludePath]
        : [okignorePath, gitignorePath];
      const ignoreLog = log;
      // No-project ephemeral mode does not watch ignore files: in single-file
      // scope the ContentFilter ignores `.okignore` / `.gitignore` entirely
      // (the singleDocRelPath short-circuit + `contentOutsideProject`), and the
      // `__config__/okignore` Y.Text it would mirror into is not materialized.
      // Skipping it keeps boot bounded and avoids placing a chokidar watch on
      // the user's real directory.
      ignoreLog.info(
        { okignorePath, gitignorePath, gitInfoExcludePath, ephemeral },
        '[ignore-watcher] starting multi-path watcher for .okignore + .gitignore (+ .git/info/exclude when present)',
      );
      const ignoreCleanup = ephemeral
        ? null
        : await startMultiPathConfigFileWatcher(ignorePaths, (changedPath, content) => {
            void (async () => {
              // Mirror disk → Y.Text for `__config__/okignore` so the Settings
              // pane reflects external hand-edits. LKG-equality short-circuit
              // breaks the loop with our own atomic-write events.
              //
              // The Y.Text mirror is wrapped in its own try/catch so a Y.Doc
              // mutation failure (rare — destroyed doc, telemetry exception,
              // etc.) cannot block the ContentFilter rebuild below: the file
              // tree stays consistent with disk even when the Settings pane
              // mirror momentarily diverges.
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

              // Rebuild ContentFilter regardless of which file changed. Both
              // contribute patterns to the unified `Ignore` instance, so any
              // change requires a re-walk + re-derive of derived views.
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

    // Reset branch-scoped state to match THIS project's current HEAD before
    // anything reads/writes it. `persistence.activeBranch` and the
    // `BacklinkIndex.activeBranch` are mutable state; in single-process test
    // runners (bun test) these leak across test files, so a prior test that
    // triggered `switchReconciledBaseScope` leaves state at the wrong branch
    // for the next server's reads. Detecting the actual HEAD here and
    // normalizing both scopes in lock-step closes the leak.
    const gitDirForInit = resolveGitDir(projectDir);
    const startupBranch = gitDirForInit ? (readBranchFromHead(gitDirForInit) ?? 'main') : 'main';
    switchReconciledBaseScope(startupBranch);
    backlinkIndex.switchBranch(startupBranch);

    // Boot-timing scope for the index phases (backlink load/rebuild, tag
    // re-init, basename seed) plus the watcher's startup seed walk. The whole
    // block deltas into `indexesMs`; the `startWatcher` call specifically into
    // `seedWalkMs` so the O(n) disk scan is separable from the index work.
    // Bounded ms numbers only — no paths/content (cardinality STOP rule).
    const indexesStartMono = performance.now();
    // Start file watcher (with content filter for gitignore + config exclude)
    try {
      // `ok.boot.indexes` spans the whole index-building phase; the nested
      // `ok.boot.seed-walk` span (around `startWatcher`) is its child.
      await withSpan('ok.boot.indexes', undefined, async () => {
        // Warm start: load the on-disk cache and reconcile (stat-only for
        // unchanged files, async bounded reads for changed ones).
        // Cold start (no cache): full async rebuild with bounded concurrency.
        // Runs BEFORE startWatcher to avoid a race where watcher events mutate
        // the backlink index while an async rebuild is in progress.
        // Isolated in its own try/catch so a corrupt cache never prevents the
        // watcher from starting — watcher events will populate the index
        // incrementally from that point.
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
          // Register GLOBAL skill bundle docs (SKILL + references/**) as graph
          // nodes. They live at `<home>/.ok/skills`, OUTSIDE contentDir, so the
          // content rebuild/reconcile above never touches them — this runs AFTER
          // those (both replace branch state) so the nodes aren't dropped. Their
          // bodies are deliberately not parsed (within-bundle-only). The cache is
          // persisted after, but a warm restart re-ingests here regardless.
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
        // `startWatcher` performs the file-watcher's startup seed walk — the
        // O(n) disk scan that stats/reads every markdown file to seed the file
        // index. Wrap it in its own span + time it separately so the seed walk's
        // cost is visible apart from the surrounding index work.
        const seedWalkStartMono = performance.now();
        watcher = await withSpan('ok.boot.seed-walk', undefined, async () =>
          startWatcher(contentDir, onDiskEvent, contentFilter),
        );
        recordBootPhase('seedWalkMs', Math.round(performance.now() - seedWalkStartMono));
        // Re-init tagIndex once the watcher has settled. The earlier `init()`
        // in the synchronous boot path covers the cold-start case; this second
        // pass picks up any disk content that landed between constructor time
        // and watcher startup (rare, but cheap to cover). Isolated in its own
        // try/catch so a failed tag scan degrades tag search only — letting it
        // reach the outer catch would skip the basename-index seed below and
        // misreport a healthy watcher as `file-watcher` in `degraded[]`.
        try {
          await tagIndex.init();
        } catch (err) {
          log.error(
            { err },
            '[tag-index] startup re-init failed; tag index updates incrementally via watcher events',
          );
          degraded.push('tag-index');
        }
        // Seed the basename index from disk once the watcher's startup walk
        // has finished. The watcher's fileIndex is markdown-only, so we walk
        // the contentDir directly for assets.
        //
        // Per-entry skip accumulator: the outer-throw guard below is
        // unreachable in practice because bare catch blocks inside
        // `seedBasenameIndex` swallow EACCES / EMFILE silently and truncate
        // the walk without logging. `onSkip` fires for each non-ENOENT
        // failure; a non-zero count pushes `basename-index-partial` into
        // `degraded[]` so the Electron utility's degraded banner + ops
        // dashboards see the signal.
        let seedSkipCount = 0;
        try {
          if (singleDocRelPath !== undefined) {
            // Single-file mode: the recursive seed would walk the whole parent
            // dir AND gate every entry through the single-file `isExcluded`
            // (which excludes all siblings) → it would add nothing. Seed embeds
            // from a bounded one-dir scan of the doc's own directory instead.
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
          // An empty basename index means every `![[file.png]]` resolution
          // returns null after boot — equivalent to the vault silently
          // losing every wiki-embed. Surface via `degraded[]` so the
          // Electron utility's `UtilityDegradedMessage` IPC can render a
          // banner and operators know to investigate rather than hunting
          // a rendering regression.
          degraded.push('basename-index');
        }
      });
    } catch (err) {
      log.error({ err }, '[server] disk bridge watcher failed to start');
      degraded.push('file-watcher');
    } finally {
      // Record the index-phase duration + final markdown file count even on a
      // partial/failed watcher start, so the waterfall still has a value. The
      // watcher's markdown-only file index is the canonical "how many docs did
      // we load" signal (bounded count, cardinality-safe).
      recordBootPhase('indexesMs', Math.round(performance.now() - indexesStartMono));
      if (watcher) setBootField('fileCount', watcher.getFileIndex().size);
    }

    // Start HEAD watcher (only if project .git/ exists)
    try {
      headWatcher = await startHeadWatcher(
        projectDir,
        // onBatchBegin — park current branch context before git modifies working tree
        async ({ trigger }) => {
          log.info({ trigger }, `[batch] begin trigger=${trigger}`);
          incrementBatch();
          hocuspocus.flushPendingStores();
          await persistence.flushPendingGitCommit();

          // Gate new L1/L2 writes BEFORE the park loop so any onStoreDocument
          // calls that fire during the async parkBranch are blocked.
          setBatchInProgress(true);

          // Park current branch's Y.Doc state to shadow refs
          if (shadowRef.current) {
            const currentBranch = getActiveBranch();
            // Read new branch from HEAD (already updated by git at onBatchBegin time)
            // so the park subject can carry both ends of the switch.
            const gitDir = resolveGitDir(projectDir);
            const newBranch = gitDir
              ? (readBranchFromHead(gitDir) ?? currentBranch)
              : currentBranch;
            const docs: ParkableDoc[] = [];
            for (const [docName, document] of hocuspocus.documents) {
              if (isReservedForUserTree(docName)) continue;
              // Wrap in doc.transact so Y.js serializes snapshot capture atomically
              // against concurrent in-flight agent transacts (PARK_SNAPSHOT_ORIGIN).
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
        // onBatchEnd — dispatch on BatchKind
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
            // Pull, merge, rebase on same branch — reconcile buffered events
            await drainEventBuffer();
            await persistence.flushDeferredStores('within-branch');
            // External git ops (`git merge --abort`, `git checkout --ours
            // && git add && git commit` mid-conflict, etc.) leave the
            // SyncEngine's ConflictStore + conflictCount stale. The file
            // watcher's reconcile path already clears `lifecycle.status`
            // on the affected Y.Doc, but the sidebar Conflicts list +
            // topbar conflictCount keep showing the resolved entries
            // until the next pull cycle. Reconcile against git now.
            if (syncEngine !== null) {
              try {
                await syncEngine.reconcileConflictsFromGit();
              } catch (err) {
                log.warn({ err }, '[head-watcher] sync engine conflict reconcile failed');
              }
            }
          } else {
            // Cross-branch or detached-head — discard buffered events (wrong branch state)
            incrementBranchSwitch();
            eventBuffer.splice(0, eventBuffer.length);

            // Switch reconciledBase scope to target branch
            switchReconciledBaseScope(newBranch);
            // Cancel any pending debounced save before switching branches.
            // Without this, the timer fires after activeBranch is updated and
            // saves the old branch's graph state into the new branch's cache.
            if (backlinkSaveTimer !== null) {
              clearTimeout(backlinkSaveTimer);
              backlinkSaveTimer = null;
            }
            backlinkIndex.switchBranch(newBranch);

            // Rebuild `ContentFilter`'s sibling-asset refcount BEFORE the
            // basenameIndex reseed. ContentFilter's `dirCount` is normally
            // maintained incrementally via `incrementMdDir` /
            // `decrementMdDir` calls fired by the file watcher's create /
            // delete events, but the cross-branch path discarded those
            // events above (`eventBuffer.splice`). Without a rebuild, the
            // refcount holds the previous branch's directory shape and
            // legitimate sibling-asset pairs on the new branch
            // (`assets/cover.md` next to `assets/photo.png`) are rejected
            // by `seedBasenameIndex`'s admission check, leaving the asset
            // unresolved.
            contentFilter.rebuildDirCount();

            // Reseed `basenameIndex` BEFORE the doc-reset loop. The reset
            // calls `applyToDoc` → `applyExternalChange` → mdast→PM with
            // `resolveEmbed`, which resolves `![[photo.png]]` against the
            // basename index. With the previous (stale) branch's paths
            // still in the index, the PM image `src` carries the
            // pre-switch resolution until the next user edit — disk
            // markdown round-trips fine, but the rendered preview is
            // wrong.
            //
            // Asset DiskEvents from the switch itself are discarded
            // (`eventBuffer.splice` above) and `basenameIndex` is a flat
            // Map without branch scope, so the explicit walk is the only
            // mechanism by which post-switch paths enter the index.
            // Mirror backlinkIndex's branch-scoped reset: drop the index,
            // walk the new branch's disk, re-seed.
            //
            // `onSkip` wiring is symmetric with the boot path — a mid-
            // session permission flip (EACCES), fd exhaustion (EMFILE),
            // or root-scope read failure during the reseed walk surfaces
            // the same `basename-index-partial` degraded indicator the
            // boot path uses.
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

            // Reset all open Y.Docs from the target branch's disk content
            for (const [docName, document] of hocuspocus.documents) {
              if (isReservedForUserTree(docName)) continue;
              try {
                const filePath = safeContentPath(docName, contentDir);
                if (!existsSync(filePath)) {
                  // File doesn't exist on target branch — tombstone
                  const base = getReconciledBase(docName) ?? '';
                  const ours = serializeDoc(docName) ?? '';
                  const isDirty = ours !== base;

                  if (isDirty && shadowRef.current) {
                    // Silent rescue checkpoint on branch-switch tombstone
                    // Same pattern as reconcile-delete above.
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

                // Reset Y.Doc from disk
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
              // Global skill bundle nodes are user-global, not branch-scoped — the
              // freshly-built branch state lacks them, so re-ingest for this branch
              // (same node-only, within-bundle-only path as boot).
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
            // TagIndex is branch-agnostic but its source-of-truth is the
            // contentDir that just changed underneath it. Re-scanning here
            // is the only way the index reflects the new branch's tags.
            await tagIndex.init();

            // Restore parked WIP if exists (three-way merge parked state against current disk)
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
                  // Skip if no in-flight edits were parked
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
                      // Mirror the file-watcher `case 'conflicts'` lifecycle set
                      // so block-level reconcile failures during branch-switch
                      // WIP restore also fire the UI swap + mutating-handler
                      // refusal gate. Raw Y.Map.set, no transact — matches the
                      // sibling convention.
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

            // Clean up detached HEAD context if switching FROM detached TO named branch
            if (info.oldBranch?.startsWith('detached-') && shadowRef.current) {
              try {
                const sg = shadowGit(shadowRef.current);
                // List refs under the detached context
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

            // Notify connected clients that the branch scope changed so they can
            // invalidate their IDB persistence caches. Emit AFTER all server-side
            // state transitions (Y.Doc reset, backlink rebuild, WIP restore,
            // detached-ref cleanup) so a client's recycle-triggered reconnect
            // synchronizes against the new branch's fully-settled state.
            setBatchInProgress(false);
            await persistence.flushDeferredStores('discard-stale');
            cc1Broadcaster?.emitBranchSwitched(newBranch);
          }

          // Record upstream import if HEAD moved AND content files were affected.
          // A user's own `git commit` moves HEAD but doesn't change the working tree
          // (files were already written by the user/editor). Only `git pull`, `git merge`,
          // `git rebase`, or `git checkout` produce buffered file-watcher events, so
          // bufferedCount > 0 distinguishes "upstream brought changes" from "user committed".
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
      // HEAD watching now falls back to chokidar when @parcel/watcher can't
      // load (see startHeadWatcher), so reaching here means BOTH backends
      // failed — a genuine, rare failure worth an error + degraded signal.
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

    // Start SyncEngine: remote detection + auto-sync.
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
        // Push-permission probe auth seam — production callers (CLI `ok start`)
        // pass concrete `detectGh` + `tokenStore` so the probe runs under the
        // signed-in user's identity. Omission leaves the probe anonymous —
        // acceptable for embedded / test boots where no auth surface exists,
        // but a regression for the user-facing path. The boot-wiring test
        // (`server-factory.test.ts > production wiring: push-permission auth`)
        // pins that `createServer(options)` forwards both seams to SyncEngine.
        detectGh: options.detectGh,
        tokenStore: options.tokenStore,
        // Test seam — production callers leave this undefined. Forwarded so the
        // wiring test can assert detectGh + tokenStore propagate through without
        // hitting network.
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
            // The session is fine (sync disabled in memory), but the config
            // write failed — next restart will re-read the prior `enabled:
            // true` and re-trigger the same push failure, looping. error-level
            // signals that severity to operators tailing logs; the resolved
            // configPath gives an actionable diagnosis target (permissions,
            // disk full, read-only mount).
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

    // Defense-in-depth: nudge any client whose first /api/* fetch raced
    // initAsync. The `await ready` gate inside `handleDocumentList`
    // already prevents the false-empty cold-start response, but a client
    // that called an index-derived endpoint we have NOT yet gated (or
    // cached the empty response in some other layer) self-corrects when
    // these CC1 channels fire. The seed walk does not emit per-file
    // disk events for already-existing files, so without this push
    // nothing else would trigger a refresh until the next focus /
    // visibilitychange.
    signalChannel('files');
    signalChannel('backlinks');
    signalChannel('graph');
    signalChannel('tags');

    // initAsync has reached the point where `resolveReady` will fire — record
    // the elapsed-from-boot-start so the waterfall has a server-ready mark.
    // `bootElapsedMs` is undefined when boot timing was never started (e.g.
    // the dev-server / plugin path doesn't call `startBootTimings`), in which
    // case the field stays absent and the envelope omits it.
    const readyElapsed = bootElapsedMs();
    if (readyElapsed !== undefined) recordBootPhase('readyMs', readyElapsed);
  }

  // `ready` itself is the deferred Promise declared at the top of this factory
  // (so it could be passed into createApiExtension before initAsync ran).
  // Settle it now from initAsync's completion. Errors propagate through the
  // same channel callers awaited before.
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
