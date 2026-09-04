/**
 * `bootServer` — HTTP + WebSocket wrapping layer around `createServer()`.
 *
 * Three consumers share this composed boot path:
 *   1. CLI `ok start` (via `bootStartServer` in packages/cli)
 *   2. Electron utility process (direct import — precedent #14-adjacent)
 *   3. Integration tests
 *
 * Before this extraction every consumer reimplemented HTTP + WS upgrade
 * + `listen()` + `updateServerLockPort` + idle-shutdown + composite destroy.
 * The extraction consolidates those ~150 LOC here so all three callers share
 * a single tested orchestrator.
 *
 * Opt-outs (Electron utility uses these):
 *   - `idleShutdownMs: null` — disable idle-shutdown entirely
 *   - `skipAutoInit: true` — skip the pre-createServer scaffold hook
 *
 * CLI-specific concerns (`initContent`, banner, signal handlers)
 * are NOT part of bootServer — the CLI wrapper layers them on top via
 * injected callbacks + post-return orchestration.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  DEFAULT_SERVER_HOST,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  isLoopbackOnlyBind,
  LOCAL_DIR,
  OK_DIR,
  requiresExternalConsent,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import {
  resolveGitDir,
  resolveGitDirDetailed,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { context, propagation } from '@opentelemetry/api';
import { simpleGit } from 'simple-git';
import sirv from 'sirv';
import {
  AcpThreadManager,
  type AcpThreadManagerOptions,
  buildOkMcpStdioCommand,
} from './acp/thread-manager.ts';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import { bootElapsedMs, recordBootPhase, startBootTimings } from './boot-timings.ts';
import type { Config } from './config/schema.ts';
import { ConflictStore } from './conflict-storage.ts';
import { installCrashCapture } from './crash-capture.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { normalizeFsPath } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import {
  assertGitAvailable,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
} from './git-preflight.ts';
import { emitPreflightFailureSpan } from './git-preflight-telemetry.ts';
import {
  attachCollabClientCounter,
  attachIdleShutdown,
  type CollabClientCounter,
  type IdleShutdownHandle,
} from './idle-shutdown.ts';
import { scanGlobalInPlaceSkills, scanInPlaceSkills } from './in-place-skills.ts';
import { buildIngressPolicy, ExposureConsentError } from './ingress-policy.ts';
import { resolveLocalSinkConfig } from './local-sink-resolver.ts';
import { getLogger, loggerFactory, type PinoLogger } from './logger.ts';
import { createMcpHttpHandler } from './mcp-http.ts';
import { mountMcpAndApi, type ReadinessState } from './mcp-mount.ts';
import { MissingOkConfigError } from './missing-ok-config-error.ts';
import { createProjectRuntime, type ProjectRuntime } from './project-runtime.ts';
import { createServer, type ServerInstance, type ServerOptions } from './server-factory.ts';
import { installServerMemoryGauge, installServerRuntimeGauges } from './server-memory-telemetry.ts';
import {
  genuineInPlaceNames,
  migrateStoreSkillsInPlace,
  USER_HOST_ROOTS_BY_PRECEDENCE,
} from './skill-migrate.ts';
import { reconcileSkillInstalls } from './skill-reconcile.ts';
import { initTelemetry, shutdownTelemetry, withSpan } from './telemetry.ts';
import {
  initToleranceTelemetryWriter,
  teardownToleranceTelemetryWriter,
} from './tolerance-telemetry-writer.ts';

const LEGACY_RUNTIME_FILENAMES = [
  'server.lock',
  'ui.lock',
  'state.json',
  'principal.json',
  'sync-state.json',
  'conflicts.json',
  'last-spawn-error.log',
] as const;

const LEGACY_RUNTIME_DIRNAMES = ['cache', 'tmp'] as const;

export function findLegacyRuntimeFiles(okDir: string): string[] {
  const localDir = resolve(okDir, LOCAL_DIR);
  const localDirEmpty = (() => {
    if (!existsSync(localDir)) return true;
    try {
      return readdirSync(localDir).length === 0;
    } catch {
      return true;
    }
  })();
  if (!localDirEmpty) return [];

  const found: string[] = [];
  for (const name of LEGACY_RUNTIME_FILENAMES) {
    if (existsSync(resolve(okDir, name))) found.push(name);
  }
  for (const name of LEGACY_RUNTIME_DIRNAMES) {
    const candidate = resolve(okDir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        found.push(`${name}/`);
      }
    } catch {}
  }
  return found;
}

function computeWorktreeAttributes(projectDir: string): {
  kind: 'main' | 'linked';
  gitdir: string | null;
} {
  const result = resolveGitDirDetailed(projectDir);
  switch (result.kind) {
    case 'directory':
      return { kind: 'main', gitdir: result.path };
    case 'linked':
      return { kind: 'linked', gitdir: result.path };
    case 'malformed-pointer':
      return { kind: 'linked', gitdir: null };
    case 'inaccessible':
    case 'absent':
      return { kind: 'main', gitdir: null };
  }
}

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const DESTROY_STEP_TIMEOUT_MS = Number(process.env.OK_DESTROY_STEP_TIMEOUT_MS) || 5000;

export interface BootServerOptions
  extends Pick<
    ServerOptions,
    | 'contentDir'
    | 'projectDir'
    | 'contentRoot'
    | 'port'
    | 'host'
    | 'quiet'
    | 'debounce'
    | 'maxDebounce'
    | 'gitEnabled'
    | 'mcpTomlEditor'
    | 'commitDebounceMs'
    | 'wipRef'
    | 'destroyTimeoutMs'
    | 'localOpCliArgs'
    | 'authStreamHeartbeatMs'
    | 'onAgentWrite'
    | 'shadowRepo'
    | 'enableTestRoutes'
    | 'lockKind'
    | 'detectGh'
    | 'detectGhAccounts'
    | 'tokenStore'
    | 'embeddingsKeyStore'
    | 'singleDocRelPath'
    | 'ephemeral'
    | 'configHomedirOverride'
    | 'acpRegistryFetchImpl'
  > {
  config: Config;
  skipAutoInit?: boolean;
  serverRuntime?: ServerRuntimeConfig;
  bind?: readonly string[];
  probeHarnessManagedMcpEntry?: AcpThreadManagerOptions['probeHarnessManagedMcpEntry'];
  probePiAcpBridge?: AcpThreadManagerOptions['probePiAcpBridge'];
  ensurePiAcpBridge?: AcpThreadManagerOptions['ensurePiAcpBridge'];
  idleShutdownMs?: number | null;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
  autoInitFn?: () => boolean | Promise<boolean>;
  idleShutdownHandler?: (destroyServer: () => Promise<void>) => () => Promise<void>;
  log?: PinoLogger;
  keepaliveGraceMs?: number;
  gitPreflight?: () => GitDetected;
  skipStateManifestCheck?: boolean;
}

export type ServerExitReason = 'external-signal' | 'idle-shutdown' | 'parent-exit' | 'unspecified';

export interface BootedServer {
  httpServer: HttpServer;
  destroy: (reason?: ServerExitReason) => Promise<void>;
  lockDir: string;
  contentDir: string;
  port: number;
  ready: Promise<void>;
  generatedIndexSweepReady: ServerInstance['generatedIndexSweepReady'];
  degraded: readonly string[];
  didAutoInit: boolean;
  serverInstance: ServerInstance;
  runtime: ProjectRuntime;
  acpThreadManager: AcpThreadManager | null;
}

const PINO_REDACT_MAX_DEPTH = 5;

export async function bootServer(opts: BootServerOptions): Promise<BootedServer> {
  startBootTimings();

  const sinkProjectDir = opts.projectDir ?? opts.contentDir;
  const localSinkConfig = resolveLocalSinkConfig({
    projectDir: sinkProjectDir,
  });
  if (localSinkConfig) {
    const denylist = localSinkConfig.telemetry.attributeDenylist;
    const redactPaths: string[] = [];
    for (const key of denylist) {
      redactPaths.push(key);
      for (let depth = 1; depth <= PINO_REDACT_MAX_DEPTH; depth++) {
        redactPaths.push(`${'*.'.repeat(depth)}${key}`);
      }
    }
    loggerFactory.configure({
      pinoConfig: { fileSink: localSinkConfig.logs, redactPaths },
    });
  }
  initTelemetry({ localSink: localSinkConfig?.telemetry });
  initToleranceTelemetryWriter(sinkProjectDir);
  installServerMemoryGauge();
  installServerRuntimeGauges();

  const { kind: worktreeKind, gitdir: worktreeGitdir } = computeWorktreeAttributes(
    opts.projectDir ?? opts.contentDir,
  );
  const spanAttributes: Record<string, string> = { 'ok.worktree.kind': worktreeKind };
  if (worktreeGitdir !== null) {
    spanAttributes['ok.worktree.gitdir'] = normalizeFsPath(worktreeGitdir);
  }

  const crashCapture = installCrashCapture(sinkProjectDir);

  const startupTraceparent = process.env.OK_STARTUP_TRACEPARENT;
  const bootSpan = () =>
    withSpan('ok.boot', { attributes: spanAttributes }, async () => bootServerInner(opts));
  const runBoot = (): Promise<BootedServer> => {
    if (startupTraceparent) {
      try {
        const parentCtx = propagation.extract(context.active(), {
          traceparent: startupTraceparent,
        });
        return context.with(parentCtx, bootSpan);
      } catch (err) {
        getLogger('boot').warn({ err }, 'ok.boot trace-join failed — starting unparented boot');
      }
    }
    return bootSpan();
  };
  let booted: BootedServer;
  try {
    booted = await runBoot();
  } catch (err) {
    crashCapture.uninstall();
    throw err;
  }
  const innerDestroy = booted.destroy;
  booted.destroy = async (reason) => {
    try {
      await innerDestroy(reason);
    } finally {
      crashCapture.uninstall();
    }
  };
  return booted;
}

async function bootServerInner(opts: BootServerOptions): Promise<BootedServer> {
  const skipAutoInit = opts.skipAutoInit ?? false;
  const log = opts.log ?? getLogger('boot');

  const serverRuntime = opts.serverRuntime ?? {
    ...resolveServerRuntimeConfig(opts.config),
    allowExternal: false,
  };

  const effectiveBindAddresses =
    opts.bind !== undefined && opts.bind.length > 0
      ? opts.bind
      : [opts.host ?? DEFAULT_SERVER_HOST];

  const bindExposes =
    requiresExternalConsent(serverRuntime) || !isLoopbackOnlyBind(effectiveBindAddresses);
  if (bindExposes && !serverRuntime.allowExternal) {
    const exposingAddresses = isLoopbackOnlyBind(effectiveBindAddresses)
      ? serverRuntime.bind
      : effectiveBindAddresses;
    throw new ExposureConsentError(
      `refusing to start: the server would bind a non-loopback address (${exposingAddresses.join(', ')}), which exposes this server beyond this machine. Consent with OK_ALLOW_EXTERNAL=1, or server.allowExternal: true in .ok/local/config.yml.`,
    );
  }

  const ingressPolicy = buildIngressPolicy({ serverRuntime });
  if (
    serverRuntime.allowExternal &&
    !serverRuntime.loopbackOnly &&
    serverRuntime.externalUrl === undefined
  ) {
    if (ingressPolicy.bindLiterals.length === 0) {
      log.warn(
        { bind: serverRuntime.bind },
        '[ingress] server.allowExternal is set on a wildcard bind (0.0.0.0/::) with no server.externalUrl — external requests will be REFUSED (403 host-not-allowed) because no external Host name is admitted. Set server.externalUrl to the public origin clients dial (e.g. behind a reverse proxy or platform edge), or bind a specific address instead of a wildcard.',
      );
    } else {
      log.info(
        { bind: serverRuntime.bind },
        '[ingress] server.allowExternal is set with no server.externalUrl — the bind-address literals are admitted as Host names (direct IP access). Set server.externalUrl to admit a hostname.',
      );
    }
  }

  const envLockKind =
    process.env.OK_LOCK_KIND === 'mcp-spawned' || process.env.OK_LOCK_KIND === 'interactive'
      ? process.env.OK_LOCK_KIND
      : undefined;
  const lockKind = opts.lockKind ?? envLockKind ?? 'interactive';

  const { createServer: createHttpServer } = await import('node:http');
  const { markServerLockDraining, releaseServerLock, updateServerLockPort } = await import(
    './server-lock.ts'
  );

  let didAutoInit = false;
  if (!skipAutoInit && opts.autoInitFn) {
    try {
      const initResult = await opts.autoInitFn();
      didAutoInit = Boolean(initResult);
    } catch (err) {
      log.warn({ err }, 'autoInitFn failed');
    }
  }

  const projectDir = opts.projectDir ?? opts.contentDir;
  const okDir = resolve(projectDir, OK_DIR);
  const configPath = resolve(okDir, 'config.yml');
  if (!existsSync(configPath)) {
    const okDirExists = existsSync(okDir);
    throw new MissingOkConfigError(okDirExists ? 'config' : 'okdir', projectDir);
  }
  const gitignorePath = resolve(okDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    getLogger('boot').warn(
      { path: gitignorePath },
      `Note: ${OK_DIR}/.gitignore is missing — per-machine state files in ${OK_DIR}/ may show up as untracked changes. Run \`ok init\` to add the recommended ignore entries.`,
    );
  }

  const preflight = opts.gitPreflight ?? assertGitAvailable;
  try {
    if (opts.gitEnabled !== false) preflight();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
      const detectedVersion = err instanceof GitTooOldError ? err.detected : '';
      const reason = err instanceof GitTooOldError ? 'too_old' : 'not_available';
      emitPreflightFailureSpan(err);
      log.warn(
        {
          event: 'git_preflight_fail',
          platform: err.platform,
          reason,
          detectedVersion,
        },
        reason === 'not_available' ? 'git binary not found' : 'git binary too old',
      );
      process.stderr.write(`${err.message}\n`);
    }
    await shutdownTelemetry();
    await Promise.race([
      teardownToleranceTelemetryWriter(),
      new Promise<void>((resolve) => setTimeout(resolve, DESTROY_STEP_TIMEOUT_MS)),
    ]);
    throw err;
  }

  const legacyFound = findLegacyRuntimeFiles(okDir);
  if (legacyFound.length > 0) {
    getLogger('boot').warn(
      { files: legacyFound },
      `Found legacy runtime files at ${OK_DIR}/${legacyFound.join(', ')}. Delete ${OK_DIR}/ and re-init — these files moved to ${OK_DIR}/${LOCAL_DIR}/.`,
    );
  }

  let collabClientCounter: CollabClientCounter | null = null;

  const serverInstance = createServer({
    getCollabClientCount: () => collabClientCounter?.getCount() ?? 0,
    acpRegistryFetchImpl: opts.acpRegistryFetchImpl,
    contentDir: opts.contentDir,
    projectDir: opts.projectDir,
    ingressPolicy,
    contentRoot: opts.contentRoot,
    port: opts.port,
    host: opts.host,
    quiet: opts.quiet ?? false,
    debounce: opts.debounce,
    maxDebounce: opts.maxDebounce,
    gitEnabled: opts.gitEnabled,
    mcpTomlEditor: opts.mcpTomlEditor,
    commitDebounceMs: opts.commitDebounceMs,
    wipRef: opts.wipRef,
    enableTestRoutes: opts.enableTestRoutes,
    shadowRepo: opts.shadowRepo,
    destroyTimeoutMs: opts.destroyTimeoutMs,
    localOpCliArgs: opts.localOpCliArgs,
    authStreamHeartbeatMs: opts.authStreamHeartbeatMs,
    onAgentWrite: opts.onAgentWrite,
    lockKind,
    capabilities: opts.reactShellDistDir ? ['http', 'ws', 'ui'] : ['http', 'ws'],
    skipStateManifestCheck: opts.skipStateManifestCheck,
    detectGh: opts.detectGh,
    detectGhAccounts: opts.detectGhAccounts,
    tokenStore: opts.tokenStore,
    embeddingsKeyStore: opts.embeddingsKeyStore,
    singleDocRelPath: opts.singleDocRelPath,
    ephemeral: opts.ephemeral,
    configHomedirOverride: opts.configHomedirOverride,
  });

  const {
    hocuspocus,
    destroy: destroyHocuspocus,
    ready,
    degraded,
    lockDir,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
  } = serverInstance;

  const mcpHost = (() => {
    const host = opts.host ?? 'localhost';
    if (host === '0.0.0.0' || host === '::') return 'localhost';
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  })();
  let boundPort = opts.port ?? 0;
  const internalBaseUrl = (): string => `http://${mcpHost}:${boundPort}`;
  const mcpHttpHandler = opts.ephemeral
    ? undefined
    : createMcpHttpHandler({
        contentDir: opts.contentDir,
        projectDir: opts.projectDir ?? opts.contentDir,
        config: opts.config,
        getServerUrl: () => internalBaseUrl(),
        localApi: serverInstance.localApi,
        log,
      });

  const httpServer = createHttpServer();
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 60_000;

  const contentAssetMiddleware =
    opts.serveContentAssets !== false
      ? createAssetServeMiddleware({
          contentFilter: serverInstance.contentFilter,
          contentSirv: sirv(opts.contentDir, { dev: true, dotfiles: false }),
          inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
          assetExtensions: ASSET_EXTENSIONS,
          blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
          ingressPolicy,
        })
      : undefined;

  const reactShellMiddleware = opts.reactShellDistDir
    ? sirv(opts.reactShellDistDir, {
        single: true,
        gzip: true,
        etag: true,
        dev: true,
      })
    : undefined;

  const acpThreadManager = opts.ephemeral
    ? null
    : new AcpThreadManager({
        contentDir: opts.contentDir,
        localDir: lockDir,
        globalDir: resolve(homedir(), OK_DIR),
        registry: serverInstance.acpRegistry,
        permissions: serverInstance.acpPermissions,
        sessionManager,
        agentPresenceBroadcaster,
        resolveEmbed: serverInstance.resolveEmbed,
        isExcludedPath: (rel) => serverInstance.contentFilter.isExcluded(rel),
        isIgnoredPath: (rel) => serverInstance.contentFilter.isPathIgnored(rel),
        getLoadedDocText: (docName) =>
          hocuspocus.documents.get(docName)?.getText('source').toString() ?? null,
        getServerUrl: () => internalBaseUrl(),
        getMcpStdioCommand: () => buildOkMcpStdioCommand(opts.localOpCliArgs, boundPort, { log }),
        probeHarnessManagedMcpEntry: opts.probeHarnessManagedMcpEntry,
        probePiAcpBridge: opts.probePiAcpBridge,
        ensurePiAcpBridge: opts.ensurePiAcpBridge,
        log,
      });
  if (acpThreadManager !== null) await acpThreadManager.init();

  let readinessState: ReadinessState = 'pending';
  ready.then(
    () => {
      readinessState = 'ready';
    },
    () => {
      readinessState = 'failed';
    },
  );

  const mount = mountMcpAndApi({
    httpServer,
    hocuspocus,
    nativeApi: serverInstance.nativeApi,
    mcpHttpHandler,
    ingressPolicy,
    health: {
      readiness: () => readinessState,
      degraded: () => degraded,
    },
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    keepaliveGraceMs: opts.keepaliveGraceMs,
    contentAssetMiddleware,
    reactShellMiddleware,
    ephemeral: opts.ephemeral,
    acpThreadManager,
  });

  let destroy: (reason?: ServerExitReason) => Promise<void> = async () => {
    throw new Error('bootServer: destroy() invoked before initialization — boot did not complete');
  };

  collabClientCounter = attachCollabClientCounter(httpServer);

  let idleHandle: IdleShutdownHandle | null = null;
  if (opts.idleShutdownMs !== null) {
    const idleMs = opts.idleShutdownMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    const idleHandler =
      opts.idleShutdownHandler ??
      ((destroyFn) => async () => {
        await destroyFn();
      });
    idleHandle = attachIdleShutdown({
      httpServer,
      counter: collabClientCounter,
      thresholdMs: idleMs,
      log,
      onShutdown: idleHandler(async () => {
        await destroy('idle-shutdown');
      }),
    });
  }

  await restoreLifecycleFromConflictsJson({
    hocuspocus,
    projectDir: opts.projectDir ?? opts.contentDir,
    log,
  });

  const listenAddresses = [...new Set(effectiveBindAddresses)];
  const primaryAddress = listenAddresses[0];
  const cleanupAfterListenFailure = async (): Promise<void> => {
    await destroyHocuspocus().catch((teardownErr) => {
      log.warn({ err: teardownErr }, 'destroyHocuspocus failed during listen-error cleanup');
    });
    releaseServerLock(lockDir);
  };
  const listenOn = (server: HttpServer, port: number, address: string): Promise<void> =>
    new Promise<void>((resolveListen, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(port, address, () => {
        server.removeListener('error', onError);
        resolveListen();
      });
    });
  try {
    await listenOn(httpServer, opts.port ?? 0, primaryAddress ?? DEFAULT_SERVER_HOST);
  } catch (err) {
    await cleanupAfterListenFailure();
    throw err;
  }
  const primaryAddr = httpServer.address();
  const primaryPort =
    typeof primaryAddr === 'object' && primaryAddr !== null ? primaryAddr.port : (opts.port ?? 0);
  const secondaryServers: HttpServer[] = [];
  for (const address of listenAddresses.slice(1)) {
    const secondary = createHttpServer();
    secondary.headersTimeout = httpServer.headersTimeout;
    secondary.requestTimeout = httpServer.requestTimeout;
    for (const listener of httpServer.listeners('request')) {
      secondary.on('request', listener as (...args: unknown[]) => void);
    }
    for (const listener of httpServer.listeners('upgrade')) {
      secondary.on('upgrade', listener as (...args: unknown[]) => void);
    }
    try {
      await listenOn(secondary, primaryPort, address);
    } catch (err) {
      log.error(
        {
          err,
          failedAddress: address,
          port: primaryPort,
          alreadyBound: secondaryServers.length + 1,
        },
        '[boot] secondary address bind failed — unwinding all listeners',
      );
      for (const bound of [...secondaryServers, httpServer]) {
        bound.closeAllConnections?.();
        await new Promise<void>((resolveClose) => {
          bound.close((closeErr) => {
            if (closeErr) log.warn({ err: closeErr }, '[boot] listener close failed during unwind');
            resolveClose();
          });
        });
      }
      await cleanupAfterListenFailure();
      throw err;
    }
    secondaryServers.push(secondary);
  }

  const listenMs = bootElapsedMs();
  if (listenMs !== undefined) recordBootPhase('httpListenMs', listenMs);

  const addr = httpServer.address();
  const realPort = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? 0);
  boundPort = realPort;
  const boundBaseUrl = internalBaseUrl();
  updateServerLockPort(lockDir, realPort, boundBaseUrl);
  log.info(
    {
      event: 'server-listening',
      pid: process.pid,
      port: realPort,
      addresses: listenAddresses,
      url: boundBaseUrl,
      lockDir,
    },
    `[boot] listening on ${boundBaseUrl}`,
  );

  let destroyed = false;
  const withDestroyTimeout = async (name: string, work: () => Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${name} timed out after ${DESTROY_STEP_TIMEOUT_MS}ms`));
          }, DESTROY_STEP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  destroy = async (reason: ServerExitReason = 'unspecified'): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    log.info({ reason, pid: process.pid, lockDir }, `[server] shutdown initiated (${reason})`);
    readinessState = 'draining';
    const errors: unknown[] = [];
    const runStep = async (name: string, work: () => Promise<void>): Promise<void> => {
      try {
        await withDestroyTimeout(name, work);
      } catch (err) {
        errors.push(err);
        log.warn({ err, step: name }, 'bootServer destroy step failed');
      }
    };

    try {
      markServerLockDraining(lockDir);
    } catch (err) {
      log.warn({ err, step: 'markServerLockDraining' }, 'bootServer destroy step failed');
    }

    try {
      collabClientCounter?.detach();
    } catch (err) {
      log.warn({ err, step: 'collabClientCounter.detach' }, 'bootServer destroy step failed');
    }

    try {
      idleHandle?.detach();
    } catch (err) {
      errors.push(err);
      log.warn({ err, step: 'idleHandle.detach' }, 'bootServer destroy step failed');
    }

    if (acpThreadManager !== null) {
      await runStep('acpThreads.destroy', () => acpThreadManager.destroy());
    }
    await runStep('secondaryListeners.close', async () => {
      for (const secondary of secondaryServers) {
        secondary.closeAllConnections?.();
        await new Promise<void>((resolveClose) => {
          secondary.close((closeErr) => {
            if (closeErr) {
              log.warn({ err: closeErr }, '[boot] secondary listener close failed during teardown');
            }
            resolveClose();
          });
        });
      }
    });
    await runStep('mount.shutdown', () => mount.shutdown());
    if (mcpHttpHandler !== undefined) {
      await runStep('mcpHttpHandler.close', () => mcpHttpHandler.close());
    }
    await runStep(
      'mount.wss.close',
      () =>
        new Promise<void>((resolveClose, rejectClose) => {
          mount.wss.close((err) => (err ? rejectClose(err) : resolveClose()));
        }),
    );
    await runStep('httpServer.closeAllConnections', async () => {
      httpServer.closeAllConnections?.();
    });
    await runStep(
      'httpServer.close',
      () =>
        new Promise<void>((resolveClose, rejectClose) => {
          httpServer.close((err) =>
            err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? rejectClose(err)
              : resolveClose(),
          );
        }),
    );
    await runStep('destroyHocuspocus', () => destroyHocuspocus());
    await runStep('shutdownTelemetry', () => shutdownTelemetry());
    await runStep('teardownToleranceTelemetry', () => teardownToleranceTelemetryWriter());
    await runStep('flushLogFileSinks', () => loggerFactory.flushAllFileSinks());

    if (errors.length > 0) {
      throw new AggregateError(errors, 'bootServer destroy completed with errors');
    }
  };

  try {
    const m = await migrateStoreSkillsInPlace({
      projectDir,
      skillsRoot: resolve(opts.contentDir, OK_DIR, 'skills'),
      inPlaceNames: genuineInPlaceNames(opts.contentDir, scanInPlaceSkills(opts.contentDir)),
    });
    if (m.migrated.length + m.skipped.length > 0) {
      log.info?.(
        {
          event: 'store-skills-migrated-in-place',
          migrated: m.migrated,
          skipped: m.skipped,
        },
        `Migrated ${m.migrated.length} store skill(s) in place (${m.skipped.length} skipped).`,
      );
    }
  } catch (err) {
    log.warn?.(
      { err, event: 'store-skill-migration-failed' },
      'Store-skill in-place migration failed (non-fatal).',
    );
  }

  try {
    const home = homedir();
    const gm = await migrateStoreSkillsInPlace({
      projectDir: home,
      skillsRoot: resolve(home, OK_DIR, 'skills'),
      hostRoots: USER_HOST_ROOTS_BY_PRECEDENCE,
      inPlaceNames: genuineInPlaceNames(home, scanGlobalInPlaceSkills(home)),
    });
    if (gm.migrated.length + gm.skipped.length > 0) {
      log.info?.(
        {
          event: 'global-store-skills-migrated-in-place',
          migrated: gm.migrated,
          skipped: gm.skipped,
        },
        `Migrated ${gm.migrated.length} global store skill(s) in place (${gm.skipped.length} skipped).`,
      );
    }
  } catch (err) {
    log.warn?.(
      { err, event: 'global-store-skill-migration-failed' },
      'Global store-skill in-place migration failed (non-fatal).',
    );
  }

  try {
    const r = await reconcileSkillInstalls({
      projectDir,
      skillsRoot: resolve(opts.contentDir, OK_DIR, 'skills'),
    });
    const changed = r.healed.length + r.replaced.length + r.orphansRemoved.length;
    if (changed > 0) {
      log.info?.(
        {
          event: 'installed-skills-reconciled',
          healed: r.healed.length,
          replaced: r.replaced.length,
          orphansRemoved: r.orphansRemoved.length,
        },
        `Reconciled ${changed} editor skill entr${changed === 1 ? 'y' : 'ies'} to the symlink model.`,
      );
    }
  } catch (err) {
    log.warn?.(
      { event: 'installed-skills-reconcile-failed', err },
      'Installed-skills reconcile failed (non-fatal).',
    );
  }

  return {
    httpServer,
    destroy,
    lockDir,
    contentDir: opts.contentDir,
    port: realPort,
    ready,
    generatedIndexSweepReady: serverInstance.generatedIndexSweepReady,
    degraded,
    didAutoInit,
    serverInstance,
    runtime: createProjectRuntime(serverInstance, { contentDir: opts.contentDir, projectDir }),
    acpThreadManager,
  };
}

export async function restoreLifecycleFromConflictsJson(args: {
  hocuspocus: ServerInstance['hocuspocus'];
  projectDir: string;
  log: PinoLogger;
}): Promise<void> {
  const { hocuspocus, projectDir, log } = args;
  let store: ConflictStore;
  let entries: Array<{ file: string; variant?: 'working-tree' }>;
  try {
    store = new ConflictStore(projectDir);
    entries = store.list();
  } catch (err) {
    log.warn(
      { err, projectDir },
      '[boot] lifecycle restore: failed to read conflicts.json — skipping',
    );
    return;
  }
  if (entries.length === 0) return;

  const isWorkingTree = (e: { variant?: string }): boolean => e.variant === 'working-tree';
  let stillUnmerged: Set<string> | null = null;
  try {
    const gitDir = resolveGitDir(projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    if (!mergeHeadPath || !existsSync(mergeHeadPath)) {
      const staleMergeNative = entries.filter((e) => !isWorkingTree(e));
      for (const entry of staleMergeNative) store.removeConflict(entry.file);
      entries = entries.filter(isWorkingTree);
      if (staleMergeNative.length > 0) {
        console.warn(
          JSON.stringify({
            event: 'lifecycle-restore-cleared-stale-conflicts',
            reason: 'no-merge-head',
            count: staleMergeNative.length,
          }),
        );
      }
      if (entries.length === 0) return;
    } else {
      const pg = simpleGit({ baseDir: projectDir, timeout: { block: 5_000 } });
      stillUnmerged = new Set(await listNames(pg, ['diff', '--name-only', '--diff-filter=U']));
    }
  } catch (err) {
    log.warn(
      { err, projectDir },
      '[boot] lifecycle restore: git unmerged probe failed — restoring all entries',
    );
  }

  if (stillUnmerged !== null) {
    let pruned = 0;
    for (const entry of entries) {
      if (!isWorkingTree(entry) && !stillUnmerged.has(entry.file)) {
        store.removeConflict(entry.file);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.warn(
        JSON.stringify({
          event: 'lifecycle-restore-pruned-resolved-entries',
          pruned,
          remaining: entries.length - pruned,
        }),
      );
    }
    entries = entries.filter((e) => isWorkingTree(e) || stillUnmerged?.has(e.file));
    if (entries.length === 0) return;
  }

  for (const entry of entries) {
    const docName = stripDocExtension(entry.file);
    let dc: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | null = null;
    let restored = false;
    try {
      dc = await hocuspocus.openDirectConnection(docName);
      const document = dc.document;
      if (!document) continue;
      const lifecycleMap = document.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');
      restored = true;
      console.warn(
        JSON.stringify({
          event: 'lifecycle-restored-from-conflicts-json',
          'doc.name': docName,
        }),
      );
    } catch (err) {
      log.warn(
        { err, docName },
        '[boot] lifecycle restore: failed to set lifecycle for doc — skipping',
      );
    } finally {
      if (dc) {
        try {
          await dc.disconnect();
        } catch (err) {
          log.warn(
            { err, docName, restored },
            '[boot] lifecycle restore: disconnect failed after lifecycle write',
          );
        }
      }
    }
  }
}
