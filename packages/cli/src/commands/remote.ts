/** Internal machine protocol used by Desktop's SSH companion. */

import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import {
  type Config,
  PinoLogger,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  readServerLock,
  resolveLockDir,
  ServerLockCollisionError,
  type ServerLockMetadata,
} from '@inkeep/open-knowledge-server';
import { parse as parseYaml } from 'yaml';
import {
  RemoteCompanionError,
  type RemoteCompanionErrorCode,
  type RemoteProjectInspection,
} from '../remote-project-bootstrap.ts';
import { type BootedStartServer, bootStartServer } from './start.ts';

/** Stable stdout framing token consumed by remote-project launchers. */
export const REMOTE_READY_PREFIX = 'OK_REMOTE_READY ';
export const REMOTE_INSPECT_PREFIX = 'OK_REMOTE_INSPECT ';
export const REMOTE_ERROR_PREFIX = 'OK_REMOTE_ERROR ';
const REMOTE_TERMINAL_CONSENT_PREFIX = 'OK_REMOTE_TERMINAL_CONSENT ';

/** Version of the readiness-record JSON shape (independent of server protocol). */
const REMOTE_READY_VERSION = 1 as const;

/** Defensive cap so a malformed environment cannot produce an unbounded frame. */
export const MAX_REMOTE_READY_LINE_BYTES = 16 * 1024;

export type RemoteCompanionCommand =
  | { readonly name: 'inspect' }
  | { readonly name: 'serve'; readonly initialize: false; readonly waitForOwnerExit: boolean }
  | {
      readonly name: 'serve';
      readonly initialize: true;
      readonly expectedPath: string;
      readonly waitForOwnerExit: false;
    }
  | { readonly name: 'terminal-consent' };

export interface RemoteReadyPayload {
  v: typeof REMOTE_READY_VERSION;
  nonce: string;
  port: number;
  projectPath: string;
  platform: NodeJS.Platform;
  pathSeparator: string;
  protocolVersion: number;
  runtimeVersion: string;
  capabilities: ['http', 'ws'];
  owned: true;
}

interface RemoteBootOptions {
  config: Config;
  cwd: string;
  resolvedContentDir: string;
  host: '127.0.0.1';
  port: number;
  skipUiAutoSpawn: true;
  serveContentAssets: true;
  watcherBackend: 'chokidar';
  log: PinoLogger;
}

interface RemoteBootHandle extends Pick<BootedStartServer, 'port' | 'ready' | 'destroy'> {}

type SignalListener = () => void | Promise<void>;
type StdinLifecycleEvent = 'end' | 'close';
type StdinLifecycleListener = () => void | Promise<void>;

type RemoteServeShutdownReason = NodeJS.Signals | 'stdin' | 'startup-error';

export interface RemoteServeDeps {
  boot(options: RemoteBootOptions): Promise<RemoteBootHandle>;
  readLock(lockDir: string): ServerLockMetadata | null;
  waitForLockRelease(lockDir: string): Promise<boolean>;
  lockDir(projectDir: string): string;
  canonicalize(path: string): string;
  writeStdout(value: string): void;
  onceSignal(signal: NodeJS.Signals, listener: SignalListener): void;
  offSignal(signal: NodeJS.Signals, listener: SignalListener): void;
  watchStdinForDisconnect: boolean;
  onceStdin(event: StdinLifecycleEvent, listener: StdinLifecycleListener): void;
  offStdin(event: StdinLifecycleEvent, listener: StdinLifecycleListener): void;
  resumeStdin(): void;
  pauseStdin(): void;
  setExitCode(code: number): void;
  platform: NodeJS.Platform;
  pathSeparator: string;
  protocolVersion: number;
  runtimeVersion: string;
}

export interface RunRemoteServeOptions {
  config: Config;
  cwd: string;
  resolvedContentDir: string;
  nonce: string;
  waitForOwnerExit?: boolean;
  port?: number;
  deps?: Partial<RemoteServeDeps>;
}

/** Machine frame shared by the full CLI and Desktop's bundled companion. */
export function formatRemoteTerminalConsentLine(nonce: string, allowed: boolean): string {
  return formatRemoteFrame(REMOTE_TERMINAL_CONSENT_PREFIX, { v: 1, nonce, allowed });
}

export function formatRemoteInspectLine(
  nonce: string,
  inspection: RemoteProjectInspection,
): string {
  return formatRemoteFrame(REMOTE_INSPECT_PREFIX, { ...inspection, nonce });
}

export function formatRemoteErrorLine(nonce: string, code: RemoteCompanionErrorCode): string {
  return formatRemoteFrame(REMOTE_ERROR_PREFIX, { v: 1, nonce, code });
}

export function parseRemoteCompanionNonce(args: readonly string[]): string {
  const nonce = args[1];
  if (args[0] !== '--nonce' || nonce === undefined || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new RemoteCompanionError('startup-failed', 'Invalid remote companion nonce.');
  }
  return nonce;
}

export function parseRemoteCompanionCommand(args: readonly string[]): RemoteCompanionCommand {
  if (args.length === 1 && args[0] === 'inspect') return { name: 'inspect' };
  if (args.length === 1 && args[0] === 'terminal-consent') return { name: 'terminal-consent' };
  if (args.length === 1 && args[0] === 'serve') {
    return { name: 'serve', initialize: false, waitForOwnerExit: false };
  }
  if (args.length === 2 && args[0] === 'serve' && args[1] === '--wait-for-owner-exit') {
    return { name: 'serve', initialize: false, waitForOwnerExit: true };
  }
  if (
    args.length === 4 &&
    args[0] === 'serve' &&
    args[1] === '--initialize' &&
    args[2] === '--expected-path'
  ) {
    return {
      name: 'serve',
      initialize: true,
      expectedPath: decodeRemoteExpectedPath(args[3] ?? ''),
      waitForOwnerExit: false,
    };
  }
  throw new RemoteCompanionError('startup-failed', 'Invalid remote companion command.');
}

function decodeRemoteExpectedPath(encoded: string): string {
  if (encoded.length === 0 || encoded.length > MAX_REMOTE_READY_LINE_BYTES) {
    throw new RemoteCompanionError('project-initialize-failed', 'Invalid expected project path.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new RemoteCompanionError('project-initialize-failed', 'Invalid expected project path.');
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (decoded.includes('\0') || Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw new RemoteCompanionError('project-initialize-failed', 'Invalid expected project path.');
  }
  return decoded;
}

export interface RemoteServeResult {
  owned: true;
  port: number;
  shutdown: (reason: RemoteServeShutdownReason) => Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Main-process terminal backstop for SSH projects. A missing local override
 * permits the terminal; an unreadable or malformed override fails loudly.
 */
export function readRemoteTerminalConsent(projectDir: string): boolean {
  const configPath = resolveConfigPath('project-local', projectDir);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    if (isObject(cause) && cause.code === 'ENOENT') return true;
    throw new RemoteCompanionError('config-invalid', 'Terminal configuration is invalid.', {
      cause,
    });
  }
  if (parsed === null || parsed === undefined) return true;
  if (!isObject(parsed)) {
    throw new RemoteCompanionError('config-invalid', 'Terminal configuration is invalid.');
  }
  if (parsed.terminal === undefined) return true;
  if (!isObject(parsed.terminal)) {
    throw new RemoteCompanionError('config-invalid', 'Terminal configuration is invalid.');
  }
  if (parsed.terminal.enabled === undefined) return true;
  if (typeof parsed.terminal.enabled !== 'boolean') {
    throw new RemoteCompanionError('config-invalid', 'Terminal configuration is invalid.');
  }
  return parsed.terminal.enabled;
}

/** Wait through the server's persistence debounce when an opt-out is lifted. */
export async function waitForRemoteTerminalConsent(
  projectDir: string,
  {
    timeoutMs = 3_000,
    intervalMs = 50,
    read = readRemoteTerminalConsent,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    read?: (projectDir: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (read(projectDir)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Whether a remote helper should use stdin as its SSH-session lifetime token.
 * Interactive invocations keep normal signal-based foreground semantics.
 */
export function shouldWatchRemoteStdin(
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY: boolean | undefined = process.stdin.isTTY,
): boolean {
  const isSshSession = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  return isSshSession && stdinIsTTY !== true;
}

function defaultDeps(): RemoteServeDeps {
  return {
    boot: (options) => bootStartServer(options),
    readLock: readServerLock,
    waitForLockRelease: async (lockDir) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (readServerLock(lockDir) === null) return true;
      }
      return false;
    },
    lockDir: resolveLockDir,
    canonicalize: (path) => realpathSync.native(path),
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    onceSignal: (signal, listener) => {
      process.once(signal, listener);
    },
    offSignal: (signal, listener) => {
      process.off(signal, listener);
    },
    watchStdinForDisconnect: shouldWatchRemoteStdin(),
    onceStdin: (event, listener) => {
      process.stdin.once(event, listener);
    },
    offStdin: (event, listener) => {
      process.stdin.off(event, listener);
    },
    resumeStdin: () => {
      process.stdin.resume();
    },
    pauseStdin: () => {
      process.stdin.pause();
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    platform: process.platform,
    pathSeparator: sep,
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
  };
}

function formatRemoteFrame(prefix: string, payload: unknown): string {
  const line = `${prefix}${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_REMOTE_READY_LINE_BYTES) {
    throw new RemoteCompanionError('startup-failed', 'Remote companion frame is too large.');
  }
  return line;
}

/** Serialize one newline-delimited, size-bounded machine frame. */
export function formatRemoteReadyLine(payload: RemoteReadyPayload): string {
  return formatRemoteFrame(REMOTE_READY_PREFIX, payload);
}

function readyPayload(
  deps: RemoteServeDeps,
  nonce: string,
  projectPath: string,
  port: number,
): RemoteReadyPayload {
  return {
    v: REMOTE_READY_VERSION,
    nonce,
    port,
    projectPath,
    platform: deps.platform,
    pathSeparator: deps.pathSeparator,
    protocolVersion: deps.protocolVersion,
    runtimeVersion: deps.runtimeVersion,
    capabilities: ['http', 'ws'],
    owned: true,
  };
}

/**
 * Start the project server and emit exactly one readiness frame. The server
 * remains foreground-owned by this process so the SSH session is its lifetime
 * token.
 */
export async function runRemoteServe(options: RunRemoteServeOptions): Promise<RemoteServeResult> {
  const deps: RemoteServeDeps = { ...defaultDeps(), ...options.deps };
  const projectPath = deps.canonicalize(options.cwd);
  const lockDir = deps.lockDir(projectPath);
  const requestedPort = options.port ?? 0;

  const existing = deps.readLock(lockDir);
  if (existing !== null) {
    if (!options.waitForOwnerExit || !(await deps.waitForLockRelease(lockDir))) {
      throw new RemoteCompanionError(
        'startup-failed',
        options.waitForOwnerExit
          ? 'The previous OpenKnowledge server did not exit in time.'
          : 'Another OpenKnowledge server already owns this project.',
      );
    }
  }

  let booted: RemoteBootHandle;
  try {
    booted = await deps.boot({
      config: options.config,
      cwd: projectPath,
      resolvedContentDir: options.resolvedContentDir,
      host: '127.0.0.1',
      port: requestedPort,
      skipUiAutoSpawn: true,
      serveContentAssets: true,
      watcherBackend: 'chokidar',
      // stdout is a machine-protocol channel for this command. Keep server
      // diagnostics silent there; the entry point maps failures to a bounded
      // code-only error frame.
      log: new PinoLogger('remote-serve', { options: { level: 'silent' } }),
    });
  } catch (err) {
    if (err instanceof ServerLockCollisionError) {
      throw new RemoteCompanionError(
        'startup-failed',
        'Another OpenKnowledge server won the project lock race.',
        { cause: err },
      );
    }
    throw err;
  }

  try {
    await booted.ready;
  } catch (startupError) {
    try {
      await booted.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Remote server startup and cleanup both failed.',
      );
    }
    throw startupError;
  }

  let shutdownPromise: Promise<void> | null = null;
  const onSigint: SignalListener = () => shutdown('SIGINT');
  const onSigterm: SignalListener = () => shutdown('SIGTERM');
  const onStdinEnd: StdinLifecycleListener = () => shutdown('stdin');
  const onStdinClose: StdinLifecycleListener = () => shutdown('stdin');
  let signalHandlersAttached = false;
  let stdinHandlersAttached = false;
  const removeLifecycleHandlers = () => {
    if (signalHandlersAttached) {
      signalHandlersAttached = false;
      deps.offSignal('SIGINT', onSigint);
      deps.offSignal('SIGTERM', onSigterm);
    }
    if (stdinHandlersAttached) {
      stdinHandlersAttached = false;
      deps.offStdin('end', onStdinEnd);
      deps.offStdin('close', onStdinClose);
      deps.pauseStdin();
    }
  };
  const shutdown = (_reason: RemoteServeShutdownReason): Promise<void> => {
    shutdownPromise ??= booted
      .destroy()
      .catch(() => {
        deps.setExitCode(1);
        deps.writeStdout(formatRemoteErrorLine(options.nonce, 'startup-failed'));
      })
      .finally(removeLifecycleHandlers);
    return shutdownPromise;
  };

  const payload = readyPayload(deps, options.nonce, projectPath, booted.port);
  try {
    signalHandlersAttached = true;
    deps.onceSignal('SIGINT', onSigint);
    deps.onceSignal('SIGTERM', onSigterm);
    if (deps.watchStdinForDisconnect) {
      stdinHandlersAttached = true;
      deps.onceStdin('end', onStdinEnd);
      deps.onceStdin('close', onStdinClose);
      // A non-TTY stdin is paused by default. Flowing it is required for an
      // SSH channel EOF to surface as `end`; `close` covers abrupt teardown.
      deps.resumeStdin();
    }
    deps.writeStdout(formatRemoteReadyLine(payload));
  } catch (err) {
    await shutdown('startup-error');
    throw err;
  }

  return { owned: true, port: booted.port, shutdown };
}
