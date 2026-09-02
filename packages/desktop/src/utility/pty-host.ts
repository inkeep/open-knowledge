import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, join, win32 } from 'node:path';
import {
  composeWindowsShellLaunchArgs,
  launchWithoutSupportFile,
  OK_DESKTOP_TERMINAL_ENV,
  resolveWindowsShellFamily,
  type TerminalLaunchCommand,
  type WindowsShellFamily,
} from '@inkeep/open-knowledge-core';
import { isTerminalShellNoticeReason } from '@inkeep/open-knowledge-core/desktop-bridge';
import type {
  TerminalShellNoticeReason,
  TerminalSupportFileNoticeReason,
} from '../shared/bridge-contract.ts';
import { interactiveShellArgs } from '../shared/terminal-shell.ts';
import { getWindowsEnvValue, windowsPathKey, windowsWherePathArgs } from '../shared/windows-env.ts';
import {
  materializeSupportFileSync,
  TERMINAL_SUPPORT_FILE_ESCAPE_CODE,
} from './support-file-write.ts';

const DARWIN_FALLBACK_SHELL = '/bin/zsh';

const STRIPPED_ENV_MARKERS = [
  'OK_ELECTRON_PROTOCOL_HOST',
  'OK_LOCK_KIND',
  'ELECTRON_RUN_AS_NODE',
] as const;

export interface PtyCreateMessage {
  type: 'create';
  ptyId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  shellInvalidReason?: TerminalShellNoticeReason;
  launchCommand?: string | TerminalLaunchCommand;
}
interface PtyInputMessage {
  type: 'input';
  ptyId: string;
  data: string;
}
interface PtyResizeMessage {
  type: 'resize';
  ptyId: string;
  cols: number;
  rows: number;
}
interface PtyKillMessage {
  type: 'kill';
  ptyId: string;
}
interface PtyPauseMessage {
  type: 'pause';
  ptyId: string;
}
interface PtyResumeMessage {
  type: 'resume';
  ptyId: string;
}
interface PtyShutdownMessage {
  type: 'shutdown';
}
export type PtyHostIncomingMessage =
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyPauseMessage
  | PtyResumeMessage
  | PtyShutdownMessage;

interface PtyDataMessage {
  type: 'data';
  ptyId: string;
  data: string;
}
interface PtyExitMessage {
  type: 'exit';
  ptyId: string;
  exitCode: number | undefined;
  signal: number | null;
}
interface PtySpawnErrorMessage {
  type: 'spawn-error';
  ptyId: string;
  message: string;
}
type PtyShellNoticeMessage =
  | {
      type: 'shell-notice';
      ptyId: string;
      notice: 'invalid-shell-override';
      reason: TerminalShellNoticeReason;
    }
  | {
      type: 'shell-notice';
      ptyId: string;
      notice: 'shell-resolved';
      shellFamily: WindowsShellFamily;
    }
  | {
      type: 'shell-notice';
      ptyId: string;
      notice: 'support-file-degraded';
      reason: TerminalSupportFileNoticeReason;
    };
export type PtyHostOutgoingMessage =
  | PtyDataMessage
  | PtyExitMessage
  | PtySpawnErrorMessage
  | PtyShellNoticeMessage;

export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | undefined; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  encoding: 'utf8';
  useConptyDll?: boolean;
}
export type SpawnPty = (
  file: string,
  args: string[] | string,
  options: PtySpawnOptions,
) => PtyProcessLike;

interface PtyHostParentPort {
  on(event: 'message', handler: (event: { data: unknown }) => void): void;
  postMessage(value: PtyHostOutgoingMessage): void;
}

export function installPtyImportFailureReply(
  parentPort: PtyHostParentPort,
  error: unknown,
  logger?: { warn(data: Record<string, unknown>, message: string): void },
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger?.warn({ event: 'pty-host-import-failed', error: message }, 'node-pty import failed');
  parentPort.on('message', (event) => {
    const msg = asIncomingMessage(event.data);
    if (msg?.type === 'create') {
      parentPort.postMessage({ type: 'spawn-error', ptyId: msg.ptyId, message });
    }
  });
}

export interface SetupPtyHostDeps {
  parentPort: PtyHostParentPort | null;
  spawn: SpawnPty;
  exitHost?: (code: number) => void;
  flushLogger?: () => void;
  shutdownMs?: number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (token: ReturnType<typeof setTimeout>) => void;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  userInfoShell?: () => string | null;
  shellExists?: (path: string) => boolean;
  pathProbe?: (command: string, env: Record<string, string | undefined>) => string | null;
  listDirectory?: (path: string) => readonly string[];
  cliBinDir?: string;
  materializeSupportFile?: (
    cwd: string,
    file: NonNullable<TerminalLaunchCommand['supportFile']>,
  ) => void;
  logger?: {
    warn: (o: Record<string, unknown>) => void;
    info?: (o: Record<string, unknown>) => void;
  };
}

function asIncomingMessage(raw: unknown): PtyHostIncomingMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string') return null;
  if (m.type === 'shutdown') return raw as PtyShutdownMessage;
  if (typeof m.ptyId !== 'string' || m.ptyId.length === 0) return null;
  switch (m.type) {
    case 'create': {
      const launch = m.launchCommand;
      const supportFile =
        typeof launch === 'object' && launch !== null
          ? (launch as Record<string, unknown>).supportFile
          : undefined;
      const supportFileValid =
        supportFile === undefined ||
        (typeof supportFile === 'object' &&
          supportFile !== null &&
          (supportFile as Record<string, unknown>).kind === 'claude-settings' &&
          typeof (supportFile as Record<string, unknown>).relativePath === 'string' &&
          /^\.ok\/local\/terminal\/claude-settings-(?:mcp|tools|mcp-tools)\.json$/u.test(
            (supportFile as Record<string, unknown>).relativePath as string,
          ) &&
          typeof (supportFile as Record<string, unknown>).contents === 'string' &&
          ((supportFile as Record<string, unknown>).contents as string).length <= 16_384 &&
          (launch as Record<string, unknown>).executable === 'claude');
      const launchValid =
        launch === undefined ||
        typeof launch === 'string' ||
        (typeof launch === 'object' &&
          launch !== null &&
          typeof (launch as Record<string, unknown>).executable === 'string' &&
          Array.isArray((launch as Record<string, unknown>).args) &&
          ((launch as Record<string, unknown>).args as unknown[]).every(
            (arg) => typeof arg === 'string',
          ) &&
          supportFileValid);
      return typeof m.cwd === 'string' &&
        typeof m.cols === 'number' &&
        typeof m.rows === 'number' &&
        (m.shell === undefined || typeof m.shell === 'string') &&
        (m.shellInvalidReason === undefined || isTerminalShellNoticeReason(m.shellInvalidReason)) &&
        launchValid
        ? (raw as PtyHostIncomingMessage)
        : null;
    }
    case 'input':
      return typeof m.data === 'string' ? (raw as PtyHostIncomingMessage) : null;
    case 'resize':
      return typeof m.cols === 'number' && typeof m.rows === 'number'
        ? (raw as PtyHostIncomingMessage)
        : null;
    case 'kill':
    case 'pause':
    case 'resume':
      return raw as PtyHostIncomingMessage;
    default:
      return null;
  }
}

export interface PtyHostHandle {
  killActive(): void;
}

export interface ResolveShellOptions {
  platform: NodeJS.Platform;
  override?: string;
  overrideInvalidReason?: TerminalShellNoticeReason;
  userInfoShell?: () => string | null;
  shellExists?: (path: string) => boolean;
  pathProbe?: (command: string, env: Record<string, string | undefined>) => string | null;
  listDirectory?: (path: string) => readonly string[];
  logger?: {
    warn: (o: Record<string, unknown>) => void;
    info?: (o: Record<string, unknown>) => void;
  };
}

export type ShellResolutionRung =
  | 'override'
  | 'pwsh-path'
  | 'pwsh-known-install'
  | 'windows-powershell'
  | 'comspec'
  | 'cmd'
  | 'env-shell'
  | 'platform-fallback'
  | 'passwd-shell'
  | 'bash'
  | 'sh';

export interface ShellResolution {
  shell: string;
  rung: ShellResolutionRung;
  invalidOverride: boolean;
  invalidOverrideReason?: TerminalShellNoticeReason;
}

const PATH_PROBE_TIMEOUT_MS = 5000;

function defaultWindowsPathProbe(
  command: string,
  env: Record<string, string | undefined>,
  logger?: ResolveShellOptions['logger'],
): string | null {
  const systemRoot = getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const whereExe = win32.join(systemRoot, 'System32', 'where.exe');
  try {
    const output = execFileSync(whereExe, windowsWherePathArgs(command), {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PATH_PROBE_TIMEOUT_MS,
    });
    return (
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => win32.isAbsolute(line) && line.toLowerCase().endsWith('.exe')) ?? null
    );
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown';
    if (code === 'ETIMEDOUT') {
      logger?.warn({
        event: 'pty-host-shell-path-probe-timed-out',
        command,
        timeoutMs: PATH_PROBE_TIMEOUT_MS,
      });
    } else {
      logger?.warn({ event: 'pty-host-shell-path-probe-failed', command, code });
    }
    return null;
  }
}

function defaultListDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isFalseStyleShell(shell: string): boolean {
  const command = basename(shell);
  return command === 'false' || command === 'nologin';
}

function isUsableShell(
  shell: string | null | undefined,
  shellExists: (path: string) => boolean,
): shell is string {
  return (
    typeof shell === 'string' && shell.length > 0 && !isFalseStyleShell(shell) && shellExists(shell)
  );
}

export function resolveShellWithDetails(
  env: Record<string, string | undefined>,
  options: ResolveShellOptions,
): ShellResolution {
  if (options.platform === 'win32') {
    const shellExists = options.shellExists ?? existsSync;
    const override = options.override?.trim();
    let invalidOverride = options.overrideInvalidReason !== undefined;
    let invalidOverrideReason = options.overrideInvalidReason;
    if (override) {
      if (win32.isAbsolute(override) && shellExists(override)) {
        const unsupportedFamily = resolveWindowsShellFamily(override) === null;
        return {
          shell: override,
          rung: 'override',
          invalidOverride: unsupportedFamily,
          invalidOverrideReason: unsupportedFamily ? 'unsupported-family' : undefined,
        };
      }
      invalidOverride = true;
      invalidOverrideReason = win32.isAbsolute(override) ? 'not-found' : 'not-absolute';
    }

    const pathShell = options.pathProbe
      ? options.pathProbe('pwsh', env)
      : defaultWindowsPathProbe('pwsh', env, options.logger);
    if (pathShell && win32.isAbsolute(pathShell) && shellExists(pathShell)) {
      return { shell: pathShell, rung: 'pwsh-path', invalidOverride, invalidOverrideReason };
    }

    const programFiles = getWindowsEnvValue(env, 'ProgramFiles');
    if (programFiles) {
      const knownPwsh = win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
      if (shellExists(knownPwsh)) {
        return {
          shell: knownPwsh,
          rung: 'pwsh-known-install',
          invalidOverride,
          invalidOverrideReason,
        };
      }
    }

    const localAppData = getWindowsEnvValue(env, 'LOCALAPPDATA');
    if (localAppData) {
      const windowsApps = win32.join(localAppData, 'Microsoft', 'WindowsApps');
      const entries = (options.listDirectory ?? defaultListDirectory)(windowsApps);
      for (const entry of entries) {
        if (!entry.toLowerCase().startsWith('microsoft.powershell_')) continue;
        const alias = win32.join(windowsApps, entry, 'pwsh.exe');
        if (shellExists(alias)) {
          return {
            shell: alias,
            rung: 'pwsh-known-install',
            invalidOverride,
            invalidOverrideReason,
          };
        }
      }
    }

    const systemRoot = getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows';
    const windowsPowerShell = win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (shellExists(windowsPowerShell)) {
      return {
        shell: windowsPowerShell,
        rung: 'windows-powershell',
        invalidOverride,
        invalidOverrideReason,
      };
    }

    const comspec = getWindowsEnvValue(env, 'ComSpec');
    if (comspec && win32.isAbsolute(comspec) && shellExists(comspec)) {
      return { shell: comspec, rung: 'comspec', invalidOverride, invalidOverrideReason };
    }

    return {
      shell: win32.join(systemRoot, 'System32', 'cmd.exe'),
      rung: 'cmd',
      invalidOverride,
      invalidOverrideReason,
    };
  }

  if (options.override && options.override.length > 0) {
    return { shell: options.override, rung: 'override', invalidOverride: false };
  }

  const configuredShell = env.SHELL;
  if (options.platform === 'darwin') {
    return typeof configuredShell === 'string' && configuredShell.length > 0
      ? { shell: configuredShell, rung: 'env-shell', invalidOverride: false }
      : { shell: DARWIN_FALLBACK_SHELL, rung: 'platform-fallback', invalidOverride: false };
  }
  if (options.platform !== 'linux') {
    return typeof configuredShell === 'string' && configuredShell.length > 0
      ? { shell: configuredShell, rung: 'env-shell', invalidOverride: false }
      : { shell: '/bin/sh', rung: 'platform-fallback', invalidOverride: false };
  }

  const shellExists = options.shellExists ?? existsSync;
  if (isUsableShell(configuredShell, shellExists)) {
    return { shell: configuredShell, rung: 'env-shell', invalidOverride: false };
  }

  let passwdShell: string | null = null;
  try {
    passwdShell = (options.userInfoShell ?? (() => userInfo().shell))();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    options.logger?.warn({
      event: 'pty-host-user-info-shell-failed',
      code: typeof code === 'string' ? code : 'unknown',
    });
    passwdShell = null;
  }
  if (isUsableShell(passwdShell, shellExists)) {
    return { shell: passwdShell, rung: 'passwd-shell', invalidOverride: false };
  }
  return shellExists('/bin/bash')
    ? { shell: '/bin/bash', rung: 'bash', invalidOverride: false }
    : { shell: '/bin/sh', rung: 'sh', invalidOverride: false };
}

export function resolveShell(
  env: Record<string, string | undefined>,
  options: ResolveShellOptions,
): string {
  return resolveShellWithDetails(env, options).shell;
}

export function buildShellArgs(
  platform: NodeJS.Platform,
  shell: string,
  launchCommand?: string | TerminalLaunchCommand,
): string[] | string {
  if (platform === 'win32') {
    return typeof launchCommand === 'object'
      ? composeWindowsShellLaunchArgs(shell, launchCommand)
      : [];
  }
  const interactiveArgs = [...interactiveShellArgs(platform)];
  if (typeof launchCommand !== 'string' || launchCommand.length === 0) return interactiveArgs;
  const quotedShell = `'${shell.replace(/'/g, "'\\''")}'`;
  return [
    ...interactiveArgs,
    '-c',
    `${launchCommand}; exec ${quotedShell} ${interactiveArgs.join(' ')}`,
  ];
}

export function buildShellEnv(
  parentEnv: Record<string, string | undefined>,
  options: { platform?: NodeJS.Platform; cliBinDir?: string } = {},
): Record<string, string> {
  const stripped = new Set<string>(STRIPPED_ENV_MARKERS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (stripped.has(key) || key.startsWith('GDK_PIXBUF_')) continue;
    out[key] = value;
  }
  const platform = options.platform ?? process.platform;
  const pathKey = windowsPathKey(out);
  if (platform === 'win32' && options.cliBinDir) {
    const entries = (out[pathKey] ?? '').split(';').filter(Boolean);
    if (!entries.some((entry) => entry.toLowerCase() === options.cliBinDir?.toLowerCase())) {
      out[pathKey] = [options.cliBinDir, ...entries].join(';');
    }
  }
  const home = out.HOME;
  if (platform !== 'win32' && home) {
    const okBin = join(home, '.ok', 'bin');
    const entries = (out[pathKey] ?? '').split(delimiter).filter(Boolean);
    if (!entries.includes(okBin)) {
      out[pathKey] = [okBin, ...entries].join(delimiter);
    }
  }
  out[OK_DESKTOP_TERMINAL_ENV] = '1';
  return out;
}

const CONPTY_DLL_LOAD_ERROR_PREFIXES = {
  'Cannot find conpty.dll': 'not-found',
  'Failed to get conpty.node module handle': 'module-handle',
  'Failed to get conpty.node module file name': 'module-file-name',
  'Failed to load conpty.dll': 'load-failed',
} as const;

function conptyDllLoadFailureReason(
  error: unknown,
): (typeof CONPTY_DLL_LOAD_ERROR_PREFIXES)[keyof typeof CONPTY_DLL_LOAD_ERROR_PREFIXES] | null {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = Object.keys(CONPTY_DLL_LOAD_ERROR_PREFIXES).find((candidate) =>
    message.startsWith(candidate),
  ) as keyof typeof CONPTY_DLL_LOAD_ERROR_PREFIXES | undefined;
  return prefix === undefined ? null : CONPTY_DLL_LOAD_ERROR_PREFIXES[prefix];
}

export function setupPtyHost(deps: SetupPtyHostDeps): PtyHostHandle {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const platform = deps.platform ?? process.platform;
  const sessions = new Map<string, PtyProcessLike>();
  const shutdownMs = deps.shutdownMs ?? 1_500;
  const setHostTimer = deps.setTimer ?? setTimeout;
  const clearHostTimer = deps.clearTimer ?? clearTimeout;
  const materializeSupportFile = deps.materializeSupportFile ?? materializeSupportFileSync;
  const cachedWindowsPaths = new Map<string, string>();

  function probeWindowsShellPath(
    command: string,
    probeEnv: Record<string, string | undefined>,
  ): string | null {
    const cached = cachedWindowsPaths.get(command);
    if (cached !== undefined) return cached;
    const resolved = deps.pathProbe
      ? deps.pathProbe(command, probeEnv)
      : defaultWindowsPathProbe(command, probeEnv, deps.logger);
    if (resolved !== null) cachedWindowsPaths.set(command, resolved);
    return resolved;
  }

  function post(message: PtyHostOutgoingMessage): void {
    deps.parentPort?.postMessage(message);
  }

  function safeKill(pty: PtyProcessLike): void {
    try {
      pty.kill();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'ESRCH') {
        deps.logger?.warn({ event: 'pty-host-reap-failed', code: code ?? 'unknown' });
      }
    }
  }

  function handleCreate(message: PtyCreateMessage): void {
    const { ptyId } = message;
    const stale = sessions.get(ptyId);
    if (stale) {
      safeKill(stale);
      sessions.delete(ptyId);
    }
    const resolution = resolveShellWithDetails(env, {
      platform,
      override: message.shell,
      overrideInvalidReason: message.shellInvalidReason,
      userInfoShell: deps.userInfoShell,
      shellExists: deps.shellExists,
      pathProbe: platform === 'win32' ? probeWindowsShellPath : deps.pathProbe,
      listDirectory: deps.listDirectory,
      logger: deps.logger,
    });
    if (resolution.invalidOverride) {
      const reason = resolution.invalidOverrideReason ?? 'invalid-value';
      deps.logger?.warn({
        event:
          reason === 'unsupported-family'
            ? 'pty-host-shell-override-capability-limited'
            : 'pty-host-shell-override-invalid',
        platform,
        reason,
      });
      post({
        type: 'shell-notice',
        ptyId,
        notice: 'invalid-shell-override',
        reason,
      });
    }
    deps.logger?.info?.({
      event: 'pty-host-shell-resolved',
      platform,
      rung: resolution.rung,
    });
    const shell = resolution.shell;
    if (platform === 'win32') {
      const shellFamily = resolveWindowsShellFamily(shell);
      if (shellFamily !== null) {
        post({ type: 'shell-notice', ptyId, notice: 'shell-resolved', shellFamily });
      }
    }
    const shellEnv = buildShellEnv(env, { platform, cliBinDir: deps.cliBinDir });
    let launchCommand = message.launchCommand;
    if (
      platform === 'win32' &&
      typeof launchCommand === 'object' &&
      resolution.invalidOverrideReason === 'unsupported-family'
    ) {
      deps.logger?.warn({
        event: 'pty-host-launch-degraded-unsupported-shell',
        platform,
        rung: resolution.rung,
      });
      launchCommand = undefined;
    }
    if (
      platform === 'win32' &&
      typeof launchCommand === 'object' &&
      launchCommand.supportFile !== undefined
    ) {
      try {
        materializeSupportFile(message.cwd, launchCommand.supportFile);
      } catch (error) {
        deps.logger?.warn({
          event: 'pty-host-support-file-materialize-failed',
          kind: launchCommand.supportFile.kind,
          code: (error as { code?: string } | null)?.code ?? 'unknown',
        });
        post({
          type: 'shell-notice',
          ptyId,
          notice: 'support-file-degraded',
          reason:
            (error as { code?: string } | null)?.code === TERMINAL_SUPPORT_FILE_ESCAPE_CODE
              ? 'containment-refused'
              : 'write-failed',
        });
        launchCommand = launchWithoutSupportFile(launchCommand);
      }
    }
    let shellArgs: string[] | string;
    try {
      shellArgs = buildShellArgs(platform, shell, launchCommand);
    } catch (error) {
      deps.logger?.warn({
        event: 'pty-host-launch-compose-failed',
        platform,
        rung: resolution.rung,
      });
      post({
        type: 'spawn-error',
        ptyId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const spawnOptions: PtySpawnOptions = {
      name: 'xterm-256color',
      cols: message.cols,
      rows: message.rows,
      cwd: message.cwd,
      env: shellEnv,
      encoding: 'utf8',
    };
    let pty: PtyProcessLike;
    try {
      pty = deps.spawn(shell, shellArgs, {
        ...spawnOptions,
        ...(platform === 'win32' ? { useConptyDll: true } : {}),
      });
    } catch (err) {
      const conptyFailureReason = platform === 'win32' ? conptyDllLoadFailureReason(err) : null;
      if (conptyFailureReason !== null) {
        deps.logger?.warn({
          event: 'pty-host-conpty-dll-fallback',
          reason: conptyFailureReason,
        });
        try {
          pty = deps.spawn(shell, shellArgs, { ...spawnOptions, useConptyDll: false });
        } catch (fallbackErr) {
          const fallbackMessage =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          post({ type: 'spawn-error', ptyId, message: fallbackMessage });
          return;
        }
      } else {
        const spawnMessage = err instanceof Error ? err.message : String(err);
        post({ type: 'spawn-error', ptyId, message: spawnMessage });
        return;
      }
    }
    sessions.set(ptyId, pty);
    pty.onData((data) => {
      if (sessions.get(ptyId) === pty) post({ type: 'data', ptyId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (sessions.get(ptyId) === pty) sessions.delete(ptyId);
      post({ type: 'exit', ptyId, exitCode, signal: signal ?? null });
      if (shuttingDown && sessions.size === 0) finishShutdown();
    });
  }

  function handleInput(message: PtyInputMessage): void {
    sessions.get(message.ptyId)?.write(message.data);
  }

  function handleResize(message: PtyResizeMessage): void {
    sessions.get(message.ptyId)?.resize(message.cols, message.rows);
  }

  function handleKill(message: PtyKillMessage): void {
    const pty = sessions.get(message.ptyId);
    if (pty) safeKill(pty);
  }

  function handlePause(message: PtyPauseMessage): void {
    sessions.get(message.ptyId)?.pause();
  }

  function handleResume(message: PtyResumeMessage): void {
    sessions.get(message.ptyId)?.resume();
  }

  function killActiveSessions(): void {
    for (const pty of sessions.values()) safeKill(pty);
    sessions.clear();
  }

  let shuttingDown = false;
  let shutdownToken: ReturnType<typeof setTimeout> | null = null;
  let hostExited = false;

  function finishShutdown(): void {
    if (hostExited) return;
    hostExited = true;
    if (shutdownToken !== null) {
      clearHostTimer(shutdownToken);
      shutdownToken = null;
    }
    sessions.clear();
    deps.flushLogger?.();
    deps.exitHost?.(0);
  }

  function handleShutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const pty of sessions.values()) safeKill(pty);
    if (sessions.size === 0) {
      finishShutdown();
      return;
    }
    shutdownToken = setHostTimer(() => {
      shutdownToken = null;
      deps.logger?.warn({ event: 'pty-host-shutdown-deadline', remaining: sessions.size });
      finishShutdown();
    }, shutdownMs);
  }

  deps.parentPort?.on('message', (event) => {
    const message = asIncomingMessage(event.data);
    if (!message) {
      deps.logger?.warn({ event: 'pty-host-unexpected-message' });
      return;
    }
    switch (message.type) {
      case 'create':
        handleCreate(message);
        break;
      case 'input':
        handleInput(message);
        break;
      case 'resize':
        handleResize(message);
        break;
      case 'kill':
        handleKill(message);
        break;
      case 'pause':
        handlePause(message);
        break;
      case 'resume':
        handleResume(message);
        break;
      case 'shutdown':
        handleShutdown();
        break;
      default:
        deps.logger?.warn({
          event: 'pty-host-unexpected-message',
          type: (message as unknown as { type: string }).type,
        });
        break;
    }
  });

  return {
    killActive(): void {
      killActiveSessions();
    },
  };
}

export interface HostReapProcess {
  on(event: 'exit', listener: () => void): void;
  on(event: NodeJS.Signals, listener: () => void): void;
  exit(code?: number): void;
}

const REAP_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

export function installHostReaping(handle: PtyHostHandle, proc: HostReapProcess): void {
  let reaped = false;
  const reap = (): void => {
    if (reaped) return;
    reaped = true;
    handle.killActive();
  };
  proc.on('exit', reap);
  for (const signal of REAP_SIGNALS) {
    proc.on(signal, () => {
      reap();
      proc.exit(0);
    });
  }
}

if ((process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  const parentPort = (process as NodeJS.Process & { parentPort: PtyHostParentPort }).parentPort;
  void (async () => {
    let log: {
      warn(data: Record<string, unknown>, message?: string): void;
      info(data: Record<string, unknown>, message?: string): void;
    } = {
      warn: (data, message) => console.warn(message ?? '[pty-host] warning', data),
      info: (data, message) => console.info(message ?? '[pty-host] info', data),
    };
    let flushLogger = () => {};
    try {
      const { flushDesktopLogger, getLogger } = await import('../main/desktop-logger.ts');
      log = getLogger('pty-host');
      flushLogger = flushDesktopLogger;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.warn('[pty-host] logger unavailable; using console fallback', {
        code: typeof code === 'string' ? code : 'unknown',
      });
    }
    let spawn: SpawnPty;
    try {
      ({ spawn } = await import('node-pty'));
    } catch (err) {
      installPtyImportFailureReply(parentPort, err, log);
      return;
    }
    const handle = setupPtyHost({
      parentPort,
      spawn,
      exitHost: (code) => process.exit(code),
      flushLogger,
      env: process.env,
      cliBinDir:
        process.platform === 'win32'
          ? join(
              (process as NodeJS.Process & { resourcesPath: string }).resourcesPath,
              'cli',
              'bin',
            )
          : undefined,
      logger: {
        warn: (o) => log.warn(o, 'pty-host warning'),
        info: (o) => log.info(o, 'pty-host shell resolution'),
      },
    });
    installHostReaping(handle, process);
  })();
}
