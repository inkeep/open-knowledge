import { spawn as nativeSpawn } from 'node:child_process';
import { existsSync as fsExistsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve as pathResolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  DEFAULT_SERVER_HOST,
  type EnvConfigLayer,
  EnvVarError,
  IDLE_SHUTDOWN_DURATION_RE,
  idleShutdownToMs,
  OK_DIR,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import {
  type BootedServer,
  type Config,
  EPHEMERAL_PROJECT_DIR_PREFIX,
  isProjectRoot,
  lockAdvertisesUi,
  type PinoLogger,
  prepareSingleFileOpen,
  type ServerExitReason,
} from '@inkeep/open-knowledge-server';
import { Command, InvalidArgumentError, Option } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh, detectGhAccounts } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { PACKAGE_VERSION } from '../constants.ts';
import { getNativeTomlMcpEditor } from '../native/toml-config-engine.ts';
import { probeOwnManagedEditorMcpEntry } from './acp-harness-probe.ts';
import {
  createRealDetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';
import { ensurePiBridge, probePiBridgeState } from './pi-acp-bridge.ts';

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export function resolveHost(
  opts: { bind?: string[] },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.bind?.[0] ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

export type OnlyModule = 'server';

export function parseOnlyModule(value: string): OnlyModule {
  if (value === 'server') return value;
  throw new InvalidArgumentError("--only must be 'server'");
}

export function resolveBundledReactShellDir(
  existsFn: (path: string) => boolean = fsExistsSync,
): string | undefined {
  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  return [
    pathResolve(cliDir, 'public'),
    pathResolve(cliDir, '../../app/dist'),
    pathResolve(cliDir, '../../../app/dist'),
  ].find((p) => existsFn(p));
}

export function resolveStartShellDir(input: {
  explicitDir: string | undefined;
  only: OnlyModule | undefined;
  findBundledDir: () => string | undefined;
}): { dir: string | undefined; missingBundle: boolean } {
  if (input.explicitDir !== undefined) return { dir: input.explicitDir, missingBundle: false };
  if (input.only === 'server') return { dir: undefined, missingBundle: false };
  const dir = input.findBundledDir();
  return { dir, missingBundle: dir === undefined };
}

export function parseIdleShutdownFlag(value: string): string {
  if (value === 'off') return 'off';
  if (!IDLE_SHUTDOWN_DURATION_RE.test(value)) {
    throw new InvalidArgumentError("--idle-shutdown must be 'off' or a duration like 90s, 30m, 2h");
  }
  return value;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

export function shouldWarnHostOverridesMultiBind(input: {
  flagBindSet: boolean;
  okBindSet: boolean;
  hostEnvSet: boolean;
  fileBindCount: number;
}): boolean {
  return !input.flagBindSet && !input.okBindSet && input.hostEnvSet && input.fileBindCount > 1;
}

export function shouldOpenBrowser(input: {
  openBrowser: boolean;
  explicitOn: boolean;
  host: string;
  isTTY: boolean;
  ephemeral: boolean;
  only: OnlyModule | undefined;
  servesUi: boolean;
}): boolean {
  if (!input.openBrowser) return false;
  if (input.ephemeral || input.only === 'server') return false;
  if (!input.servesUi) return false;
  return (input.explicitOn || isLoopbackHost(input.host)) && input.isTTY;
}

function parseHttpOriginFlag(flagName: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`${flagName} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError(`${flagName} must be an http(s) origin (got: ${value})`);
  }
  return value;
}

export function parseExternalUrlFlag(value: string): string {
  return parseHttpOriginFlag('--external-url', value);
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

export class EphemeralProjectDirNotThrowawayError extends Error {
  readonly projectDir: string;
  constructor(projectDir: string) {
    super(
      `--project-dir must be a throwaway ${EPHEMERAL_PROJECT_DIR_PREFIX}* directory under the OS temp dir. ` +
        `Refusing to write ephemeral session state into ${projectDir}. ` +
        'Omit --project-dir to let ok start create (and clean up) its own.',
    );
    this.name = 'EphemeralProjectDirNotThrowawayError';
    this.projectDir = projectDir;
  }
}

export function isReapableEphemeralProjectDir(
  dir: string,
  deps: { tmpdirFn?: () => string; realpathFn?: (path: string) => string } = {},
): boolean {
  const tmpdirFn = deps.tmpdirFn ?? tmpdir;
  const realpathFn = deps.realpathFn ?? realpathSync;
  const canonical = (path: string): string | null => {
    try {
      return realpathFn(path);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? pathResolve(path) : null;
    }
  };
  const literal = pathResolve(dir);
  let target: string | null;
  try {
    target = realpathFn(literal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = canonical(dirname(literal));
      target = parent === null ? null : pathResolve(parent, basename(literal));
    } else {
      target = null;
    }
  }
  if (target === null) return false;
  const tmpRoot = canonical(tmpdirFn());
  if (tmpRoot === null) return false;
  return dirname(target) === tmpRoot && basename(target).startsWith(EPHEMERAL_PROJECT_DIR_PREFIX);
}

export function withEphemeralTempDirReap(
  handler: () => Promise<void>,
  projectDir: string,
  rmFn: (dir: string) => Promise<void> = (dir) => rm(dir, { recursive: true, force: true }),
): () => Promise<void> {
  return async () => {
    try {
      await handler();
    } finally {
      if (isReapableEphemeralProjectDir(projectDir)) {
        try {
          await rmFn(projectDir);
        } catch (err) {
          process.stderr.write(
            `[start] ephemeral temp dir reap failed for ${projectDir}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        process.stderr.write(
          `[start] leaving ${projectDir} in place: only ${EPHEMERAL_PROJECT_DIR_PREFIX}* dirs under the OS temp dir are removed on ephemeral teardown\n`,
        );
      }
    }
  };
}

export function withIdleShutdownProcessExit(
  handler: () => Promise<void>,
  deps: {
    log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
    exit?: (code: number) => void;
    getActiveHandles?: () => unknown[] | null;
  } = {},
): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const getActiveHandles =
    deps.getActiveHandles ??
    (() => {
      const probe = (process as unknown as { _getActiveHandles?: () => unknown[] })
        ._getActiveHandles;
      return probe ? probe.call(process) : null;
    });
  return async () => {
    let failed = false;
    try {
      await handler();
    } catch (err) {
      failed = true;
      deps.log?.error({ err }, 'idle-shutdown: destroy failed — exiting anyway');
    } finally {
      let handleSummary: Record<string, number> | null = null;
      try {
        const handles = getActiveHandles();
        if (handles !== null) {
          handleSummary = {};
          for (const handle of handles) {
            const name =
              (handle as { constructor?: { name?: string } } | null)?.constructor?.name ??
              'unknown';
            handleSummary[name] = (handleSummary[name] ?? 0) + 1;
          }
        }
      } catch {
        handleSummary = null;
      }
      deps.log?.info(
        {
          event: 'idle-shutdown-exit',
          exitCode: failed ? 1 : 0,
          openHandles: handleSummary ?? {},
          handlesAvailable: handleSummary !== null,
        },
        'idle-shutdown: teardown finished — exiting process',
      );
      exit(failed ? 1 : 0);
    }
  };
}

interface BootStartServerOptions {
  config: Config;
  cwd: string;
  host: string;
  port?: number;
  skipAutoInit?: boolean;
  idleThresholdMs?: number | null;
  serverRuntime?: ServerRuntimeConfig;
  bind?: readonly string[];
  idleExit?: (code: number) => void;
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
  destroy: (reason?: ServerExitReason) => Promise<void>;
  lockDir: string;
  contentDir: string;
  port: number;
  ready: Promise<void>;
  degraded: readonly string[];
}

export async function bootStartServer(opts: BootStartServerOptions): Promise<BootedStartServer> {
  const { config, cwd, host } = opts;
  const skipAutoInit = opts.skipAutoInit ?? false;
  const idleThresholdMs =
    opts.idleThresholdMs === undefined ? DEFAULT_IDLE_THRESHOLD_MS : opts.idleThresholdMs;

  const { existsSync, mkdirSync } = await import('node:fs');
  const { basename, dirname, resolve } = await import('node:path');
  const {
    bootServer,
    createEphemeralProjectDir,
    getLogger,
    resolveContentDir,
    resolveLockDir,
    seedEphemeralProjectDir,
    waitForServerLockDrain,
  } = await import('@inkeep/open-knowledge-server');

  const log = opts.log ?? getLogger('start');

  const ephemeral = opts.singleFile !== undefined;
  const ephemeralFile = ephemeral
    ? prepareSingleFileOpen(opts.singleFile as string).canonicalFilePath
    : undefined;
  const ephemeralContentDir = ephemeralFile ? dirname(ephemeralFile) : undefined;
  const ephemeralDocRelPath = ephemeralFile ? basename(ephemeralFile) : undefined;

  let ephemeralProjectDir: string | undefined;
  let ownsEphemeralProjectDir = false;
  if (ephemeralContentDir !== undefined) {
    if (opts.projectDir !== undefined) {
      ephemeralProjectDir = opts.projectDir;
      if (!isReapableEphemeralProjectDir(ephemeralProjectDir)) {
        throw new EphemeralProjectDirNotThrowawayError(ephemeralProjectDir);
      }
      if (!existsSync(resolve(ephemeralProjectDir, OK_DIR, 'config.yml'))) {
        seedEphemeralProjectDir(ephemeralProjectDir, ephemeralContentDir);
      }
    } else {
      ephemeralProjectDir = createEphemeralProjectDir(ephemeralContentDir);
      ownsEphemeralProjectDir = true;
    }
  }
  const reapOwnedEphemeralDir = async (): Promise<void> => {
    if (!ownsEphemeralProjectDir || ephemeralProjectDir === undefined) return;
    if (!isReapableEphemeralProjectDir(ephemeralProjectDir)) {
      log.warn(
        { ephemeralProjectDir },
        '[start] refusing to reap self-provisioned ephemeral dir: no longer resolves to an ok-ephemeral-* temp dir',
      );
      return;
    }
    try {
      await rm(ephemeralProjectDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err, ephemeralProjectDir },
        '[start] failed to reap self-provisioned ephemeral temp dir',
      );
    }
  };
  const reapDirOnIdle = ephemeralProjectDir;

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

  const tokenStore = makeLazyProbeTokenStore();
  const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

  let booted: BootedServer;
  try {
    {
      const drainLockDir = resolveLockDir(ephemeralProjectDir ?? cwd);
      const drainWaitStartedAt = Date.now();
      const drainOutcome = await waitForServerLockDrain(drainLockDir);
      if (drainOutcome !== 'no-drain') {
        log.info(
          {
            event: 'start-waited-for-draining-predecessor',
            outcome: drainOutcome,
            waitedMs: Date.now() - drainWaitStartedAt,
            drainLockDir,
          },
          drainOutcome === 'released'
            ? '[start] predecessor server finished draining — proceeding'
            : '[start] predecessor server still draining after wait — proceeding to collide',
        );
      }
    }

    booted = await bootServer({
      config,
      contentDir,
      projectDir: ephemeralProjectDir ?? cwd,
      contentRoot: ephemeral ? undefined : config.content.dir,
      port: opts.port,
      host,
      quiet: false,
      detectGh,
      detectGhAccounts,
      tokenStore,
      embeddingsKeyStore,
      mcpTomlEditor: getNativeTomlMcpEditor(),
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
      probeHarnessManagedMcpEntry: (editorId, agentCwd) =>
        probeOwnManagedEditorMcpEntry(editorId, agentCwd),
      probePiAcpBridge: (agentCwd) => probePiBridgeState(agentCwd),
      ensurePiAcpBridge: (agentCwd) => ensurePiBridge(agentCwd),
      idleShutdownMs: idleThresholdMs,
      ...(opts.serverRuntime !== undefined ? { serverRuntime: opts.serverRuntime } : {}),
      ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
      skipAutoInit: true,
      idleShutdownHandler: (destroyServer) => {
        const handler = destroyServer;
        const reaped =
          reapDirOnIdle !== undefined ? withEphemeralTempDirReap(handler, reapDirOnIdle) : handler;
        return withIdleShutdownProcessExit(reaped, { log, exit: opts.idleExit });
      },
      log,
      ...(opts.serveContentAssets !== undefined
        ? { serveContentAssets: opts.serveContentAssets }
        : {}),
      ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
    });
  } catch (err) {
    await reapOwnedEphemeralDir();
    throw err;
  }

  const innerDestroy = booted.destroy;
  const destroy = ownsEphemeralProjectDir
    ? async (): Promise<void> => {
        try {
          await innerDestroy();
        } finally {
          await reapOwnedEphemeralDir();
        }
      }
    : innerDestroy;

  return {
    httpServer: booted.httpServer,
    destroy,
    lockDir: booted.lockDir,
    contentDir,
    port: booted.port,
    ready: booted.ready,
    degraded: booted.degraded,
  };
}

type StartMode = 'browser' | 'app';

interface StartCommandOptions {
  port?: string | number;
  bind?: string[];
  openBrowser?: boolean;
  only?: OnlyModule;
  idleShutdown?: string;
  mode?: StartMode;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
  singleFile?: string;
  projectDir?: string;
  externalUrl?: string;
}

export function resolveStartConfig(
  config: Config,
  singleFile: string | undefined,
  readUserConfig: () => Config = () =>
    readConfigSafely({
      absPath: resolveConfigPath('user', process.cwd()),
      sideline: false,
      warn: () => {},
    }).value,
): Config {
  return singleFile !== undefined ? readUserConfig() : config;
}

function parseStartMode(value: string): StartMode {
  if (value === 'browser' || value === 'app') return value;
  throw new InvalidArgumentError("--mode must be 'browser' or 'app'");
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

export async function runStartCommand(configArg: Config, opts: StartCommandOptions): Promise<void> {
  const config = resolveStartConfig(configArg, opts.singleFile);
  const startConsoleLevel = resolveStartConsoleLevel(process.env);
  if (startConsoleLevel !== null) process.env.OK_CONSOLE_LEVEL = startConsoleLevel;

  const { renderBanner } = await import('../ui/banner.ts');
  const { accent, dim, error, warning } = await import('../ui/colors.ts');

  const cwd = process.cwd();

  process.title = deriveServerProcessTitle(cwd);

  let envLayer: EnvConfigLayer;
  try {
    envLayer = resolveEnvConfigLayer(process.env);
  } catch (err) {
    if (err instanceof EnvVarError) {
      console.error(error(err.message));
      process.exit(78);
    }
    throw err;
  }
  for (const diag of envLayer.diagnostics) {
    console.warn(warning(`[config] ${diag.message}`));
  }
  const envConfig = applyConfigOverlay(config, envLayer.layer) as Config;

  const okBindSet = envLayer.overrides.some((o) => o.envVar === 'OK_BIND');
  const flagBind = opts.bind !== undefined && opts.bind.length > 0 ? opts.bind : undefined;
  const hostEnvRaw = process.env.HOST;
  const hostEnv = hostEnvRaw !== undefined && hostEnvRaw.trim() !== '' ? hostEnvRaw : undefined;
  const envFileRuntime = resolveServerRuntimeConfig(envConfig);
  const requestedBind =
    flagBind ?? (okBindSet || hostEnv === undefined ? [...envFileRuntime.bind] : [hostEnv]);

  if (
    shouldWarnHostOverridesMultiBind({
      flagBindSet: flagBind !== undefined,
      okBindSet,
      hostEnvSet: hostEnv !== undefined,
      fileBindCount: envFileRuntime.bind.length,
    })
  ) {
    console.warn(
      warning(
        `[config] HOST=${hostEnv} overrides server.bind — dropping the file-configured addresses (${envFileRuntime.bind.join(', ')}). Use OK_BIND with a space-separated list to keep multiple binds.`,
      ),
    );
  }

  const host = requestedBind[0] ?? DEFAULT_SERVER_HOST;
  const bindList = requestedBind;
  const flagExternalUrl = opts.externalUrl;
  const runtime: ServerRuntimeConfig = resolveServerRuntimeConfig(
    applyConfigOverlay(envConfig, {
      server: {
        bind: bindList,
        ...(flagExternalUrl !== undefined ? { externalUrl: flagExternalUrl } : {}),
      },
    }) as Config,
  );

  if (runtime.allowExternal && (!runtime.loopbackOnly || runtime.externalUrl)) {
    const reach = runtime.externalUrl ?? runtime.bind.join(', ');
    console.warn(
      warning(
        [
          '',
          '⚠  EXTERNAL ACCESS ENABLED (server.allowExternal) — no server-side authentication.',
          `   This server is reachable beyond this machine (${reach}). Anyone who can`,
          '   reach it has FULL control of this knowledge base — sync, publishing, GitHub',
          '   credentials, and local operations (clone, sign-in, repo spawn).',
          '   Restrict who can reach it at the edge: a Tailscale ACL, a reverse proxy with',
          '   auth (Cloudflare Access, oauth2-proxy), or a firewall.',
          '',
        ].join('\n'),
      ),
    );
  }

  const portFromCli = opts.port !== undefined ? Number(opts.port) : undefined;
  const portFromEnv = envLayer.overrides.find((o) => o.envVar === 'PORT')?.value as
    | number
    | undefined;
  const port = portFromCli ?? portFromEnv ?? config.server?.port;

  const shell = resolveStartShellDir({
    explicitDir: opts.reactShellDistDir,
    only: opts.only,
    findBundledDir: resolveBundledReactShellDir,
  });
  const reactShellDistDir = shell.dir;
  if (shell.missingBundle) {
    console.warn(
      'bundled web UI not found — serving /api and /mcp only. Reinstall @inkeep/open-knowledge, or build packages/app in a source checkout.',
    );
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config,
      cwd,
      host,
      port,
      bind: bindList,
      ...(opts.serveContentAssets !== undefined
        ? { serveContentAssets: opts.serveContentAssets }
        : {}),
      ...(reactShellDistDir ? { reactShellDistDir } : {}),
      idleThresholdMs: idleShutdownToMs(opts.idleShutdown ?? runtime.idleShutdown),
      serverRuntime: runtime,
      ...(opts.singleFile ? { singleFile: opts.singleFile } : {}),
      ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    });
  } catch (err) {
    if (err instanceof OkDirMissingError) {
      console.error(error(err.message));
      process.exit(1);
    }

    if (err instanceof EphemeralProjectDirNotThrowawayError) {
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

    if (err instanceof serverModule.ExposureConsentError) {
      console.error(error(err.message));
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

    if (err instanceof serverModule.MissingOkConfigError) {
      console.error(error(err.message));
      process.exit(1);
    }

    if (isServerLockCollision(err, serverModule)) {
      const lockDir = serverModule.resolveLockDir(cwd);
      let reuse: ServerReuseInfo | null = null;
      try {
        reuse = await resolveServerReuse({
          readServerLock: () => serverModule.readServerLock(lockDir),
          now: Date.now,
          sleep: (ms) => wait(ms),
          timeoutMs: 3000,
          pollIntervalMs: 50,
        });
      } catch (reuseErr) {
        process.stderr.write(
          `[start] spawn-or-reuse: lock poll failed (${reuseErr instanceof Error ? reuseErr.message : String(reuseErr)}) — falling back to the collision message\n`,
        );
      }
      if (reuse !== null) {
        const [headline, ...rest] = formatServerReuseNotice(reuse);
        console.log(accent(headline));
        for (const line of rest) {
          console.log(dim(line));
        }
        process.exit(0);
      }
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
      await booted.destroy('external-signal');
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

  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const apiUrl = `http://${urlHost}:${booted.port}`;
  const networkUrl =
    host === '0.0.0.0' || host === '::' ? `http://0.0.0.0:${booted.port}` : undefined;

  const localUrl = apiUrl;

  console.log(
    renderBanner({
      name: 'open-knowledge',
      version: PACKAGE_VERSION,
      localUrl,
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

      const openDecision = shouldOpenBrowser({
        openBrowser: opts.openBrowser !== false && runtime.openBrowser,
        explicitOn: opts.openBrowser !== false && envConfig.server?.openBrowser === true,
        host,
        isTTY: process.stdout.isTTY === true,
        ephemeral: opts.singleFile !== undefined,
        only: opts.only,
        servesUi: reactShellDistDir !== undefined,
      });
      if (openDecision) {
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

export interface ServerReuseInfo {
  url: string;
  kind?: string | undefined;
  pid: number;
  servesUi: boolean;
}

interface ResolveServerReuseDeps {
  readServerLock: () => {
    pid: number;
    port: number;
    url?: string;
    kind?: string;
    draining?: boolean;
    capabilities?: string[];
  } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Spawn-or-reuse resolution: a second `ok start` that lost the server.lock
 * acquisition reads the live holder's advertisement and reports it instead of
 * failing. Returns the holder's browser-facing URL, or `null` when the lock
 * can't be resolved to a usable address (caller falls back to the error path).
 *
 * Polls through the pre-listen window (`port: 0` sentinel) so racing a
 * predecessor that is still binding reports its real address rather than
 * failing on the sentinel. URL preference order:
 *
 * 1. lock v2 `url` when the holder advertises the `ui` capability — the
 *    canonical one-URL contract (the same record Desktop attaches through);
 * 2. the server's own `url`/port — API+MCP only (a `--only server` boot), but
 *    still the right address.
 *
 * All time + IO deps injected (precedent #13b) so tests drive every branch
 * with a virtual clock and no filesystem.
 */
export async function resolveServerReuse(
  deps: ResolveServerReuseDeps,
): Promise<ServerReuseInfo | null> {
  const deadline = deps.now() + deps.timeoutMs;
  let lock = deps.readServerLock();
  while (lock !== null && lock.draining !== true && lock.port <= 0 && deps.now() < deadline) {
    await deps.sleep(deps.pollIntervalMs);
    lock = deps.readServerLock();
  }
  if (lock === null || lock.draining === true || lock.port <= 0) return null;
  if (lockAdvertisesUi(lock) && lock.url !== undefined) {
    return { url: lock.url, kind: lock.kind, pid: lock.pid, servesUi: true };
  }
  return {
    url: lock.url ?? `http://${DEFAULT_SERVER_HOST}:${lock.port}`,
    kind: lock.kind,
    pid: lock.pid,
    servesUi: false,
  };
}

export function formatServerReuseNotice(info: ServerReuseInfo): string[] {
  const holder =
    info.kind === 'mcp-spawned'
      ? 'An MCP-spawned OpenKnowledge server is already running on this project'
      : 'OpenKnowledge is already running on this project';
  return [
    `${holder} (pid ${info.pid}).`,
    `  ${info.url}`,
    'Leaving it running — run `ok stop` first if you want a fresh server.',
  ];
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
    const meta = serverModule.readServerLock(serverModule.resolveLockDir(cwd));
    if (!meta) {
      return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
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
    .description('Start the OpenKnowledge server (UI + API + MCP + collab on one port)')
    .option('-p, --port <port>', 'Server port', undefined)
    .option(
      '--bind <address>',
      'Bind address (repeatable; default 127.0.0.1 — loopback only)',
      (value: string, prev: string[] | undefined) => [...(prev ?? []), value],
    )
    .option(
      '--no-open-browser',
      'Do not open the browser after start (interactive loopback starts open it by default)',
    )
    .option(
      '--only <module>',
      "Serve one module: 'server' (API + MCP only, no shell or browser)",
      parseOnlyModule,
    )
    .option(
      '--idle-shutdown <duration>',
      "Shut the server down after this long with no connected clients ('off', or a duration like 90s, 30m, 2h; default 30m)",
      parseIdleShutdownFlag,
    )
    .option('--mode <mode>', "Force dispatch mode: 'browser' or 'app'", parseStartMode)
    .option(
      '--serve-content-assets',
      'Serve content assets from this server (now the default; kept for compatibility)',
    )
    .option('--react-shell-dist-dir <path>', 'Serve React shell from <path>')
    .addOption(
      new Option(
        '--single-file <path>',
        'No-project ephemeral single-file mode: scope the server to one markdown file (git + MCP off)',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--project-dir <dir>',
        'Throwaway project root for --single-file (where ephemeral .ok/ state lives)',
      ).hideHelp(),
    )
    .option(
      '--external-url <url>',
      'Canonical external origin clients dial (sets server.externalUrl for this run) — its host joins the Host/Origin allowlists (CORS + external-Host admission). External exposure additionally requires consent (OK_ALLOW_EXTERNAL=1 or server.allowExternal).',
      parseExternalUrlFlag,
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      if (opts.only === 'server' && opts.reactShellDistDir !== undefined) {
        process.stderr.write(
          "error: option '--only server' cannot be combined with '--react-shell-dist-dir'\n",
        );
        process.exit(2);
      }

      if (opts.projectDir !== undefined && opts.singleFile === undefined) {
        process.stderr.write("error: option '--project-dir' requires '--single-file'\n");
        process.exit(2);
      }

      if (opts.mode === 'app') {
        const ignored: string[] = [];
        if (opts.port !== undefined) ignored.push('--port');
        if (opts.bind !== undefined) ignored.push('--bind');
        if (opts.only !== undefined) ignored.push('--only');
        if (opts.idleShutdown !== undefined) ignored.push('--idle-shutdown');
        if (opts.openBrowser === false) ignored.push('--no-open-browser');
        if (opts.externalUrl !== undefined) ignored.push('--external-url');
        if (ignored.length > 0) {
          const logLevel = process.env.OK_LOG_LEVEL ?? 'info';
          if (logLevel === 'debug' || logLevel === 'trace') {
            console.error(`--mode=app: ignoring ${ignored.join(', ')}`);
          }
        }

        const decision = detectDesktop(createRealDetectDeps());

        if (decision.available) {
          launchDesktop({ spawn: nativeSpawn }, decision);
          return;
        }

        console.error(notFoundMessage(decision.reason));
        process.exit(1);
      }

      await runStartCommand(config, opts);
    });

  return cmd;
}
