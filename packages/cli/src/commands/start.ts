import {
  type ChildProcess,
  type spawn as NativeSpawn,
  spawn as nativeSpawn,
} from 'node:child_process';
import { closeSync, existsSync as fsExistsSync, mkdirSync as fsMkdirSync, openSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SIGTERM_GRACE_MS as SHARED_DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS as SHARED_DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
} from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  type Config,
  isProjectRoot,
  type PinoLogger,
  prepareSingleFileOpen,
} from '@inkeep/open-knowledge-server';
import { Command, InvalidArgumentError } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { OK_DIR, PACKAGE_VERSION } from '../constants.ts';
import {
  createRealDetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';
import { resolveSelfSpawn } from './self-spawn.ts';

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export function resolveHost(
  opts: { host?: string },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.host ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

const PROCESS_TITLE_PROJECT_NAME_MAX = 64;

export function deriveServerProcessTitle(cwd: string): string {
  const raw = basename(cwd);
  const sanitized = raw
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, PROCESS_TITLE_PROJECT_NAME_MAX);
  const projectName = sanitized.length > 0 ? sanitized : 'unknown';
  return `open-knowledge-server ${projectName}`;
}

export class OkDirMissingError extends Error {
  readonly cwd: string;
  constructor(cwd: string) {
    super("This directory isn't set up yet. Run `ok init` first, then `ok start` again.");
    this.name = 'OkDirMissingError';
    this.cwd = cwd;
  }
}

export type UiSpawnDecision =
  | { action: 'spawn'; reason: 'absent' }
  | { action: 'spawn'; reason: 'stale'; stalePid: number }
  | { action: 'skip'; reason: 'alive'; pid: number; port: number };

interface DecideUiSpawnInput {
  uiLock: { pid: number; port: number } | null;
  isAlive: (pid: number) => boolean;
}

export function decideUiSpawn(input: DecideUiSpawnInput): UiSpawnDecision {
  if (!input.uiLock) return { action: 'spawn', reason: 'absent' };
  if (!input.isAlive(input.uiLock.pid)) {
    return { action: 'spawn', reason: 'stale', stalePid: input.uiLock.pid };
  }
  return { action: 'skip', reason: 'alive', pid: input.uiLock.pid, port: input.uiLock.port };
}

interface SpawnOkUiOptions {
  lockDir: string;
  cwd: string;
  spawn?: typeof NativeSpawn;
  args?: string[];
}

export function spawnOkUi(opts: SpawnOkUiOptions): ChildProcess {
  if (!fsExistsSync(opts.lockDir)) fsMkdirSync(opts.lockDir, { recursive: true });
  const stderrPath = join(opts.lockDir, SPAWN_ERROR_LOG);
  const stderrFd = openSync(stderrPath, 'w');
  const spawnFn = opts.spawn ?? nativeSpawn;
  const { PORT: _strippedPort, ...childEnv } = process.env;
  const self = resolveSelfSpawn();
  try {
    const child = spawnFn(self.command, [...self.prefixArgs, ...(opts.args ?? ['ui'])], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd: opts.cwd,
      env: {
        ...childEnv,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    child.unref();
    return child;
  } finally {
    try {
      closeSync(stderrFd);
    } catch {}
  }
}

export function resolveCollabPort(
  portFromCli: number | undefined,
  portFromEnv: number | undefined,
  requestedUiPort: number | undefined,
): number | undefined {
  return portFromCli ?? (requestedUiPort !== undefined ? undefined : portFromEnv);
}

export function shouldConnectToExistingServer(
  requestedUiPort: number | undefined,
  liveServer: { port: number } | null,
): boolean {
  return requestedUiPort !== undefined && liveServer !== null && liveServer.port > 0;
}

export function computeConnectExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  forwardedShutdown: boolean,
): number {
  return code ?? (signal != null && !forwardedShutdown ? 1 : 0);
}

interface ConnectUiSiblingOptions {
  cwd: string;
  uiPort: number;
  spawn?: typeof NativeSpawn;
}

export async function connectUiSibling(opts: ConnectUiSiblingOptions): Promise<void> {
  const spawnFn = opts.spawn ?? nativeSpawn;
  const self = resolveSelfSpawn();
  const { PORT: _strippedPort, ...parentEnv } = process.env;
  const child = spawnFn(self.command, [...self.prefixArgs, 'ui', '--port', String(opts.uiPort)], {
    cwd: opts.cwd,
    stdio: 'inherit',
    env: {
      ...parentEnv,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  let forwardedShutdown = false;
  const forward = (signal: NodeJS.Signals): void => {
    forwardedShutdown = true;
    try {
      child.kill(signal);
    } catch {}
  };
  const forwardSigint = () => forward('SIGINT');
  const forwardSigterm = () => forward('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);

  await new Promise<void>((done) => {
    child.on('exit', (code, signal) => {
      process.exitCode = computeConnectExitCode(code, signal, forwardedShutdown);
      done();
    });
    child.on('error', (err) => {
      console.error(
        `[start] connect fallback: failed to spawn ok ui — ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      done();
    });
  });

  process.removeListener('SIGINT', forwardSigint);
  process.removeListener('SIGTERM', forwardSigterm);
}

interface AwaitUiSiblingPortInput {
  readUiLock: () => { port: number } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}

export async function awaitUiSiblingPort(deps: AwaitUiSiblingPortInput): Promise<number | null> {
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    const lock = deps.readUiLock();
    if (lock && lock.port > 0) return lock.port;
    await deps.sleep(deps.pollIntervalMs);
  }
  const lock = deps.readUiLock();
  if (lock && lock.port > 0) return lock.port;
  return null;
}

interface BuildIdleShutdownHandlerInput {
  readUiLock: () => { pid: number; port: number } | null;
  isAlive: (pid: number) => boolean;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  destroy: () => Promise<void>;
  sigtermPollIntervalMs?: number;
  sigtermGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

/** 10s grace before SIGKILL escalation — long enough for a healthy UI to
 * release its lock + close sockets; short enough that a wedged UI (GC
 * pause, downstream fetch hang) doesn't stall idle-shutdown indefinitely. */
const DEFAULT_SIGTERM_GRACE_MS = SHARED_DEFAULT_SIGTERM_GRACE_MS;
const DEFAULT_SIGTERM_POLL_MS = SHARED_DEFAULT_SIGTERM_POLL_MS;

export function withEphemeralTempDirReap(
  handler: () => Promise<void>,
  projectDir: string,
  rmFn: (dir: string) => Promise<void> = (dir) => rm(dir, { recursive: true, force: true }),
): () => Promise<void> {
  return async () => {
    try {
      await handler();
    } finally {
      try {
        await rmFn(projectDir);
      } catch (err) {
        process.stderr.write(
          `[start] ephemeral temp dir reap failed for ${projectDir}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
}

export function buildIdleShutdownHandler(
  input: BuildIdleShutdownHandlerInput,
): () => Promise<void> {
  const graceMs = input.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const pollMs = input.sigtermPollIntervalMs ?? DEFAULT_SIGTERM_POLL_MS;
  const sleep = input.sleep ?? ((ms: number) => wait(ms));

  return async () => {
    try {
      const lock = input.readUiLock();
      if (lock && input.isAlive(lock.pid)) {
        try {
          input.killPid(lock.pid, 'SIGTERM');
          input.log?.info({ pid: lock.pid, port: lock.port }, 'idle-shutdown: SIGTERM UI sibling');
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline) {
            if (!input.isAlive(lock.pid)) break;
            await sleep(pollMs);
          }
          if (input.isAlive(lock.pid)) {
            try {
              input.killPid(lock.pid, 'SIGKILL');
              input.log?.warn(
                { pid: lock.pid, graceMs },
                'idle-shutdown: SIGTERM grace expired — escalated to SIGKILL',
              );
            } catch (err) {
              input.log?.error(
                { pid: lock.pid, err: err instanceof Error ? err.message : String(err) },
                'idle-shutdown: SIGKILL failed',
              );
            }
          }
        } catch (err) {
          input.log?.warn(
            { pid: lock.pid, err: err instanceof Error ? err.message : String(err) },
            'idle-shutdown: failed to SIGTERM UI sibling',
          );
        }
      }
    } catch (err) {
      input.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'idle-shutdown: UI lookup failed; proceeding with destroy',
      );
    }
    await input.destroy();
  };
}

interface BootStartServerOptions {
  config: Config;
  cwd: string;
  host: string;
  port?: number;
  uiPort?: number;
  skipAutoInit?: boolean;
  skipUiAutoSpawn?: boolean;
  spawn?: typeof NativeSpawn;
  idleThresholdMs?: number;
  uiBindTimeoutMs?: number;
  log?: PinoLogger;
  repairMcpConfigsFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => unknown;
  repairLaunchJsonFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => unknown;
  repairSkillsFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => Promise<unknown> | unknown;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
  singleFile?: string;
  projectDir?: string;
}

export interface BootedStartServer {
  httpServer: HttpServer;
  destroy: () => Promise<void>;
  lockDir: string;
  contentDir: string;
  port: number;
  ready: Promise<void>;
  degraded: readonly string[];
  uiSpawnDecision: UiSpawnDecision;
  resolvedUiPort: number | null;
}

export async function bootStartServer(opts: BootStartServerOptions): Promise<BootedStartServer> {
  const { config, cwd, host } = opts;
  const skipAutoInit = opts.skipAutoInit ?? false;
  const skipUiAutoSpawn = opts.skipUiAutoSpawn ?? false;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  const { existsSync, mkdirSync } = await import('node:fs');
  const { basename, dirname } = await import('node:path');
  const { bootServer, getLogger, isProcessAlive, readUiLock, resolveContentDir } = await import(
    '@inkeep/open-knowledge-server'
  );

  const log = opts.log ?? getLogger('start');

  const ephemeral = opts.singleFile !== undefined;
  const ephemeralProjectDir = opts.projectDir ?? cwd;
  const ephemeralFile = ephemeral
    ? prepareSingleFileOpen(opts.singleFile as string).canonicalFilePath
    : undefined;
  const ephemeralContentDir = ephemeralFile ? dirname(ephemeralFile) : undefined;
  const ephemeralDocRelPath = ephemeralFile ? basename(ephemeralFile) : undefined;

  if (!ephemeral) {
    if (!skipAutoInit && !isProjectRoot(cwd)) {
      throw new OkDirMissingError(cwd);
    }

    const reclaimDisableEnv = process.env.OK_RECLAIM_DISABLE ?? null;

    const reclaimEventLogger = (event: { event: string }) => {
      const name = typeof event.event === 'string' ? event.event : '';
      if (name.endsWith('-failed') || name.endsWith('-error') || name.endsWith('-missing')) {
        log.warn({ event }, '[start] reclaim sweep reported a problem');
      }
    };

    try {
      const repair =
        opts.repairMcpConfigsFn ?? (await import('./repair-mcp-configs.ts')).repairMcpConfigs;
      repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] mcp-config repair sweep failed; continuing');
    }

    try {
      const repair =
        opts.repairLaunchJsonFn ?? (await import('./repair-launch-json.ts')).repairLaunchJson;
      repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] launch.json repair sweep failed; continuing');
    }

    try {
      const repair = opts.repairSkillsFn ?? (await import('./repair-skills.ts')).repairSkills;
      await repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] skill repair sweep failed; continuing');
    }
  }

  const contentDir = ephemeralContentDir ?? resolveContentDir(config, cwd);
  if (!ephemeral && !existsSync(contentDir)) {
    mkdirSync(contentDir, { recursive: true });
    log.info({ contentDir }, 'Created content directory');
  }

  let uiSpawnDecision: UiSpawnDecision | null = null;
  const spawnUiSiblingFn = async ({
    lockDir: resolvedLockDir,
  }: {
    lockDir: string;
    log: PinoLogger;
  }) => {
    const uiLockBefore = readUiLock(resolvedLockDir);
    uiSpawnDecision = decideUiSpawn({
      uiLock: uiLockBefore,
      isAlive: isProcessAlive,
    });
    if (uiSpawnDecision.action === 'spawn' && !skipUiAutoSpawn) {
      try {
        const uiArgs =
          opts.uiPort !== undefined ? ['ui', '--port', String(opts.uiPort)] : undefined;
        spawnOkUi({ lockDir: resolvedLockDir, cwd, spawn: opts.spawn, args: uiArgs });
        log.info(
          { reason: uiSpawnDecision.reason, uiPort: opts.uiPort },
          '[start] auto-spawned ok ui sibling',
        );
      } catch (err) {
        console.warn(
          `[start] failed to auto-spawn ok ui: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (uiSpawnDecision.action === 'skip') {
      log.info(
        { port: uiSpawnDecision.port, pid: uiSpawnDecision.pid },
        `UI already running at port ${uiSpawnDecision.port}`,
      );
    }
  };

  const attachUiSibling = opts.reactShellDistDir === undefined;

  const tokenStore = makeLazyProbeTokenStore();
  const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

  const booted: BootedServer = await bootServer({
    config,
    contentDir,
    projectDir: ephemeral ? ephemeralProjectDir : cwd,
    contentRoot: ephemeral ? undefined : config.content.dir,
    port: opts.port,
    host,
    quiet: false,
    detectGh,
    tokenStore,
    embeddingsKeyStore,
    ...(ephemeral
      ? {
          ephemeral: true as const,
          singleDocRelPath: ephemeralDocRelPath,
          gitEnabled: false as const,
          gitPreflight: () => ({
            ok: true as const,
            version: '0.0.0',
            resolvedPath: 'git',
            source: 'PATH' as const,
          }),
        }
      : {}),
    localOpCliArgs: [process.execPath, process.argv[1]],
    attachUiSibling,
    idleShutdownMs: idleThresholdMs,
    skipAutoInit: true, // Guard already ran above; no scaffold fn to pass
    ...(attachUiSibling ? { spawnUiSiblingFn } : {}),
    idleShutdownHandler: (destroyServer) => {
      const handler = buildIdleShutdownHandler({
        readUiLock: () => readUiLock(booted.lockDir),
        isAlive: isProcessAlive,
        killPid: (pid, signal) => {
          process.kill(pid, signal);
        },
        destroy: destroyServer,
        log,
      });
      return ephemeral ? withEphemeralTempDirReap(handler, ephemeralProjectDir) : handler;
    },
    log,
    ...(opts.serveContentAssets ? { serveContentAssets: true } : {}),
    ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
  });

  uiSpawnDecision ||= { action: 'skip', reason: 'alive', pid: 0, port: 0 };

  const decisionAtBoot: UiSpawnDecision = uiSpawnDecision;
  let resolvedUiPort: number | null = null;
  if (decisionAtBoot.action === 'skip') {
    resolvedUiPort = decisionAtBoot.port > 0 ? decisionAtBoot.port : null;
  } else if (!skipUiAutoSpawn) {
    const uiBindTimeoutMs = opts.uiBindTimeoutMs ?? 3000;
    resolvedUiPort = await awaitUiSiblingPort({
      readUiLock: () => readUiLock(booted.lockDir),
      now: Date.now,
      sleep: (ms) => wait(ms),
      timeoutMs: uiBindTimeoutMs,
      pollIntervalMs: 50,
    });
    if (resolvedUiPort === null) {
      log.warn(
        { timeoutMs: uiBindTimeoutMs },
        '[start] ok ui did not bind within timeout — banner falls back to API URL',
      );
    }
  }

  return {
    httpServer: booted.httpServer,
    destroy: booted.destroy,
    lockDir: booted.lockDir,
    contentDir,
    port: booted.port,
    ready: booted.ready,
    degraded: booted.degraded,
    uiSpawnDecision,
    resolvedUiPort,
  };
}

type StartMode = 'browser' | 'app';

interface StartCommandOptions {
  port?: string | number;
  uiPort?: string | number;
  host?: string;
  open?: boolean;
  mode?: StartMode;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
  /** From `--single-file <path>`. See `BootStartServerOptions.singleFile` — boots
   *  the no-project ephemeral single-file shape (the desktop spawn passes it). */
  singleFile?: string;
  /** From `--project-dir <dir>`. See `BootStartServerOptions.projectDir` — the
   *  throwaway temp project root for the ephemeral single-file shape. */
  projectDir?: string;
}

function parseStartMode(value: string): StartMode {
  if (value === 'browser' || value === 'app') return value;
  throw new InvalidArgumentError("--mode must be 'browser' or 'app'");
}

function parseUiPort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('--ui-port must be a port number between 1 and 65535');
  }
  return port;
}

export function resolveStartConsoleLevel(env: {
  OK_CONSOLE_LEVEL?: string | undefined;
  LOG_LEVEL?: string | undefined;
}): string | null {
  if (env.OK_CONSOLE_LEVEL !== undefined || env.LOG_LEVEL !== undefined) return null;
  return 'warn';
}

export function formatShutdownNotice(signal: NodeJS.Signals): string[] {
  const lines = [
    'Stopping OpenKnowledge…',
    'Saving pending changes and releasing the server lock — this can take a few seconds.',
  ];
  if (signal === 'SIGINT') {
    lines.push('Press Ctrl+C again to force quit.');
  }
  return lines;
}

export async function runStartCommand(config: Config, opts: StartCommandOptions): Promise<void> {
  const startConsoleLevel = resolveStartConsoleLevel(process.env);
  if (startConsoleLevel !== null) process.env.OK_CONSOLE_LEVEL = startConsoleLevel;

  const { renderBanner } = await import('../ui/banner.ts');
  const { accent, dim, error, warning } = await import('../ui/colors.ts');

  const cwd = process.cwd();
  const activeConfig = config;

  process.title = deriveServerProcessTitle(cwd);

  const host = resolveHost(opts, process.env as { HOST?: string | undefined });
  const portFromCli = opts.port !== undefined ? Number(opts.port) : undefined;
  const portFromEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
  const requestedUiPort = opts.uiPort !== undefined ? Number(opts.uiPort) : undefined;
  const port = resolveCollabPort(portFromCli, portFromEnv, requestedUiPort);

  if (requestedUiPort !== undefined) {
    const { readServerLock, resolveLockDir } = await import('@inkeep/open-knowledge-server');
    const liveServer = readServerLock(resolveLockDir(cwd));
    if (shouldConnectToExistingServer(requestedUiPort, liveServer)) {
      await connectUiSibling({ cwd, uiPort: requestedUiPort });
      return;
    }
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config: activeConfig,
      cwd,
      host,
      port,
      ...(requestedUiPort !== undefined ? { uiPort: requestedUiPort } : {}),
      ...(opts.serveContentAssets ? { serveContentAssets: true } : {}),
      ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
      ...(opts.singleFile ? { singleFile: opts.singleFile } : {}),
      ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    });
  } catch (err) {
    if (err instanceof OkDirMissingError) {
      console.error(error(err.message));
      process.exit(1);
    }

    const serverModule = await import('@inkeep/open-knowledge-server');
    if (
      err instanceof serverModule.GitNotAvailableError ||
      err instanceof serverModule.GitTooOldError
    ) {
      process.exit(78);
    }

    if (
      err instanceof serverModule.SingleFileNotFoundError ||
      err instanceof serverModule.SingleFileNotAFileError ||
      err instanceof serverModule.SingleFileNotMarkdownError
    ) {
      console.error(error(err.message));
      process.exit(1);
    }

    if (requestedUiPort !== undefined && isServerLockCollision(err, serverModule)) {
      await connectUiSibling({ cwd, uiPort: requestedUiPort });
      return;
    }

    const tailored = tryDescribeLockCollision(err, cwd, serverModule);
    if (tailored !== null) {
      console.error(error(tailored));
      process.exit(1);
    }

    console.error(
      `${error('Failed to start:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const [headline, ...details] = formatShutdownNotice(signal);
    console.log(accent(`\n${headline}`));
    for (const line of details) {
      console.log(dim(`  ${line}`));
    }
    try {
      await booted.destroy();
    } catch (err) {
      console.error(
        `${error('destroy() failed:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const apiUrl = `http://${host}:${booted.port}`;
  const networkUrl =
    host === '0.0.0.0' || host === '::' ? `http://0.0.0.0:${booted.port}` : undefined;

  const uiPort = booted.resolvedUiPort;
  const localUrl = uiPort !== null && uiPort > 0 ? `http://${host}:${uiPort}` : apiUrl;

  console.log(
    renderBanner({
      name: 'open-knowledge',
      version: PACKAGE_VERSION,
      localUrl,
      apiUrl: localUrl !== apiUrl ? apiUrl : undefined,
      networkUrl,
      nextSteps: ['Open the Editor URL in your browser to start editing.'],
    }),
  );
  const DEGRADED_IMPACTS: Record<string, string> = {
    'shadow-repo': 'Version history and branch-switch safety unavailable',
    'file-watcher': 'External file changes will not sync to the editor',
    'head-watcher': 'Git branch switches may cause document inconsistency',
  };
  booted.ready
    .then(async () => {
      if (booted.degraded.length > 0) {
        console.log();
        for (const id of booted.degraded) {
          const impact = DEGRADED_IMPACTS[id] ?? `${id} (check server logs for details)`;
          console.warn(`  ${warning('\u26a0')} ${warning(id)}: ${dim(impact)}`);
        }
        console.log();
      }

      if (opts.open) {
        const { openBrowser } = await import('../utils/open-browser.ts');
        openBrowser(localUrl);
      }
    })
    .catch((err) => {
      console.error(
        `  ${error('Server initialization failed:')} ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

export function isServerLockCollision(
  err: unknown,
  serverModule: typeof import('@inkeep/open-knowledge-server'),
): boolean {
  const lockErr = serverModule.ServerLockCollisionError;
  return lockErr !== undefined && err instanceof lockErr;
}

export function tryDescribeLockCollision(
  err: unknown,
  cwd: string,
  serverModule: typeof import('@inkeep/open-knowledge-server'),
): string | null {
  const lockErr = serverModule.ServerLockCollisionError;
  if (lockErr === undefined || !(err instanceof lockErr)) return null;

  try {
    const lockDir = join(cwd, OK_DIR);
    const meta = serverModule.readServerLock(lockDir);
    if (!meta) {
      return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
    }
    if (meta.kind === 'interactive') {
      return 'OpenKnowledge desktop is currently running on this project. Quit it or use --cwd to point elsewhere.';
    }
    if (meta.kind === 'mcp-spawned') {
      return 'An MCP-spawned server holds this lock; it should release on idle-shutdown (~30 min). Or run `ok stop`.';
    }
    return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
  } catch {
    return null;
  }
}

export function startCommand(getConfig: () => Config): Command {
  const cmd = new Command('start')
    .description('Start the knowledge base collab server')
    .option('-p, --port <port>', 'Server port', undefined)
    .option(
      '--ui-port <port>',
      'Pin the ok ui sibling to <port> and connect (not exit) if a server already runs here — the worktree-preview recipe path',
      parseUiPort,
    )
    .option('-H, --host <host>', 'Server host', undefined)
    .option('--open', 'Open browser after start')
    .option('--mode <mode>', "Force dispatch mode: 'browser' or 'app'", parseStartMode)
    .option('--serve-content-assets', 'Serve content assets from this server')
    .option(
      '--react-shell-dist-dir <path>',
      'Serve React shell from <path> (suppresses ok ui sibling)',
    )
    .option(
      '--single-file <path>',
      'No-project ephemeral single-file mode: scope the server to one markdown file (git + MCP off)',
    )
    .option(
      '--project-dir <dir>',
      'Throwaway project root for --single-file (where ephemeral .ok/ state lives)',
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      if (opts.mode === 'app') {
        if (opts.open) {
          process.stderr.write(
            "error: option '--mode=app' cannot be combined with '--open' (--open opens a browser tab against the local server, which app mode does not boot)\n",
          );
          process.exit(2);
        }

        const ignored: string[] = [];
        if (opts.port !== undefined) ignored.push('--port');
        if (opts.uiPort !== undefined) ignored.push('--ui-port');
        if (opts.host !== undefined) ignored.push('--host');
        if (ignored.length > 0) {
          const logLevel = process.env.OK_LOG_LEVEL ?? 'info';
          if (logLevel === 'debug' || logLevel === 'trace') {
            console.error(`--mode=app: ignoring ${ignored.join(', ')}`);
          }
        }

        const decision = detectDesktop(createRealDetectDeps());

        if (decision.available) {
          launchDesktop({ spawn: nativeSpawn });
          return;
        }

        console.error(notFoundMessage(decision.reason));
        process.exit(1);
      }

      await runStartCommand(config, opts);
    });

  return cmd;
}
