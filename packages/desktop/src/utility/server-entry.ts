import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  detectGh,
  detectGhAccounts,
  ensurePiBridge,
  getNativeTomlMcpEditor,
  loadConfig,
  makeLazyProbeTokenStore,
  probeOwnManagedEditorMcpEntry,
  probePiBridgeState,
} from '@inkeep/open-knowledge';
import { resolveServerRuntimeConfig, type ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  type BootServerOptions,
  type Config,
  ConfigSchema,
  ensureProjectGit,
  initContent,
  makeLazyEmbeddingsKeyStore,
  type ServerExitReason,
} from '@inkeep/open-knowledge-server';
import { type KeyringSmokeResult, runKeyringSmoke } from './keyring-smoke.ts';

export type { KeyringSmokeResult } from './keyring-smoke.ts';

export interface UtilityInitMessage {
  type: 'init';
  opts: Pick<
    BootServerOptions,
    | 'contentDir'
    | 'projectDir'
    | 'port'
    | 'host'
    | 'debounce'
    | 'maxDebounce'
    | 'localOpCliArgs'
    | 'reactShellDistDir'
  > & {
    didEnsureGit?: boolean;
    consentVersion?: number;
  };
}
export interface UtilityShutdownMessage {
  type: 'shutdown';
}
export interface UtilityDebugKeyringSmokeMessage {
  type: 'debug-keyring-smoke';
  correlationId: string;
}
export type UtilityIncomingMessage =
  | UtilityInitMessage
  | UtilityShutdownMessage
  | UtilityDebugKeyringSmokeMessage;

export interface UtilityReadyMessage {
  type: 'ready';
  port: number;
  apiOrigin: string;
}
export interface UtilityErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
  kind?: 'lock-collision' | 'mcp-server-stuck' | 'mcp-server-killed';
  existingLock?: {
    pid: number;
    hostname: string;
    port: number;
    startedAt: string;
    worktreeRoot: string;
    kind?: 'interactive' | 'mcp-spawned';
    capabilities?: string[];
  };
}
export interface UtilityDegradedMessage {
  type: 'degraded';
  subsystems: readonly string[];
}
export interface UtilityDebugKeyringSmokeResultMessage {
  type: 'debug-keyring-smoke-result';
  correlationId: string;
  result: KeyringSmokeResult;
}
export type UtilityOutgoingMessage =
  | UtilityReadyMessage
  | UtilityErrorMessage
  | UtilityDegradedMessage
  | UtilityDebugKeyringSmokeResultMessage;

export interface SetupUtilityDeps {
  parentPort: {
    on(event: 'message', handler: (event: { data: unknown }) => void): void;
    postMessage(value: UtilityOutgoingMessage): void;
  } | null;
  importServer: () => Promise<typeof import('@inkeep/open-knowledge-server')>;
  exit: (code: number) => void;
  parentPid: number;
  killProbe: (pid: number, signal: number | string) => void;
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  setInterval: (cb: () => void, ms: number) => { unref?: () => void; clear: () => void };
  parentPollMs?: number;
  runSmoke?: () => Promise<KeyringSmokeResult>;
  env?: Record<string, string | undefined>;
  writeSmokeResult?: (path: string, contents: string) => Promise<void>;
  prepareBootEnvironment?: PrepareBootEnvironment;
}

export interface PreparedBootEnvironment {
  config: Config;
  contentDir: string;
  contentRoot: string | undefined;
  configValid: boolean;
  serverRuntime: ServerRuntimeConfig;
  degradedHints?: readonly string[];
}

export type PrepareBootEnvironment = (
  ipcOpts: UtilityInitMessage['opts'],
) => Promise<PreparedBootEnvironment>;

export type UtilityShutdownReason = 'parent-died' | 'shutdown-ipc' | 'SIGTERM' | 'SIGINT';

const SERVER_EXIT_REASONS: Record<UtilityShutdownReason, ServerExitReason> = {
  'parent-died': 'parent-exit',
  'shutdown-ipc': 'parent-exit',
  SIGTERM: 'external-signal',
  SIGINT: 'external-signal',
};

export interface UtilityHandle {
  readyPromise: Promise<UtilityReadyMessage>;
  stopParentPoll(): void;
  shutdown(reason: UtilityShutdownReason): Promise<void>;
}

export function setupUtility(deps: SetupUtilityDeps): UtilityHandle {
  let booted: BootedServer | null = null;
  let parentPollHandle: { unref?: () => void; clear: () => void } | null = null;
  let shuttingDown = false;
  let resolveReady!: (msg: UtilityReadyMessage) => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<UtilityReadyMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function startParentPoll() {
    const pollMs = deps.parentPollMs ?? 5000;
    parentPollHandle = deps.setInterval(() => {
      try {
        deps.killProbe(deps.parentPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ESRCH') {
          void shutdown('parent-died');
          return;
        }
        console.warn('[utility] parent-poll unexpected errno — continuing', {
          code: code ?? '(missing)',
          parentPid: deps.parentPid,
        });
      }
    }, pollMs);
    parentPollHandle.unref?.();
  }

  function stopParentPoll() {
    parentPollHandle?.clear();
    parentPollHandle = null;
  }

  async function shutdown(reason: UtilityShutdownReason): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentPoll();
    let drainOk = true;
    if (booted) {
      try {
        await booted.destroy(SERVER_EXIT_REASONS[reason]);
      } catch (err) {
        drainOk = false;
        deps.parentPort?.postMessage({
          type: 'error',
          message: `destroy failed during ${reason}: ${(err as Error).message}`,
          stack: (err as Error).stack,
        });
      }
    }
    deps.exit(drainOk ? 0 : 1);
  }

  async function handleInit(msg: UtilityInitMessage) {
    try {
      const server = await deps.importServer();
      const projectDir = msg.opts.projectDir ?? msg.opts.contentDir;
      const prepare = deps.prepareBootEnvironment ?? defaultPrepareBootEnvironment;
      const prepared = await prepare(msg.opts);

      if (env.OK_DEBUG_DESKTOP_BOOT_TRACE === '1') {
        console.warn(
          `[desktop-boot-trace] projectDir=${projectDir} contentRoot=${JSON.stringify(
            prepared.contentRoot,
          )} resolvedContentDir=${prepared.contentDir} configValid=${prepared.configValid}`,
        );
      }

      const tokenStore = makeLazyProbeTokenStore();
      const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

      const bootOpts: BootServerOptions = {
        ...msg.opts,
        contentDir: prepared.contentDir,
        contentRoot: prepared.contentRoot,
        config: prepared.config,
        serverRuntime: prepared.serverRuntime,
        bind: prepared.serverRuntime.bind,
        idleShutdownMs: null,
        skipAutoInit: true,
        autoInitFn: undefined,
        detectGh,
        detectGhAccounts,
        tokenStore,
        embeddingsKeyStore,
        mcpTomlEditor: getNativeTomlMcpEditor(),
        probeHarnessManagedMcpEntry: (editorId, agentCwd) =>
          probeOwnManagedEditorMcpEntry(editorId, agentCwd),
        probePiAcpBridge: (agentCwd) => probePiBridgeState(agentCwd),
        ensurePiAcpBridge: (agentCwd) => ensurePiBridge(agentCwd),
        serveContentAssets: true,
        ...(msg.opts.reactShellDistDir ? { reactShellDistDir: msg.opts.reactShellDistDir } : {}),
      };

      const requestedPort = prepared.serverRuntime.port ?? msg.opts.port;
      try {
        booted = await server.bootServer({ ...bootOpts, port: requestedPort });
      } catch (err) {
        if (isFixedPort(requestedPort) && isAddressInUse(err)) {
          console.warn(
            `[boot] pinned server.port ${requestedPort} is already in use — falling back to an ephemeral port`,
          );
          booted = await server.bootServer({ ...bootOpts, port: 0 });
        } else {
          throw err;
        }
      }
      const readyMsg: UtilityReadyMessage = {
        type: 'ready',
        port: booted.port,
        apiOrigin: `http://localhost:${booted.port}`,
      };
      deps.parentPort?.postMessage(readyMsg);
      resolveReady(readyMsg);

      const mergedDegraded: readonly string[] = [
        ...booted.degraded,
        ...(prepared.degradedHints ?? []),
      ];
      if (mergedDegraded.length > 0) {
        deps.parentPort?.postMessage({
          type: 'degraded',
          subsystems: mergedDegraded,
        });
      }
    } catch (err) {
      const errMsg: UtilityErrorMessage = {
        type: 'error',
        message: (err as Error).message,
        stack: (err as Error).stack,
      };
      const errName = err && typeof err === 'object' ? (err as Error).name : '';
      if (errName === 'ServerLockCollisionError') {
        const existing = (err as { existing?: UtilityErrorMessage['existingLock'] }).existing;
        if (existing) {
          errMsg.kind = 'lock-collision';
          errMsg.existingLock = existing;
        }
      }
      const isGitPreflightFailure =
        errName === 'GitNotAvailableError' || errName === 'GitTooOldError';
      deps.parentPort?.postMessage(errMsg);
      rejectReady(err as Error);
      deps.exit(isGitPreflightFailure ? 78 : 1);
    }
  }

  const runSmoke = deps.runSmoke ?? runKeyringSmoke;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const writeSmokeResult = deps.writeSmokeResult ?? defaultWriteSmokeResult;

  async function handleDebugKeyringSmoke(msg: UtilityDebugKeyringSmokeMessage): Promise<void> {
    const result = await runSmoke();
    deps.parentPort?.postMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: msg.correlationId,
      result,
    });
  }

  function registerMessageListener(): void {
    deps.parentPort?.on('message', (event) => {
      const msg = event.data as UtilityIncomingMessage;
      if (msg?.type === 'init') {
        void handleInit(msg);
      } else if (msg?.type === 'shutdown') {
        void shutdown('shutdown-ipc');
      } else if (msg?.type === 'debug-keyring-smoke') {
        void handleDebugKeyringSmoke(msg);
      }
    });
  }

  async function runBootAutoSmoke(): Promise<void> {
    const result = await runSmoke();
    const outPath = env.OK_DEBUG_KEYRING_SMOKE_OUT;
    if (outPath && outPath.length > 0) {
      try {
        await writeSmokeResult(outPath, `${JSON.stringify(result)}\n`);
      } catch (err) {
        console.warn('[utility] auto-smoke write failed', {
          err: (err as Error).message,
          outPath,
        });
      }
    }
    deps.parentPort?.postMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'auto-boot',
      result,
    });
    if (env.OK_DEBUG_KEYRING_SMOKE_EXIT === '1') {
      deps.exit(0);
      return;
    }
    registerMessageListener();
  }

  if (env.OK_DEBUG_KEYRING_SMOKE === '1') {
    void runBootAutoSmoke();
  } else {
    registerMessageListener();
  }

  deps.onSignal('SIGTERM', () => void shutdown('SIGTERM'));
  deps.onSignal('SIGINT', () => void shutdown('SIGINT'));

  startParentPoll();

  return {
    readyPromise,
    stopParentPoll,
    shutdown,
  };
}

async function defaultWriteSmokeResult(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf-8' });
  await rename(tmp, path);
}

function isFixedPort(port: number | undefined): port is number {
  return typeof port === 'number' && port > 0;
}

function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

export function resolveDesktopServerRuntime(projectDir: string): {
  config: Config;
  configValid: boolean;
  serverRuntime: ServerRuntimeConfig;
} {
  let config: Config;
  let configValid: boolean;
  try {
    const result = loadConfig(projectDir);
    config = result.config;
    configValid = true;
    for (const diag of result.diagnostics) {
      const extra =
        'detail' in diag ? `: ${diag.detail}` : 'path' in diag ? `: ${diag.path.join('.')}` : '';
      console.warn(`[config] ${diag.code}${extra}`);
    }
    for (const { from, to } of result.sidelined) {
      console.warn(
        `[config] ${from} could not be parsed — moved to ${to}; booting on the remaining layers.`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[config] desktop boot config invalid — using schema defaults: ${detail}`);
    config = ConfigSchema.parse({});
    configValid = false;
  }
  return { config, configValid, serverRuntime: resolveServerRuntimeConfig(config) };
}

async function defaultPrepareBootEnvironment(
  ipcOpts: UtilityInitMessage['opts'],
): Promise<PreparedBootEnvironment> {
  const projectDir = ipcOpts.projectDir ?? ipcOpts.contentDir;

  const degradedHints: string[] = [];
  if (ipcOpts.didEnsureGit !== true) {
    const result = await ensureProjectGit(projectDir);
    if (result.repaired === true) {
      degradedHints.push('project-git-shell-only');
    }
  }

  initContent(projectDir);

  const { config, configValid, serverRuntime } = resolveDesktopServerRuntime(projectDir);

  const contentDir = resolveContentDir(projectDir, config, ipcOpts.contentDir);
  const rawContentDir = config.content.dir;
  const contentRoot =
    typeof rawContentDir === 'string' && rawContentDir.length > 0 && rawContentDir !== '.'
      ? rawContentDir
      : undefined;
  return {
    config,
    contentDir,
    contentRoot,
    configValid,
    serverRuntime,
    degradedHints: degradedHints.length > 0 ? degradedHints : undefined,
  };
}

export function resolveContentDir(
  projectDir: string,
  config: Config,
  ipcFallback: string | undefined,
): string {
  const fallback = ipcFallback ?? projectDir;
  const configContentDir = config.content.dir;
  if (
    typeof configContentDir !== 'string' ||
    configContentDir.length === 0 ||
    configContentDir === '.'
  ) {
    return fallback;
  }
  const resolved = isAbsolute(configContentDir)
    ? configContentDir
    : resolve(projectDir, configContentDir);
  const rel = relative(projectDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.warn(
      `[config] content.dir=${JSON.stringify(configContentDir)} resolves outside projectDir — using IPC fallback`,
    );
    return fallback;
  }
  return resolved;
}

if ((process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  setupUtility({
    parentPort: (process as NodeJS.Process & { parentPort: SetupUtilityDeps['parentPort'] })
      .parentPort,
    importServer: () => import('@inkeep/open-knowledge-server'),
    exit: (code) => process.exit(code),
    parentPid: process.ppid,
    killProbe: (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals | 0);
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    setInterval: (cb, ms) => {
      const handle = setInterval(cb, ms);
      return {
        unref: () => handle.unref(),
        clear: () => clearInterval(handle),
      };
    },
  });
}
