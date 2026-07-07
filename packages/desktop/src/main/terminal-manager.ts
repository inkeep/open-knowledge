/**
 * Main-side mediator between the renderer's xterm panels and the per-window
 * utilityProcess that hosts node-pty (`utility/pty-host.ts`).
 *
 * One PTY host (one utilityProcess) per window, lazily forked on the first
 * `ok:pty:create` and reused for every terminal tab in that window. The manager:
 *   - resolves the window's project root and refuses a terminal for a window
 *     that has none (no cwd to anchor a shell in);
 *   - routes `input` / `resize` / `kill` / `drain` to the addressed session
 *     within the host, dropping an unknown ptyId so a stale renderer can't
 *     drive a sibling or successor PTY;
 *   - coalesces each session's `data` reads on a short timer and pushes one
 *     combined UTF-8 string per tick (the renderer-freeze guard);
 *   - bounds each session's in-flight bytes with a high/low-water
 *     `pause()`/`resume()` loop driven by the renderer's `drain` acks (the
 *     backpressure seam) — a flood in one tab pauses only its PTY;
 *   - surfaces host `exit` / `spawn-error` and a utilityProcess crash as
 *     `ok:pty:exit` so the panel never hangs.
 *
 * Electron-free by construction — every side effect (fork, send, ptyId, timer)
 * is an injected dep, so the routing + coalescing + backpressure logic is
 * unit-testable without an Electron runtime.
 */

import type { OkPtyAdoptResult, OkPtyListEntry } from '../shared/bridge-contract.ts';
import type { SendableWebContents } from '../shared/ipc-send.ts';
import type { PtyHostIncomingMessage, PtyHostOutgoingMessage } from '../utility/pty-host.ts';

/** Minimal subset of `electron.utilityProcess.fork`'s return the manager drives. */
export interface PtyUtilityLike {
  postMessage(message: PtyHostIncomingMessage): void;
  on(event: 'message', cb: (message: unknown) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Opaque token returned by the injected coalesce timer. */
type TimerToken = unknown;

export interface TerminalManagerDeps {
  /** Fork a fresh `pty-host` utilityProcess. Called once per window (lazy). */
  forkPtyHost: () => PtyUtilityLike;
  /** Push a coalesced `ok:pty:data` chunk — `sendToRenderer(..., 'ok:pty:data')`. */
  sendData: (webContents: SendableWebContents, payload: { ptyId: string; data: string }) => void;
  /** Push an `ok:pty:exit` — `sendToRenderer(..., 'ok:pty:exit')`. */
  sendExit: (
    webContents: SendableWebContents,
    payload: { ptyId: string; exitCode: number; signal: number | null; error?: string },
  ) => void;
  /** Fresh PTY id — `randomUUID` in production; deterministic in tests. */
  newPtyId: () => string;
  /** Schedule a coalesce flush. `setTimeout` in production; captured in tests. */
  setTimer: (cb: () => void, ms: number) => TimerToken;
  /** Cancel a scheduled flush. `clearTimeout` in production. */
  clearTimer: (token: TimerToken) => void;
  /** Coalesce window in ms (8-16ms keeps pushes bounded by tick rate). Default 12. */
  coalesceMs?: number;
  /** Pause the host once un-drained in-flight bytes exceed this. Default 1 MiB. */
  highWaterBytes?: number;
  /** Resume the host once in-flight bytes fall back under this. Default 256 KiB. */
  lowWaterBytes?: number;
  /** Cap on the per-session reload-replay ring (retained screen + scrollback the
   *  reloaded renderer repaints on adopt). Default 256 KiB. */
  replayCapBytes?: number;
  /** Optional structured warn sink (pino `getLogger` in production). */
  logger?: { warn: (o: Record<string, unknown>) => void };
  /**
   * Reliability telemetry: a shell exit or PTY/host crash. `crashed`
   * distinguishes the two. Not fired on a window-close / quit reap (app
   * teardown, not a shell the user watched end). Optional — no-op when absent.
   */
  recordShellExit?: (info: { crashed: boolean }) => void;
  /**
   * Adoption telemetry (count only): fired once when a terminated session had
   * at least one command run. The manager decides "a command ran" from a line
   * terminator in the input stream — never from the command's contents.
   * Optional — no-op when absent.
   */
  recordTerminalSession?: () => void;
  /**
   * Concurrency telemetry (count only): fired on each create — when the session
   * is added, before the host confirms the spawn — with the number of sessions
   * now live in that window, so the per-window max is observable. A later
   * spawn-error deletes the session without a corrective signal, so the peak can
   * transiently overstate by 1 per failed spawn. Carries only the bounded
   * integer count — never a ptyId, path, or
   * command content. Optional — no-op when absent.
   */
  recordConcurrentSessions?: (info: { count: number }) => void;
}

interface TerminalCreateRequest {
  windowId: number;
  webContents: SendableWebContents;
  /** Folder-admission-resolved project root, or `null` for a window with no project. */
  projectRoot: string | null;
  cols: number;
  rows: number;
  /**
   * "Open in <Agent>" launch command — the fixed `<bin> [pre-approve] '<prompt>'`
   * shape (no trailing `\r`). When present, the host bakes it into the shell
   * spawn (`$SHELL -l -i -c '<this>; exec …'`) so the agent runs without the
   * command being typed into the shell and thus recorded in the user's history.
   * Omitted for a plain terminal tab. Forwarded verbatim to the host's create.
   */
  launchCommand?: string;
}

interface TerminalAddressedRequest {
  windowId: number;
  ptyId: string;
}

interface TerminalAdoptRequest {
  windowId: number;
  ptyId: string;
  /** The reloaded renderer's fresh webContents, rebound as the delivery target. */
  webContents: SendableWebContents;
}

type CreateResult =
  | { readonly ok: true; readonly ptyId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'not-consented' };

/**
 * Per-tab state. One entry per live PTY the window's host multiplexes.
 * Coalescing and backpressure run independently per session so a flood or exit
 * in one tab can't pause, corrupt, or kill another.
 */
interface SessionState {
  /** Coalescing buffer — this session's host reads not yet flushed to the renderer. */
  outbound: string;
  /**
   * Capped ring of this session's recent output, retained for reload replay.
   * Unlike `outbound` (cleared on every flush), this keeps the recent screen +
   * scrollback so a reloaded renderer that adopts the surviving PTY can repaint
   * it — without it the adopted tab comes back blank (issue #351 follow-up: the
   * PTY reconnects but its screen is gone). Trimmed from the front past the replay
   * cap (`deps.replayCapBytes`, default `DEFAULT_REPLAY_CAP`); dropped with the
   * session on exit.
   */
  replay: string;
  flushToken: TimerToken | null;
  /** Bytes pushed to the renderer minus bytes the renderer has drain-acked. */
  pendingBytes: number;
  /** True once we have told the host to `pause()` this session; reset on resume. */
  paused: boolean;
  /**
   * True once this session's input carried a line terminator (a command was
   * submitted). Drives the count-only `terminal-session` telemetry; never holds
   * command contents.
   */
  commandRan: boolean;
}

interface PtyWindowHandle {
  webContents: SendableWebContents;
  utility: PtyUtilityLike;
  /** Live sessions keyed by ptyId — one per terminal tab in this window. */
  sessions: Map<string, SessionState>;
}

const DEFAULT_COALESCE_MS = 12;
const DEFAULT_HIGH_WATER = 1024 * 1024;
const DEFAULT_LOW_WATER = 256 * 1024;
/**
 * Default cap on the per-session reload-replay ring — UTF-16 code units of recent
 * shell output (matching `.length`/`outbound` accounting) retained so a reloaded
 * renderer can repaint the adopted PTY's screen. Sized to the low-water mark:
 * enough for a deep screen + scrollback, bounded per live session (dropped when
 * the session exits). Overridable via `deps.replayCapBytes`.
 */
const DEFAULT_REPLAY_CAP = 256 * 1024;

/** Sane fallback PTY size when the renderer sends an out-of-range dimension. */
export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;
const MAX_PTY_DIMENSION = 1000;

/**
 * Clamp a renderer-supplied PTY dimension before it reaches node-pty's
 * spawn/resize. The renderer is the untrusted side the main-side backstop
 * defends; a buggy or compromised one can send NaN/0/negative/huge values that
 * are undefined behavior against the native winsize ioctl. Anything outside
 * 1..MAX falls back to a safe default rather than reaching node-pty.
 */
export function clampPtyDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PTY_DIMENSION
    ? value
    : fallback;
}

/**
 * A submitted command is detected by a line terminator in the input — xterm
 * sends `\r` on Enter (`\n` on some bindings). This is the only thing the
 * manager reads out of the input stream for telemetry; the bytes themselves
 * are never inspected, stored, or attached to any span (privacy line).
 */
function containsCommandSubmit(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}

export interface TerminalManager {
  create(req: TerminalCreateRequest): CreateResult;
  input(req: TerminalAddressedRequest & { data: string }): void;
  resize(req: TerminalAddressedRequest & { cols: number; rows: number }): void;
  kill(req: TerminalAddressedRequest): void;
  drain(req: TerminalAddressedRequest & { bytes: number }): void;
  /**
   * Live ptyIds for a window — the reload-rehydration inventory a reloaded
   * renderer queries to rediscover its surviving shells. Insertion order =
   * creation order = natural tab order. Empty for a window with no host.
   */
  listSessions(windowId: number): OkPtyListEntry[];
  /**
   * Re-bind a surviving session to a reloaded renderer's fresh webContents and
   * clear the backpressure the dead page stranded (so a session paused under a
   * pre-reload flood resumes). Refuses a ptyId no longer live for the window so
   * the caller can fall back to a fresh create.
   */
  adoptSession(req: TerminalAdoptRequest): OkPtyAdoptResult;
  /** Window-close reap. Idempotent. */
  killForWindow(windowId: number): void;
  /** App-quit reap of every window's PTY host. */
  killAll(): void;
}

export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager {
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const highWater = deps.highWaterBytes ?? DEFAULT_HIGH_WATER;
  const lowWater = deps.lowWaterBytes ?? DEFAULT_LOW_WATER;
  const replayCap = deps.replayCapBytes ?? DEFAULT_REPLAY_CAP;
  const handles = new Map<number, PtyWindowHandle>();

  /** Kill a host without letting a throw abort a multi-window reap loop. The
   *  utilityProcess may already be gone (TOCTOU) so `kill()` can throw; mirrors
   *  pty-host's `safeKill`. */
  function safeKillUtility(handle: PtyWindowHandle): void {
    try {
      handle.utility.kill();
    } catch (err) {
      // ESRCH means the host already exited (TOCTOU) — expected, ignore. Any
      // other code (e.g. EPERM) reaped nothing and leaves an orphan host, so
      // surface it for diagnostics; never rethrow (the loop must continue so
      // the remaining windows' hosts are reaped). Mirrors pty-host's safeKill.
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'ESRCH') {
        deps.logger?.warn({ event: 'terminal-manager-kill-failed', code: code ?? 'unknown' });
      }
    }
  }

  function pushData(handle: PtyWindowHandle, ptyId: string, data: string): void {
    // The window can close mid-stream — `webContents.send` throws on a
    // destroyed WebContents and crashes main. Cross-time-mutation boundary;
    // skip the push instead. Mirrors the localOp streaming guard.
    if (handle.webContents.isDestroyed?.()) return;
    deps.sendData(handle.webContents, { ptyId, data });
  }

  function pushExit(
    handle: PtyWindowHandle,
    payload: { ptyId: string; exitCode: number; signal: number | null; error?: string },
  ): void {
    if (handle.webContents.isDestroyed?.()) return;
    deps.sendExit(handle.webContents, payload);
  }

  function flush(windowId: number, ptyId: string): void {
    const handle = handles.get(windowId);
    const session = handle?.sessions.get(ptyId);
    if (!handle || !session) return;
    session.flushToken = null;
    // pushData skips the send on a destroyed WebContents; bail before touching
    // pendingBytes so backpressure accounting doesn't drift on bytes that were
    // never delivered.
    if (handle.webContents.isDestroyed?.()) return;
    if (session.outbound.length === 0) return;
    const chunk = session.outbound;
    session.outbound = '';
    pushData(handle, ptyId, chunk);
    // Account in UTF-16 code units (`.length`); the renderer's `drain` reports
    // the same `.length` of each consumed payload, so the two reconcile.
    session.pendingBytes += chunk.length;
    if (!session.paused && session.pendingBytes > highWater) {
      handle.utility.postMessage({ type: 'pause', ptyId });
      session.paused = true;
    }
  }

  function scheduleFlush(windowId: number, ptyId: string, session: SessionState): void {
    if (session.flushToken !== null) return;
    session.flushToken = deps.setTimer(() => flush(windowId, ptyId), coalesceMs);
  }

  function clearFlush(session: SessionState): void {
    if (session.flushToken !== null) {
      deps.clearTimer(session.flushToken);
      session.flushToken = null;
    }
  }

  /**
   * Narrow an untyped utilityProcess message (cross-process boundary). Both
   * ends are first-party, so this guards a contract skew (e.g. a stale utility
   * after a partial auto-update), not an attacker. Each variant's required
   * fields are asserted so a malformed message with a valid `type` is dropped
   * rather than propagating an `undefined` `ptyId` that defeats the active-id
   * guard and hangs the panel on an unmatchable exit/spawn-error.
   */
  function asHostMessage(raw: unknown): PtyHostOutgoingMessage | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.ptyId !== 'string' || m.ptyId.length === 0) return null;
    switch (m.type) {
      case 'data':
        return typeof m.data === 'string' ? (raw as PtyHostOutgoingMessage) : null;
      case 'exit':
        return typeof m.exitCode === 'number' && (m.signal === null || typeof m.signal === 'number')
          ? (raw as PtyHostOutgoingMessage)
          : null;
      case 'spawn-error':
        return typeof m.message === 'string' ? (raw as PtyHostOutgoingMessage) : null;
      default:
        return null;
    }
  }

  function onUtilityMessage(windowId: number, raw: unknown): void {
    const handle = handles.get(windowId);
    if (!handle) return;
    const message = asHostMessage(raw);
    if (!message) {
      deps.logger?.warn({ event: 'pty-host-unexpected-message', windowId });
      return;
    }
    // Drop messages for a session we no longer track — a closed tab, or a
    // ptyId superseded after a restart; routing it would push into a stale panel.
    const session = handle.sessions.get(message.ptyId);
    if (!session) return;

    switch (message.type) {
      case 'data':
        session.outbound += message.data;
        // Retain a capped copy for reload replay (independent of the flush that
        // clears `outbound`), trimming oldest bytes past the cap. A reloaded
        // renderer adopts this session and repaints from `session.replay`.
        session.replay += message.data;
        if (session.replay.length > replayCap) {
          session.replay = session.replay.slice(session.replay.length - replayCap);
        }
        scheduleFlush(windowId, message.ptyId, session);
        break;
      case 'exit': {
        // Flush this session's buffered output first so the final bytes land
        // before the exit state, then drop the session — the host stays up for
        // the window's other tabs (and a later restart).
        const { ptyId } = message;
        clearFlush(session);
        flush(windowId, ptyId);
        maybeRecordSession(session);
        handle.sessions.delete(ptyId);
        deps.recordShellExit?.({ crashed: false });
        pushExit(handle, {
          ptyId,
          exitCode: message.exitCode,
          signal: message.signal,
        });
        break;
      }
      case 'spawn-error': {
        // Resource-exhaustion spawn failure (EMFILE/ENOMEM) — surface as a
        // crashed exit so the panel shows the restart affordance. No session
        // marker: the shell never started, so no command could have run.
        const { ptyId } = message;
        clearFlush(session);
        handle.sessions.delete(ptyId);
        deps.recordShellExit?.({ crashed: true });
        pushExit(handle, { ptyId, exitCode: 1, signal: null, error: message.message });
        break;
      }
    }
  }

  function onUtilityExit(windowId: number, code: number | null): void {
    const handle = handles.get(windowId);
    if (!handle) return;
    // The host process itself died (a native crash escaping pty-host's own
    // containment), taking every shell it multiplexed with it. Surface an exit
    // on each live session so no panel hangs, then drop the dead host so the
    // next create forks a fresh one.
    handles.delete(windowId);
    for (const [ptyId, session] of handle.sessions) {
      clearFlush(session);
      // Flush this session's coalesced output before its exit so the last bytes
      // the shell produced — buffered main-side, independent of the dead host —
      // land before the exit state, mirroring the clean-exit ordering.
      if (session.outbound.length > 0) {
        pushData(handle, ptyId, session.outbound);
        session.outbound = '';
      }
      maybeRecordSession(session);
      deps.recordShellExit?.({ crashed: true });
      pushExit(handle, {
        ptyId,
        exitCode: code ?? 1,
        signal: null,
        error: 'terminal host exited',
      });
    }
    handle.sessions.clear();
  }

  /**
   * Emit the count-only session marker if this session ran a command, then
   * clear the flag so a session is counted at most once across its possible
   * end paths (clean exit, host crash, window-close reap, quit reap).
   */
  function maybeRecordSession(session: SessionState): void {
    if (!session.commandRan) return;
    session.commandRan = false;
    deps.recordTerminalSession?.();
  }

  function ensureHandle(req: TerminalCreateRequest): PtyWindowHandle {
    const existing = handles.get(req.windowId);
    if (existing) {
      existing.webContents = req.webContents;
      return existing;
    }
    const utility = deps.forkPtyHost();
    const handle: PtyWindowHandle = {
      webContents: req.webContents,
      utility,
      sessions: new Map(),
    };
    handles.set(req.windowId, handle);
    utility.on('message', (raw) => onUtilityMessage(req.windowId, raw));
    utility.on('exit', (code) => onUtilityExit(req.windowId, code));
    return handle;
  }

  return {
    create(req): CreateResult {
      if (req.projectRoot === null) return { ok: false, reason: 'no-project' };
      const handle = ensureHandle(req);
      const ptyId = deps.newPtyId();
      // Intentionally uncapped: the shared per-window host keeps memory flat
      // regardless of tab count, and per-session backpressure bounds the shared
      // renderer thread under floods. The one resource that still scales with
      // tab count is the browser's ~8-16 live WebGL contexts (one per mounted
      // xterm); past that the oldest context is dropped, degrading that tab's
      // rendering. A soft cap is deferred until the concurrency-depth signal
      // below shows users actually approach that ceiling.
      // A new tab ADDS a session; the window's existing shells keep running.
      handle.sessions.set(ptyId, {
        outbound: '',
        replay: '',
        flushToken: null,
        pendingBytes: 0,
        paused: false,
        commandRan: false,
      });
      // Record the concurrency reached by this open (1 for a solo tab, N for the
      // Nth concurrent tab). Concurrency only rises on create, so the per-window
      // max is the highest value seen here.
      deps.recordConcurrentSessions?.({ count: handle.sessions.size });
      handle.utility.postMessage({
        type: 'create',
        ptyId,
        cwd: req.projectRoot,
        cols: req.cols,
        rows: req.rows,
        launchCommand: req.launchCommand,
      });
      return { ok: true, ptyId };
    },

    input(req): void {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session) return;
      if (!session.commandRan && containsCommandSubmit(req.data)) session.commandRan = true;
      handle.utility.postMessage({ type: 'input', ptyId: req.ptyId, data: req.data });
    },

    resize(req): void {
      const handle = handles.get(req.windowId);
      if (!handle?.sessions.has(req.ptyId)) return;
      handle.utility.postMessage({
        type: 'resize',
        ptyId: req.ptyId,
        cols: req.cols,
        rows: req.rows,
      });
    },

    kill(req): void {
      const handle = handles.get(req.windowId);
      if (!handle?.sessions.has(req.ptyId)) return;
      handle.utility.postMessage({ type: 'kill', ptyId: req.ptyId });
    },

    drain(req): void {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session) return;
      session.pendingBytes = Math.max(0, session.pendingBytes - req.bytes);
      if (session.paused && session.pendingBytes < lowWater) {
        handle.utility.postMessage({ type: 'resume', ptyId: req.ptyId });
        session.paused = false;
      }
    },

    listSessions(windowId): OkPtyListEntry[] {
      const handle = handles.get(windowId);
      if (!handle) return [];
      // Map insertion order is creation order, so the inventory matches the
      // dock's original left-to-right tab order. A session that exited has
      // already been deleted by `onUtilityMessage`, so it never appears here.
      return [...handle.sessions.keys()].map((ptyId) => ({ ptyId }));
    },

    adoptSession(req): OkPtyAdoptResult {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      // The handle can be present (other tabs live) while this specific shell
      // exited in the gap between the dock's list and this adopt — refuse so the
      // panel spawns a fresh shell rather than wiring xterm to a dead ptyId.
      if (!handle || !session) return { ok: false, reason: 'unknown-session' };
      // The dead page's in-flight drain-acks died with it, so the renderer-side
      // byte accounting is stale. Reset it and resume the host unconditionally:
      // a session paused under a >1 MiB pre-reload flood would otherwise stay
      // paused forever (the new page only acks bytes it newly receives). Resume
      // on an already-running PTY is a host no-op.
      //
      // Also drop the stale coalesced `outbound` (and cancel its pending flush):
      // output produced while the page was dead piled up there because `flush`
      // bails on the destroyed webContents without clearing it. Those exact bytes
      // are already in `replay` (returned below and repainted by the renderer), so
      // re-binding webContents and letting that flush fire would deliver them a
      // second time — duplicate scrollback / corrupted TUI screen. Mirrors the
      // exit / onUtilityExit cleanup.
      clearFlush(session);
      session.outbound = '';
      session.pendingBytes = 0;
      session.paused = false;
      try {
        handle.utility.postMessage({ type: 'resume', ptyId: req.ptyId });
      } catch (err) {
        // The PTY host can exit in the same list()->adopt TOCTOU window the
        // session-presence check above guards (postMessage on a dead
        // utilityProcess throws). A dead host means a dead session, so refuse
        // the adopt and let the panel spawn fresh rather than wire xterm to it.
        // ESRCH is the expected host-already-gone code; surface anything else
        // for diagnostics. Mirrors safeKillUtility's TOCTOU handling.
        const code = (err as { code?: string } | null)?.code;
        if (code !== 'ESRCH') {
          deps.logger?.warn({
            event: 'terminal-manager-adopt-resume-failed',
            code: code ?? 'unknown',
            windowId: req.windowId,
            ptyId: req.ptyId,
          });
        }
        return { ok: false, reason: 'unknown-session' };
      }
      // Rebind delivery to the reloaded page's webContents (a normal in-page
      // reload keeps the same object, but a crash/recreate reload does not).
      // webContents is per-window, shared by every session under this handle, so
      // the first surviving tab's adopt rebinds delivery for all its siblings —
      // the reloaded page is the single render target for the whole window.
      handle.webContents = req.webContents;
      // Hand back the retained screen + scrollback so the fresh xterm repaints it
      // before live delivery resumes — without this the adopted tab is blank
      // (issue #351 follow-up). The renderer writes `replay`, then wires onData.
      return { ok: true, replay: session.replay };
    },

    killForWindow(windowId): void {
      const handle = handles.get(windowId);
      if (!handle) return;
      // Count each session that ran a command — a window-close reap is a common
      // way used terminals end, so omitting them would undercount.
      for (const session of handle.sessions.values()) {
        clearFlush(session);
        maybeRecordSession(session);
      }
      // Delete first so the resulting utility `'exit'` event no-ops instead of
      // pushing spurious `ok:pty:exit`s into the closing window.
      handles.delete(windowId);
      safeKillUtility(handle);
    },

    killAll(): void {
      for (const handle of handles.values()) {
        for (const session of handle.sessions.values()) {
          clearFlush(session);
          maybeRecordSession(session);
        }
        safeKillUtility(handle);
      }
      handles.clear();
    },
  };
}
