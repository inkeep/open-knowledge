/**
 * Idle-shutdown primitive — WebSocket-client-count-only.
 *
 * Attaches an `upgrade` listener to the HTTP server and counts WebSocket
 * upgrade requests at `/collab`. When the counter hits zero for a configured
 * `thresholdMs`, `onShutdown` fires.
 *
 * Key property (precedent #14): DirectConnections
 * (CC1 broadcaster, AgentSessionManager) are invisible to this primitive —
 * they never transit an HTTP upgrade at `/collab`, so `getConnectionsCount()`
 * on the Hocuspocus instance is NOT consulted. Raw upgrade count is the sole
 * signal. This is the only correct way to idle-shutdown under a live
 * server whose CC1 DirectConnection is permanent.
 *
 * The scheduler is injectable per precedent #13b (implicit time
 * coupling is a test smell). Production defaults to `setTimeout`/`clearTimeout`
 * passthrough; tests inject a `ManualScheduler` for deterministic advance.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { defaultScheduler, type Scheduler } from '@inkeep/open-knowledge-core';
import type { PinoLogger } from './logger.ts';

const DEFAULT_WARN_BEFORE_MS = 5 * 60 * 1000;

export interface AttachIdleShutdownOptions {
  /** HTTP server to hook `upgrade` events on. */
  httpServer: HttpServer;
  /** Milliseconds of WebSocket-idle before `onShutdown` fires. */
  thresholdMs: number;
  /** Callback invoked when the threshold is reached with zero WS clients. */
  onShutdown: () => Promise<void> | void;
  /** Optional logger for WARN / INFO lines. */
  log?: PinoLogger;
  /**
   * Milliseconds before threshold at which to emit a WARN log.
   * Default 5 minutes. Suppressed when `>= thresholdMs`.
   */
  warnBeforeMs?: number;
  /** Injectable scheduler for deterministic tests. */
  scheduler?: Scheduler;
  /**
   * An already-attached counter to schedule off. Supplied when the caller
   * already counts for another consumer, so one upgrade listener serves both.
   * When omitted this attaches its own and owns tearing it down.
   */
  counter?: CollabClientCounter;
}

export interface IdleShutdownHandle {
  /** Removes the upgrade listener and clears any pending timers. Idempotent. */
  detach: () => void;
}

export interface CollabClientCounter {
  /** Live `/collab` WebSocket clients right now — editor windows AND agents. */
  getCount: () => number;
  /**
   * Observe count changes. Returns an unsubscribe. Several consumers watch the
   * same count (idle-shutdown schedules off it; the server-info route reads
   * it), so this is a fan-out rather than a single callback — two counters over
   * one server would double the upgrade listeners and drift the moment the
   * counting rule changes.
   */
  subscribe: (listener: (count: number) => void) => () => void;
  /**
   * Removes the upgrade listener. Idempotent. Belongs to whoever CREATED the
   * counter — a consumer handed one it did not create unsubscribes instead,
   * or it would stop counting for every other consumer.
   */
  detach: () => void;
}

/**
 * Count live `/collab` WebSocket upgrades on `httpServer`.
 *
 * The single counting implementation: idle-shutdown schedules off it, and the
 * server-info route discloses it so a caller about to terminate this process
 * can ask "is anything using it" rather than "who started it" (the latter is
 * unanswerable — the process title is rewritten at start). DirectConnections
 * (CC1 broadcaster, agent sessions) never transit an upgrade and are invisible
 * here, which is what keeps a permanently-connected internal consumer from
 * pinning the count above zero (precedent #14).
 */
export function attachCollabClientCounter(
  httpServer: HttpServer,
  onChange?: (count: number) => void,
): CollabClientCounter {
  let count = 0;
  let detached = false;
  const listeners = new Set<(next: number) => void>();
  if (onChange) listeners.add(onChange);
  const emit = (next: number): void => {
    for (const listener of listeners) listener(next);
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    if (!req.url?.startsWith('/collab')) return;
    count++;
    emit(count);
    socket.once('close', () => {
      count--;
      if (count < 0) count = 0;
      emit(count);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  return {
    getCount: () => count,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    detach: () => {
      if (detached) return;
      detached = true;
      httpServer.off('upgrade', onUpgrade);
    },
  };
}

export function attachIdleShutdown(opts: AttachIdleShutdownOptions): IdleShutdownHandle {
  const scheduler = opts.scheduler ?? defaultScheduler;
  const warnBeforeMs = opts.warnBeforeMs ?? DEFAULT_WARN_BEFORE_MS;

  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let detached = false;

  function clearTimers(): void {
    if (shutdownTimer !== null) {
      scheduler.clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    if (warnTimer !== null) {
      scheduler.clearTimeout(warnTimer);
      warnTimer = null;
    }
  }

  function scheduleShutdown(): void {
    clearTimers();
    if (detached || fired) return;
    if (counter.getCount() !== 0) return;

    if (warnBeforeMs > 0 && warnBeforeMs < opts.thresholdMs) {
      warnTimer = scheduler.setTimeout(() => {
        warnTimer = null;
        if (counter.getCount() === 0 && !fired) {
          opts.log?.warn(
            { msUntilShutdown: warnBeforeMs, webSocketClientCount: 0 },
            'idle shutdown pending: no WebSocket clients',
          );
        }
      }, opts.thresholdMs - warnBeforeMs);
    }

    shutdownTimer = scheduler.setTimeout(() => {
      shutdownTimer = null;
      if (detached || fired) return;
      if (counter.getCount() !== 0) return;
      fired = true;
      opts.log?.info({ webSocketClientCount: 0 }, 'idle shutdown firing');
      try {
        const result = opts.onShutdown();
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => {
            opts.log?.error({ err }, 'idle shutdown handler rejected');
          });
        }
      } catch (err) {
        opts.log?.error({ err }, 'idle shutdown handler threw');
      }
    }, opts.thresholdMs);
  }

  const onCount = (count: number): void => {
    if (count === 0) scheduleShutdown();
    else clearTimers();
  };
  const ownsCounter = opts.counter === undefined;
  const counter = opts.counter ?? attachCollabClientCounter(opts.httpServer);
  const unsubscribe = counter.subscribe(onCount);

  scheduleShutdown();

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      unsubscribe();
      // Detaching a counter we were handed would stop counting for its owner.
      if (ownsCounter) counter.detach();
      clearTimers();
    },
  };
}
