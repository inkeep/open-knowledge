/**
 * PTY host — runs inside a window-bound utilityProcess, owns the window's
 * node-pty shells (one per terminal tab), and bridges them to the main
 * process over `parentPort`.
 *
 * `setupPtyHost` is a pure factory with an injected `spawn`, so the
 * message-routing logic is unit-testable under Bun without a real PTY; the
 * production bootstrap at the bottom wires real `process.parentPort` +
 * `node-pty`. node-pty's PTY-fd reads do not pump under Bun's event loop, so
 * the real-shell-I/O path is exercised by a Node-runtime harness rather than
 * `bun test` (see `tests/utility/pty-host.real-io-harness.ts`).
 */

import { delimiter, join } from 'node:path';

const DARWIN_FALLBACK_SHELL = '/bin/zsh';

const STRIPPED_ENV_MARKERS = ['OK_ELECTRON_PROTOCOL_HOST', 'OK_LOCK_KIND'] as const;

export interface PtyCreateMessage {
  type: 'create';
  ptyId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Test-only shell override. Production omits → `$SHELL` or the darwin fallback. */
  shell?: string;
  /**
   * "Open in <Agent>" launch: the fixed `<bin> [pre-approve] '<prompt>'` shape
   * (built by core's `buildCliLaunchArgString`, no trailing `\r`). When present,
   * the shell is spawned as `$SHELL -l -i -c '<launchCommand>; exec $SHELL -l -i'`
   * so the agent runs WITHOUT the command being typed through the line editor —
   * i.e. it never lands in the user's shell history (`~/.zsh_history`). The
   * `exec` tail hands the tab back to a fresh interactive shell after the agent
   * exits. Omitted for a plain terminal tab (spawned as the bare `$SHELL -l -i`).
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

export interface SetupPtyHostDeps {
  /** `process.parentPort` in the utility runtime; a fake in tests. */
  parentPort: PtyHostParentPort | null;
  /** node-pty's `spawn`, injected so message routing is testable without a real PTY. */
  spawn: SpawnPty;
  /** Defaults to `process.env`. Injected so env-stripping is unit-testable. */
  env?: Record<string, string | undefined>;
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

/** Login interactive shell: sources profiles so `claude`/git/npm resolve on PATH. */
export function resolveShell(env: Record<string, string | undefined>, override?: string): string {
  if (override && override.length > 0) return override;
  const shell = env.SHELL;
  return typeof shell === 'string' && shell.length > 0 ? shell : DARWIN_FALLBACK_SHELL;
}

/**
 * Compute the shell argv for a PTY.
 *
 * - Plain tab → `['-l', '-i']`: a login interactive shell (sources profiles for
 *   PATH; interactive for the user's normal prompt + history).
 * - "Open in <Agent>" launch → `['-l', '-i', '-c', '<launchCommand>; exec <shell> -l -i']`:
 *   the SAME login-interactive shell (so `.zshrc`-sourced PATH is byte-identical
 *   to the plain tab), but the agent command rides on `-c`. A `-c` command is run
 *   directly rather than entered through the shell's line editor, so it is NOT
 *   written to the user's persistent history — fixing both the launch-line
 *   clutter and the doc-content-on-disk leak (the prompt would otherwise be saved
 *   in plaintext to `~/.zsh_history`, outside `.ok/`). The `exec <shell> -l -i`
 *   tail replaces the launcher with a fresh interactive shell once the agent
 *   exits, so the user keeps working in the same tab and THEIR commands record
 *   normally — only OK's machine-generated launch line is suppressed.
 *
 * The agent still gets a real PTY (node-pty allocates the tty), so its TUI runs
 * interactively regardless of the shell being driven by `-c`.
 */
export function buildShellArgs(shell: string, launchCommand?: string): string[] {
  if (launchCommand === undefined || launchCommand.length === 0) return ['-l', '-i'];
  // Single-quote the shell path in the `exec` tail (POSIX close-escape-reopen),
  // so a shell path containing a space or quote can't break the launcher line.
  const quotedShell = `'${shell.replace(/'/g, "'\\''")}'`;
  return ['-l', '-i', '-c', `${launchCommand}; exec ${quotedShell} -l -i`];
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
    if (stripped.has(key)) continue;
    out[key] = value;
  }
  // `ok` must resolve in OK's own terminal regardless of the shell-PATH
  // rc-consent decision: OK spawns this process, so prepending `~/.ok/bin`
  // here touches no file OK doesn't own. The env shim the rc block sources
  // dedups by substring match, so a consenting user's login shell won't
  // re-prepend it. A missing HOME (never the case on a macOS GUI launch)
  // just skips the injection.
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
  out.OK_DESKTOP_TERMINAL = '1';
  return out;
}

export function setupPtyHost(deps: SetupPtyHostDeps): PtyHostHandle {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
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
    const shell = resolveShell(env, message.shell);
    const shellEnv = buildShellEnv(env);
    let pty: PtyProcessLike;
    try {
      pty = deps.spawn(shell, buildShellArgs(shell, message.launchCommand), {
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
// `process.parentPort` is non-null only in the utility runtime; under Bun/Node
// unit tests and the Node harness it is undefined, so this branch stays dormant
// and node-pty is never imported there.
if ((process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  const parentPort = (process as NodeJS.Process & { parentPort: PtyHostParentPort }).parentPort;
  void (async () => {
    let spawn: SpawnPty;
    try {
      ({ spawn } = await import('node-pty'));
    } catch (err) {
      // node-pty failed to load (a packaging regression the `afterPack` chmod
      // is meant to prevent, or a missing native binding). Without containment
      // the unhandled rejection leaves the renderer in `'running'` with no
      // output and no signal. Reply to any `create` with a spawn-error so the
      // panel shows its error/restart state instead of hanging.
      const message = err instanceof Error ? err.message : String(err);
      parentPort.on('message', (event) => {
        const msg = asIncomingMessage(event.data);
        if (msg?.type === 'create') {
          parentPort.postMessage({ type: 'spawn-error', ptyId: msg.ptyId, message });
        }
      });
      return;
    }
    const { getLogger } = await import('../main/desktop-logger.ts');
    const log = getLogger('pty-host');
    const handle = setupPtyHost({
      parentPort,
      spawn,
      env: process.env,
      logger: { warn: (o) => log.warn(o, 'unexpected pty-host message') },
    });
    installHostReaping(handle, process);
  })();
}
