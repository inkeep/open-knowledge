import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { detectGh, makeLazyProbeTokenStore } from '@inkeep/open-knowledge';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import {
  type BootedServer,
  type BootServerOptions,
  type Config,
  ConfigSchema,
  ensureProjectGit,
  initContent,
  makeLazyEmbeddingsKeyStore,
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
  degradedHints?: readonly string[];
}

export type PrepareBootEnvironment = (
  ipcOpts: UtilityInitMessage['opts'],
) => Promise<PreparedBootEnvironment>;

export interface UtilityHandle {
  readyPromise: Promise<UtilityReadyMessage>;
  stopParentPoll(): void;
  shutdown(reason: string): Promise<void>;
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

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentPoll();
    let drainOk = true;
    if (booted) {
      try {
        await booted.destroy();
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

      booted = await server.bootServer({
        ...msg.opts,
        contentDir: prepared.contentDir,
        contentRoot: prepared.contentRoot,
        config: prepared.config,
        attachUiSibling: false, // No `ok ui` sibling under Electron
        idleShutdownMs: null, // BrowserWindow lifecycle owns utility lifetime
        skipAutoInit: true,
        autoInitFn: undefined,
        detectGh,
        tokenStore,
        embeddingsKeyStore,
        serveContentAssets: true,
        ...(msg.opts.reactShellDistDir ? { reactShellDistDir: msg.opts.reactShellDistDir } : {}),
      });
      const readyMsg: UtilityReadyMessage = {
        type: 'ready',
        port: booted.port,
        apiOrigin: `http://localhost:${booted.port}`,
      };
      deps.parentPort?.postMessage(readyMsg);
      resolveReady(readyMsg);

      const mergedDegraded: readonly string[] =
        prepared.degradedHints && prepared.degradedHints.length > 0
          ? [...booted.degraded, ...prepared.degradedHints]
          : booted.degraded;
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
      if (errName === 'ServerLockCollisionError' || errName === 'UiLockCollisionError') {
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

  const configResult = readConfigSafely({
    absPath: resolveConfigPath('project', projectDir),
    sideline: false,
    warn: (m: string) => console.warn(m),
  });
  let config: Config;
  let configValid: boolean;
  if (configResult.valid) {
    config = configResult.value;
    configValid = true;
  } else {
    console.warn('[config] desktop boot config invalid — using schema defaults');
    config = ConfigSchema.parse({});
    configValid = false;
  }

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
