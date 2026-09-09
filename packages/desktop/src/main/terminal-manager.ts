import {
  isWindowsShellFamily,
  isWindowsShellLaunchFailureReason,
  type TerminalLaunchCommand,
  type WindowsShellFamily,
} from '@inkeep/open-knowledge-core';
import {
  isTerminalShellNoticeReason,
  isTerminalSupportFileNoticeReason,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import type {
  OkPtyAdoptResult,
  OkPtyCreateResult,
  OkPtyExit,
  OkPtyListEntry,
  OkPtyNotice,
  TerminalShellNoticeReason,
} from '../shared/bridge-contract.ts';
import type { SendableWebContents } from '../shared/ipc-send.ts';
import type {
  PtyCreateMessage,
  PtyHostIncomingMessage,
  PtyHostOutgoingMessage,
} from '../utility/pty-host.ts';

export interface PtyUtilityLike {
  postMessage(message: PtyHostIncomingMessage): void;
  on(event: 'message', cb: (message: unknown) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

type TimerToken = unknown;

export interface TerminalManagerDeps {
  forkPtyHost: () => PtyUtilityLike;
  sendData: (webContents: SendableWebContents, payload: { ptyId: string; data: string }) => void;
  sendExit: (webContents: SendableWebContents, payload: OkPtyExit) => void;
  sendNotice?: (webContents: SendableWebContents, payload: OkPtyNotice) => void;
  newPtyId: () => string;
  canSpawnAt: (projectRoot: string) => boolean;
  setTimer: (cb: () => void, ms: number) => TimerToken;
  clearTimer: (token: TimerToken) => void;
  coalesceMs?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  replayCapBytes?: number;
  shutdownMs?: number;
  logger?: { warn: (o: Record<string, unknown>) => void };
  recordShellExit?: (info: { crashed: boolean }) => void;
  recordTerminalSession?: () => void;
  recordConcurrentSessions?: (info: { count: number }) => void;
}

interface TerminalCreateRequest {
  windowId: number;
  webContents: SendableWebContents;
  projectRoot: string | null;
  cols: number;
  rows: number;
  shell?: string;
  shellInvalidReason?: TerminalShellNoticeReason;
  launchCommand?: string | TerminalLaunchCommand;
}

interface TerminalAddressedRequest {
  windowId: number;
  ptyId: string;
}

interface TerminalAdoptRequest {
  start?: boolean;
  windowId: number;
  ptyId: string;
  webContents: SendableWebContents;
}

interface SessionState {
  pendingCreate: PtyCreateMessage | null;
  outbound: string;
  replay: string;
  flushToken: TimerToken | null;
  staleToken: TimerToken | null;
  pendingBytes: number;
  paused: boolean;
  commandRan: boolean;
  customLabel: string | null;
  ordinal: number | null;
  order: number;
  shellFamily: WindowsShellFamily | null;
  shellNoticeReason: Extract<TerminalShellNoticeReason, 'unsupported-family'> | null;
}

interface PtyWindowHandle {
  webContents: SendableWebContents;
  utility: PtyUtilityLike;
  sessions: Map<string, SessionState>;
  shutdownToken: TimerToken | null;
  shutdownPromise: Promise<void> | null;
  shutdownResolve: (() => void) | null;
}

const DEFAULT_COALESCE_MS = 5;
const DEFAULT_HIGH_WATER = 1024 * 1024;
const DEFAULT_LOW_WATER = 256 * 1024;
const DEFAULT_REPLAY_CAP = 256 * 1024;
const DEFAULT_SHUTDOWN_MS = 2000;
const STALE_RESERVATION_WARN_MS = 30_000;

export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;
const MAX_PTY_DIMENSION = 1000;

export function clampPtyDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PTY_DIMENSION
    ? value
    : fallback;
}

function containsCommandSubmit(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}

export interface TerminalManager {
  create(req: TerminalCreateRequest): OkPtyCreateResult;
  input(req: TerminalAddressedRequest & { data: string }): void;
  resize(req: TerminalAddressedRequest & { cols: number; rows: number }): void;
  kill(req: TerminalAddressedRequest): void;
  drain(req: TerminalAddressedRequest & { bytes: number }): void;
  listSessions(windowId: number): OkPtyListEntry[];
  setSessionMeta(
    req: TerminalAddressedRequest & { customLabel?: string | null; ordinal?: number },
  ): void;
  setSessionOrder(req: { windowId: number; orderedPtyIds: readonly string[] }): void;
  adoptSession(req: TerminalAdoptRequest): OkPtyAdoptResult;
  killForWindow(windowId: number): void;
  killAll(): Promise<void>;
}

export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager {
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const highWater = deps.highWaterBytes ?? DEFAULT_HIGH_WATER;
  const lowWater = deps.lowWaterBytes ?? DEFAULT_LOW_WATER;
  const replayCap = deps.replayCapBytes ?? DEFAULT_REPLAY_CAP;
  const shutdownMs = deps.shutdownMs ?? DEFAULT_SHUTDOWN_MS;
  const handles = new Map<number, PtyWindowHandle>();
  const pendingShutdowns = new Set<Promise<void>>();

  function safeKillUtility(handle: PtyWindowHandle): void {
    try {
      handle.utility.kill();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'ESRCH') {
        deps.logger?.warn({ event: 'terminal-manager-kill-failed', code: code ?? 'unknown' });
      }
    }
  }

  function warnPostFailed(event: string, err: unknown, extra?: Record<string, unknown>): void {
    deps.logger?.warn({
      event,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
      ...extra,
    });
  }

  function clearShutdownDeadline(handle: PtyWindowHandle): void {
    if (handle.shutdownToken === null) return;
    deps.clearTimer(handle.shutdownToken);
    handle.shutdownToken = null;
  }

  function finishHostShutdown(handle: PtyWindowHandle): void {
    clearShutdownDeadline(handle);
    handle.shutdownResolve?.();
    handle.shutdownResolve = null;
  }

  function beginHostShutdown(handle: PtyWindowHandle): Promise<void> {
    if (handle.shutdownPromise !== null) return handle.shutdownPromise;
    const shutdownPromise = new Promise<void>((resolve) => {
      handle.shutdownResolve = resolve;
    });
    handle.shutdownPromise = shutdownPromise;
    pendingShutdowns.add(shutdownPromise);
    void shutdownPromise.finally(() => pendingShutdowns.delete(shutdownPromise));
    handle.shutdownToken = deps.setTimer(() => {
      handle.shutdownToken = null;
      deps.logger?.warn({ event: 'terminal-manager-shutdown-deadline' });
      safeKillUtility(handle);
      finishHostShutdown(handle);
    }, shutdownMs);
    try {
      handle.utility.postMessage({ type: 'shutdown' });
    } catch (err) {
      clearShutdownDeadline(handle);
      warnPostFailed('terminal-manager-shutdown-send-failed', err);
      safeKillUtility(handle);
      finishHostShutdown(handle);
    }
    return shutdownPromise;
  }

  function pushData(handle: PtyWindowHandle, ptyId: string, data: string): void {
    if (handle.webContents.isDestroyed?.()) return;
    deps.sendData(handle.webContents, { ptyId, data });
  }

  function pushExit(handle: PtyWindowHandle, payload: OkPtyExit): void {
    if (handle.webContents.isDestroyed?.()) return;
    deps.sendExit(handle.webContents, payload);
  }

  function pushNotice(handle: PtyWindowHandle, payload: OkPtyNotice): void {
    if (handle.webContents.isDestroyed?.()) return;
    deps.sendNotice?.(handle.webContents, payload);
  }

  function deliver(handle: PtyWindowHandle, ptyId: string, session: SessionState): void {
    if (handle.webContents.isDestroyed?.()) return;
    if (session.outbound.length === 0) return;
    const chunk = session.outbound;
    session.outbound = '';
    pushData(handle, ptyId, chunk);
    session.pendingBytes += chunk.length;
    if (!session.paused && session.pendingBytes > highWater) {
      handle.utility.postMessage({ type: 'pause', ptyId });
      session.paused = true;
    }
  }

  function flushTick(windowId: number, ptyId: string): void {
    const handle = handles.get(windowId);
    const session = handle?.sessions.get(ptyId);
    if (!handle || !session) return;
    session.flushToken = null;
    deliver(handle, ptyId, session);
  }

  function scheduleFlush(windowId: number, ptyId: string, session: SessionState): void {
    if (session.flushToken !== null) return;
    session.flushToken = deps.setTimer(() => flushTick(windowId, ptyId), coalesceMs);
  }

  function clearSessionTimers(session: SessionState): void {
    if (session.flushToken !== null) {
      deps.clearTimer(session.flushToken);
      session.flushToken = null;
    }
    if (session.staleToken !== null) {
      deps.clearTimer(session.staleToken);
      session.staleToken = null;
    }
  }

  function asHostMessage(raw: unknown): PtyHostOutgoingMessage | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.ptyId !== 'string' || m.ptyId.length === 0) return null;
    switch (m.type) {
      case 'data':
        return typeof m.data === 'string' ? (raw as PtyHostOutgoingMessage) : null;
      case 'exit':
        return (m.exitCode === undefined || typeof m.exitCode === 'number') &&
          (m.signal === null || typeof m.signal === 'number')
          ? (raw as PtyHostOutgoingMessage)
          : null;
      case 'spawn-error':
        return (typeof m.message === 'string' && m.launchFailure === undefined) ||
          (m.message === undefined && isWindowsShellLaunchFailureReason(m.launchFailure))
          ? (raw as PtyHostOutgoingMessage)
          : null;
      case 'shell-notice':
        return (m.notice === 'invalid-shell-override' && isTerminalShellNoticeReason(m.reason)) ||
          (m.notice === 'shell-resolved' && isWindowsShellFamily(m.shellFamily)) ||
          (m.notice === 'support-file-degraded' && isTerminalSupportFileNoticeReason(m.reason))
          ? (raw as PtyHostOutgoingMessage)
          : null;
      default:
        return null;
    }
  }

  function onUtilityMessage(windowId: number, raw: unknown): void {
    const handle = handles.get(windowId);
    if (!handle) return;
    const message = asHostMessage(raw);
    if (!message) {
      const m = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
      const rejectedPtyId =
        typeof m?.ptyId === 'string' && m.ptyId.length > 0 ? m.ptyId : undefined;
      const rejectedType = typeof m?.type === 'string' ? m.type : undefined;
      const stranded =
        rejectedType === 'spawn-error' && rejectedPtyId !== undefined
          ? handle.sessions.get(rejectedPtyId)
          : undefined;
      deps.logger?.warn({
        event: 'pty-host-unexpected-message',
        windowId,
        ...(rejectedPtyId === undefined ? {} : { ptyId: rejectedPtyId }),
        ...(rejectedType === undefined ? {} : { rawType: rejectedType }),
        reaped: stranded !== undefined,
      });
      if (rejectedPtyId !== undefined && stranded !== undefined) {
        clearSessionTimers(stranded);
        handle.sessions.delete(rejectedPtyId);
        pushExit(handle, { ptyId: rejectedPtyId, neverStarted: true });
        handle.utility.postMessage({ type: 'kill', ptyId: rejectedPtyId });
      }
      return;
    }
    const session = handle.sessions.get(message.ptyId);
    if (!session) return;

    switch (message.type) {
      case 'data':
        session.outbound += message.data;
        session.replay += message.data;
        if (session.replay.length > replayCap) {
          session.replay = session.replay.slice(session.replay.length - replayCap);
        }
        scheduleFlush(windowId, message.ptyId, session);
        break;
      case 'exit': {
        const { ptyId } = message;
        clearSessionTimers(session);
        deliver(handle, ptyId, session);
        maybeRecordSession(session);
        handle.sessions.delete(ptyId);
        deps.recordShellExit?.({ crashed: false });
        pushExit(handle, {
          ptyId,
          exitCode: message.exitCode ?? -1,
          signal: message.signal,
        });
        break;
      }
      case 'spawn-error': {
        const { ptyId } = message;
        clearSessionTimers(session);
        handle.sessions.delete(ptyId);
        deps.logger?.warn({
          event: 'terminal-manager-spawn-error',
          windowId,
          ptyId,
          ...(message.launchFailure === undefined
            ? { message: message.message }
            : { launchFailure: message.launchFailure }),
        });
        pushExit(
          handle,
          message.launchFailure === undefined
            ? { ptyId, error: message.message, neverStarted: true }
            : { ptyId, launchFailure: message.launchFailure, neverStarted: true },
        );
        break;
      }
      case 'shell-notice':
        if (message.notice === 'shell-resolved') {
          session.shellFamily = message.shellFamily;
          pushNotice(handle, {
            ptyId: message.ptyId,
            notice: message.notice,
            shellFamily: message.shellFamily,
          });
        } else if (message.notice === 'invalid-shell-override') {
          if (message.reason === 'unsupported-family') {
            session.shellNoticeReason = message.reason;
          }
          pushNotice(handle, {
            ptyId: message.ptyId,
            notice: message.notice,
            reason: message.reason,
          });
        } else {
          pushNotice(handle, {
            ptyId: message.ptyId,
            notice: message.notice,
            reason: message.reason,
          });
        }
        break;
    }
  }

  function onUtilityExit(windowId: number, handle: PtyWindowHandle, code: number | null): void {
    finishHostShutdown(handle);
    if (handles.get(windowId) !== handle) return;
    handles.delete(windowId);
    deps.logger?.warn({
      event: 'terminal-manager-host-exited',
      windowId,
      code,
      sessions: handle.sessions.size,
      reserved: [...handle.sessions.values()].filter((s) => s.pendingCreate !== null).length,
    });
    for (const [ptyId, session] of handle.sessions) {
      clearSessionTimers(session);
      if (session.outbound.length > 0) {
        pushData(handle, ptyId, session.outbound);
        session.outbound = '';
      }
      if (session.pendingCreate !== null) {
        pushExit(handle, { ptyId, neverStarted: true, hostExited: true });
      } else {
        maybeRecordSession(session);
        deps.recordShellExit?.({ crashed: true });
        pushExit(handle, { ptyId, exitCode: code ?? 1, signal: null, hostExited: true });
      }
    }
    handle.sessions.clear();
  }

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
      shutdownToken: null,
      shutdownPromise: null,
      shutdownResolve: null,
    };
    handles.set(req.windowId, handle);
    utility.on('message', (raw) => onUtilityMessage(req.windowId, raw));
    utility.on('exit', (code) => onUtilityExit(req.windowId, handle, code));
    return handle;
  }

  return {
    create(req): OkPtyCreateResult {
      if (req.projectRoot === null) return { ok: false, reason: 'no-project' };
      const handle = ensureHandle(req);
      const ptyId = deps.newPtyId();
      const nextOrder =
        handle.sessions.size === 0
          ? 0
          : Math.max(...[...handle.sessions.values()].map((s) => s.order)) + 1;
      const session: SessionState = {
        pendingCreate: {
          type: 'create',
          ptyId,
          cwd: req.projectRoot,
          cols: req.cols,
          rows: req.rows,
          ...(req.shell === undefined ? {} : { shell: req.shell }),
          ...(req.shellInvalidReason === undefined
            ? {}
            : { shellInvalidReason: req.shellInvalidReason }),
          ...(req.launchCommand === undefined ? {} : { launchCommand: req.launchCommand }),
        },
        outbound: '',
        replay: '',
        flushToken: null,
        pendingBytes: 0,
        paused: false,
        commandRan: false,
        customLabel: null,
        ordinal: null,
        order: nextOrder,
        shellFamily: null,
        shellNoticeReason: null,
        staleToken: null,
      };
      session.staleToken = deps.setTimer(() => {
        const live = handles.get(req.windowId)?.sessions.get(ptyId);
        if (live === undefined || live.staleToken === null) return;
        live.staleToken = null;
        if (live.pendingCreate === null) return;
        deps.logger?.warn({
          event: 'terminal-manager-stale-reservation',
          windowId: req.windowId,
          ptyId,
        });
      }, STALE_RESERVATION_WARN_MS);
      handle.sessions.set(ptyId, session);
      return { ok: true, ptyId };
    },

    input(req): void {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session || session.pendingCreate !== null) return;
      if (!session.commandRan && containsCommandSubmit(req.data)) session.commandRan = true;
      handle.utility.postMessage({ type: 'input', ptyId: req.ptyId, data: req.data });
    },

    resize(req): void {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session) return;
      if (session.pendingCreate !== null) {
        session.pendingCreate.cols = req.cols;
        session.pendingCreate.rows = req.rows;
        return;
      }
      handle.utility.postMessage({
        type: 'resize',
        ptyId: req.ptyId,
        cols: req.cols,
        rows: req.rows,
      });
    },

    kill(req): void {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session) return;
      if (session.pendingCreate !== null) {
        clearSessionTimers(session);
        handle.sessions.delete(req.ptyId);
        return;
      }
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
      return [...handle.sessions.entries()]
        .filter(([, session]) => session.pendingCreate === null)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([ptyId, session]) => ({
          ptyId,
          customLabel: session.customLabel,
          ordinal: session.ordinal,
        }));
    },

    setSessionMeta(req): void {
      const session = handles.get(req.windowId)?.sessions.get(req.ptyId);
      if (!session) return;
      if (req.customLabel !== undefined) session.customLabel = req.customLabel;
      if (req.ordinal !== undefined) session.ordinal = req.ordinal;
    },

    setSessionOrder(req): void {
      const handle = handles.get(req.windowId);
      if (!handle) return;
      let i = 0;
      const listed = new Set(req.orderedPtyIds);
      for (const ptyId of req.orderedPtyIds) {
        const session = handle.sessions.get(ptyId);
        if (session) session.order = i++;
      }
      const rest = [...handle.sessions.entries()]
        .filter(([ptyId]) => !listed.has(ptyId))
        .sort((a, b) => a[1].order - b[1].order);
      for (const [, session] of rest) session.order = i++;
    },

    adoptSession(req): OkPtyAdoptResult {
      const handle = handles.get(req.windowId);
      const session = handle?.sessions.get(req.ptyId);
      if (!handle || !session) return { ok: false, reason: 'unknown-session' };
      if (session.pendingCreate !== null) {
        if (!req.start) {
          deps.logger?.warn({
            event: 'terminal-manager-adopt-unstarted-reservation',
            windowId: req.windowId,
            ptyId: req.ptyId,
          });
          return { ok: false, reason: 'not-started' };
        }
        const message = session.pendingCreate;
        if (!deps.canSpawnAt(message.cwd)) {
          clearSessionTimers(session);
          handle.sessions.delete(req.ptyId);
          deps.logger?.warn({
            event: 'terminal-manager-start-refused',
            windowId: req.windowId,
            ptyId: req.ptyId,
          });
          return { ok: false, reason: 'not-consented' };
        }
        handle.webContents = req.webContents;
        session.pendingCreate = null;
        clearSessionTimers(session);
        const liveCount = [...handle.sessions.values()].filter(
          (live) => live.pendingCreate === null,
        ).length;
        // STOP: post and return in the same tick; TerminalPanel installs its readiness scanner after this reply, so an await below would let the shell's first output outrun it.
        try {
          handle.utility.postMessage(message);
        } catch (err) {
          handle.sessions.delete(req.ptyId);
          warnPostFailed('terminal-manager-start-failed', err, {
            windowId: req.windowId,
            ptyId: req.ptyId,
          });
          return { ok: false, reason: 'host-unavailable' };
        }
        deps.recordConcurrentSessions?.({ count: liveCount });
        return { ok: true, replay: '' };
      }
      clearSessionTimers(session);
      session.outbound = '';
      session.pendingBytes = 0;
      session.paused = false;
      try {
        handle.utility.postMessage({ type: 'resume', ptyId: req.ptyId });
      } catch (err) {
        warnPostFailed('terminal-manager-adopt-resume-failed', err, {
          windowId: req.windowId,
          ptyId: req.ptyId,
        });
        return { ok: false, reason: 'host-unavailable' };
      }
      handle.webContents = req.webContents;
      return {
        ok: true,
        replay: session.replay,
        ...(session.shellFamily === null ? {} : { shellFamily: session.shellFamily }),
        ...(session.shellNoticeReason === null
          ? {}
          : { shellNoticeReason: session.shellNoticeReason }),
      };
    },

    killForWindow(windowId): void {
      const handle = handles.get(windowId);
      if (!handle) return;
      let reserved = 0;
      for (const session of handle.sessions.values()) {
        clearSessionTimers(session);
        maybeRecordSession(session);
        if (session.pendingCreate !== null) reserved += 1;
      }
      if (reserved > 0)
        deps.logger?.warn({ event: 'terminal-manager-reaped-reservations', windowId, reserved });
      handles.delete(windowId);
      void beginHostShutdown(handle);
    },

    async killAll(): Promise<void> {
      const shutdowns: Promise<void>[] = [];
      for (const [windowId, handle] of handles) {
        let reserved = 0;
        for (const session of handle.sessions.values()) {
          clearSessionTimers(session);
          maybeRecordSession(session);
          if (session.pendingCreate !== null) reserved += 1;
        }
        if (reserved > 0)
          deps.logger?.warn({ event: 'terminal-manager-reaped-reservations', windowId, reserved });
        shutdowns.push(beginHostShutdown(handle));
      }
      handles.clear();
      shutdowns.push(...pendingShutdowns);
      await Promise.all(shutdowns);
    },
  };
}
