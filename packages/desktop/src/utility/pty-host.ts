/**
 * PTY host — runs inside a window-bound utilityProcess, owns the window's
 * node-pty shells (one per terminal tab), and bridges them to the main
 * process over `parentPort`.
 *
 * `setupPtyHost` is a pure factory with an injected `spawn`, so the
 * message-routing logic is unit-testable under Vitest without a real PTY; the
 * production bootstrap at the bottom wires real `process.parentPort` +
 * `node-pty`. The real-shell-I/O path is exercised by a Node-runtime harness
 * (see `tests/utility/pty-host.real-io-harness.ts`).
 */

import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { OK_DESKTOP_TERMINAL_ENV } from '@inkeep/open-knowledge-core';
import { interactiveShellArgs } from '../shared/terminal-shell.ts';

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
  /** Test-only shell override. Production uses the platform shell resolver. */
  shell?: string;
  /**
   * "Open in <Agent>" launch: the fixed `<bin> [pre-approve] '<prompt>'` shape
   * (built by core's `buildCliLaunchArgString`, no trailing `\r`). When present,
   * the shell is spawned with the platform's interactive argv plus `-c`
   * so the agent runs WITHOUT the command being typed through the line editor —
   * i.e. it never lands in the user's shell history. The
   * `exec` tail hands the tab back to a fresh interactive shell after the agent
   * exits. Omitted for a plain terminal tab.
   */
  launchCommand?: string;
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
export type PtyHostIncomingMessage =
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyPauseMessage
  | PtyResumeMessage;

interface PtyDataMessage {
  type: 'data';
  ptyId: string;
  data: string;
}
interface PtyExitMessage {
  type: 'exit';
  ptyId: string;
  exitCode: number;
  signal: number | null;
}
interface PtySpawnErrorMessage {
  type: 'spawn-error';
  ptyId: string;
  message: string;
}
export type PtyHostOutgoingMessage = PtyDataMessage | PtyExitMessage | PtySpawnErrorMessage;

/** Minimal subset of node-pty's `IPty` the host depends on. */
export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Backpressure: stop/restart the underlying PTY-fd socket reads. Main
   *  pauses on a flood (in-flight bytes past the high-water mark) and resumes
   *  once the renderer's drain acks bring it back under the low-water mark. */
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  /** Decode the PTY stream as UTF-8 strings; node-pty's StringDecoder keeps
   *  multibyte sequences intact across read boundaries. */
  encoding: 'utf8';
}
export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => PtyProcessLike;

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
  /** `process.parentPort` in the utility runtime; a fake in tests. */
  parentPort: PtyHostParentPort | null;
  /** node-pty's `spawn`, injected so message routing is testable without a real PTY. */
  spawn: SpawnPty;
  /** Defaults to `process.env`. Injected so env-stripping is unit-testable. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.userInfo().shell`. */
  userInfoShell?: () => string | null;
  /** Defaults to `existsSync`. */
  shellExists?: (path: string) => boolean;
  /** Optional structured warn sink for unrecognized/malformed messages. */
  logger?: { warn: (o: Record<string, unknown>) => void };
}

/**
 * Both ends of this channel are first-party (main forks the utility), so this
 * is not an attacker surface — but a contract skew (e.g. a stale utility after a
 * partial auto-update) sending a valid `type` with an undefined `ptyId` would
 * match no session and surface as an unroutable exit/spawn-error, hanging the
 * panel. Require a non-empty string `ptyId` before dispatch.
 */
function asIncomingMessage(raw: unknown): PtyHostIncomingMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string') return null;
  if (typeof m.ptyId !== 'string' || m.ptyId.length === 0) return null;
  // Validate the per-variant payload before the cast: a contract skew that sends
  // a valid `type`+`ptyId` but omits `data`/`cols`/`rows` would otherwise reach
  // node-pty's native binding with `undefined` arguments. Mirrors the sibling
  // `asHostMessage` guard in terminal-manager.ts.
  switch (m.type) {
    case 'create':
      // `launchCommand` is optional; when present it must be a string (it ends up
      // in the spawn argv). A non-string value from a contract skew causes the
      // entire create message to be rejected (asIncomingMessage → null → the
      // handler warns and returns) rather than reach node-pty with an undefined arg.
      return typeof m.cwd === 'string' &&
        typeof m.cols === 'number' &&
        typeof m.rows === 'number' &&
        (m.launchCommand === undefined || typeof m.launchCommand === 'string')
        ? (raw as PtyHostIncomingMessage)
        : null;
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
  /** Kill every PTY the host is multiplexing (window-close / quit reap). Idempotent. */
  killActive(): void;
}

export interface ResolveShellOptions {
  platform: NodeJS.Platform;
  override?: string;
  userInfoShell?: () => string | null;
  shellExists?: (path: string) => boolean;
  logger?: { warn: (o: Record<string, unknown>) => void };
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

/** Resolve the user's interactive shell with platform-native fallbacks. */
export function resolveShell(
  env: Record<string, string | undefined>,
  options: ResolveShellOptions,
): string {
  if (options.override && options.override.length > 0) return options.override;

  const configuredShell = env.SHELL;
  if (options.platform === 'darwin') {
    return typeof configuredShell === 'string' && configuredShell.length > 0
      ? configuredShell
      : DARWIN_FALLBACK_SHELL;
  }
  if (options.platform !== 'linux') {
    return typeof configuredShell === 'string' && configuredShell.length > 0
      ? configuredShell
      : '/bin/sh';
  }

  const shellExists = options.shellExists ?? existsSync;
  if (isUsableShell(configuredShell, shellExists)) return configuredShell;

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
  if (isUsableShell(passwdShell, shellExists)) return passwdShell;
  return shellExists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/**
 * Compute the shell argv for a PTY.
 *
 * macOS uses a login interactive shell; Linux uses an interactive non-login
 * shell, matching each platform's terminal convention. "Open in <Agent>"
 * keeps the same flags in its exec tail, but the agent command rides on `-c`.
 * A `-c` command is run
 *   directly rather than entered through the shell's line editor, so it is NOT
 *   written to the user's persistent history — fixing both the launch-line
 *   clutter and the doc-content-on-disk leak (the prompt would otherwise be saved
 *   in plaintext to the shell's history file, outside `.ok/`). The `exec` tail
 *   replaces the launcher with a fresh interactive shell once the agent
 *   exits, so the user keeps working in the same tab and THEIR commands record
 *   normally — only OK's machine-generated launch line is suppressed.
 *
 * The agent still gets a real PTY (node-pty allocates the tty), so its TUI runs
 * interactively regardless of the shell being driven by `-c`.
 */
export function buildShellArgs(
  platform: NodeJS.Platform,
  shell: string,
  launchCommand?: string,
): string[] {
  const interactiveArgs = [...interactiveShellArgs(platform)];
  if (launchCommand === undefined || launchCommand.length === 0) return interactiveArgs;
  // Single-quote the shell path in the `exec` tail (POSIX close-escape-reopen),
  // so a shell path containing a space or quote can't break the launcher line.
  const quotedShell = `'${shell.replace(/'/g, "'\\''")}'`;
  return [
    ...interactiveArgs,
    '-c',
    `${launchCommand}; exec ${quotedShell} ${interactiveArgs.join(' ')}`,
  ];
}

/**
 * Build the child shell env from the parent, stripping desktop-only markers
 * that would otherwise leak into the user's interactive terminal. The
 * utility's own fork env carries these (see `utility-fork-env.ts`); the shell
 * the user types into must not.
 */
export function buildShellEnv(
  parentEnv: Record<string, string | undefined>,
): Record<string, string> {
  const stripped = new Set<string>(STRIPPED_ENV_MARKERS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (stripped.has(key) || key.startsWith('GDK_PIXBUF_')) continue;
    out[key] = value;
  }
  // `ok` must resolve in OK's own terminal regardless of the shell-PATH
  // rc-consent decision: OK spawns this process, so prepending `~/.ok/bin`
  // here touches no file OK doesn't own. The env shim the rc block sources
  // dedups by substring match, so a consenting user's login shell won't
  // re-prepend it. A missing HOME just skips the injection.
  const home = out.HOME;
  if (home) {
    const okBin = join(home, '.ok', 'bin');
    const entries = (out.PATH ?? '').split(delimiter).filter(Boolean);
    if (!entries.includes(okBin)) {
      out.PATH = [okBin, ...entries].join(delimiter);
    }
  }
  // Positive identity for an agent running in this shell: it's the OK Desktop
  // built-in terminal, on an already-open project window. The project skill
  // keys off this to pick `ok open <doc>` (focuses a tab in THIS window) over
  // resolving a preview URL — otherwise the agent can't tell where it's running
  // and guesses the browser path. Set last so it can't be shadowed by parentEnv.
  out[OK_DESKTOP_TERMINAL_ENV] = '1';
  return out;
}

export function setupPtyHost(deps: SetupPtyHostDeps): PtyHostHandle {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const platform = deps.platform ?? process.platform;
  // One host per window multiplexes every terminal tab's shell, keyed by the
  // renderer-minted ptyId. Each create adds an entry; tabs are independent.
  const sessions = new Map<string, PtyProcessLike>();

  function post(message: PtyHostOutgoingMessage): void {
    deps.parentPort?.postMessage(message);
  }

  function safeKill(pty: PtyProcessLike): void {
    try {
      pty.kill();
    } catch (err) {
      // TOCTOU: the shell may exit between our last state update and this
      // call, so kill() throws ESRCH — the process is already gone, which is
      // fine. Any other failure (e.g. EPERM) reaped nothing and would leave an
      // orphan; surface it so that's diagnosable, but never rethrow (the reap
      // loop must continue to the next session).
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'ESRCH') {
        deps.logger?.warn({ event: 'pty-host-reap-failed', code: code ?? 'unknown' });
      }
    }
  }

  function handleCreate(message: PtyCreateMessage): void {
    const { ptyId } = message;
    // ptyIds are minted fresh per renderer create(), so a live entry under this
    // id means a contract skew (e.g. a stale utility after a partial
    // auto-update). Reap the stale shell before overwriting the slot so it
    // cannot leak as an unreachable orphan.
    const stale = sessions.get(ptyId);
    if (stale) {
      safeKill(stale);
      sessions.delete(ptyId);
    }
    const shell = resolveShell(env, {
      platform,
      override: message.shell,
      userInfoShell: deps.userInfoShell,
      shellExists: deps.shellExists,
      logger: deps.logger,
    });
    const shellEnv = buildShellEnv(env);
    let pty: PtyProcessLike;
    try {
      pty = deps.spawn(shell, buildShellArgs(platform, shell, message.launchCommand), {
        name: 'xterm-256color',
        cols: message.cols,
        rows: message.rows,
        cwd: message.cwd,
        env: shellEnv,
        encoding: 'utf8',
      });
    } catch (err) {
      // node-pty can throw synchronously at spawn on resource exhaustion
      // (EMFILE/ENOMEM). Contain it as an error message so the utility
      // process survives instead of crashing the window (a bad shell path
      // is NOT this path — that surfaces as an async exit with code 1).
      // A non-Error throw must still yield a string: the main-side
      // `asHostMessage` drops a spawn-error whose `message` is not a string,
      // which would strand the panel with no exit ever routed.
      const message = err instanceof Error ? err.message : String(err);
      post({ type: 'spawn-error', ptyId, message });
      return;
    }
    sessions.set(ptyId, pty);
    pty.onData((data) => {
      // Identity match (not bare membership) suppresses late "straggler" bytes
      // from a shell that has already exited or been superseded under this id.
      if (sessions.get(ptyId) === pty) post({ type: 'data', ptyId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (sessions.get(ptyId) === pty) sessions.delete(ptyId);
      post({ type: 'exit', ptyId, exitCode, signal: signal ?? null });
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
      default:
        // `asIncomingMessage` admits any string `type`, so an unknown variant
        // (a future/stale contract) lands here visibly instead of silently.
        deps.logger?.warn({
          event: 'pty-host-unexpected-message',
          type: (message as unknown as { type: string }).type,
        });
        break;
    }
  });

  return {
    killActive(): void {
      // safeKill per entry so one shell's ESRCH (already exited) cannot abort
      // the reap of the rest.
      for (const pty of sessions.values()) safeKill(pty);
      sessions.clear();
    },
  };
}

/**
 * Subset of `process` the reaping installer drives — the termination signals
 * Electron delivers to a utilityProcess plus a way to exit. Injected so the
 * wiring is unit-testable with a fake emitter.
 */
export interface HostReapProcess {
  on(event: 'exit', listener: () => void): void;
  on(event: NodeJS.Signals, listener: () => void): void;
  exit(code?: number): void;
}

const REAP_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Reap the host's node-pty shells promptly and explicitly when the host process
 * is torn down. node-pty spawns each shell in its own session (a `setsid` for
 * controlling-terminal semantics), so they are NOT in the host's process group —
 * killing the host does not cascade to the shells through the group.
 *
 * Two mechanisms keep a killed host from orphaning its shells; this is the
 * deterministic one:
 *   1. Explicit (this wiring): on a catchable teardown signal — Electron's
 *      `utilityProcess.kill()` delivers SIGTERM — call `killActive()`, signaling
 *      every live shell's process group before the host exits.
 *   2. OS backstop: when the host exits, each pty master fd closes and the
 *      kernel delivers SIGHUP to that slave session, reaping the shell. This
 *      also covers an uncatchable SIGKILL, which this handler cannot.
 *
 * Explicit reaping is preferred for promptness and full-process-group breadth;
 * the `'exit'` handler is a synchronous best-effort backstop for non-signal
 * exit paths.
 */
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

// Production entry — auto-runs when imported by `utilityProcess.fork(<this-file>)`.
// `process.parentPort` is non-null only in the utility runtime; under Vitest/Node
// and the Node harness it is undefined, so this branch stays dormant
// and node-pty is never imported there.
if ((process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  const parentPort = (process as NodeJS.Process & { parentPort: PtyHostParentPort }).parentPort;
  void (async () => {
    let log: {
      warn(data: Record<string, unknown>, message?: string): void;
    } = {
      warn: (data, message) => console.warn(message ?? '[pty-host] warning', data),
    };
    try {
      const { getLogger } = await import('../main/desktop-logger.ts');
      log = getLogger('pty-host');
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
      // node-pty failed to load (a packaging regression the `afterPack` chmod
      // is meant to prevent, or a missing native binding). Without containment
      // the unhandled rejection leaves the renderer in `'running'` with no
      // output and no signal. Reply to any `create` with a spawn-error so the
      // panel shows its error/restart state instead of hanging.
      installPtyImportFailureReply(parentPort, err, log);
      return;
    }
    const handle = setupPtyHost({
      parentPort,
      spawn,
      env: process.env,
      logger: { warn: (o) => log.warn(o, 'unexpected pty-host message') },
    });
    installHostReaping(handle, process);
  })();
}
