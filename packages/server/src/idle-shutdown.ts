/**
 * Idle-shutdown primitive counting only WebSocket upgrades at `/collab`. DirectConnections are
 * invisible to it by design (precedent #14), so `getConnectionsCount()` is never consulted; the
 * scheduler is injectable per precedent #13(b).
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { defaultScheduler, type Scheduler } from '@inkeep/open-knowledge-core';
import type { PinoLogger } from './logger.ts';

const DEFAULT_WARN_BEFORE_MS = 5 * 60 * 1000;

export interface AttachIdleShutdownOptions {
  httpServer: HttpServer;
  thresholdMs: number;
  onShutdown: () => Promise<void> | void;
  log?: PinoLogger;
  warnBeforeMs?: number;
  scheduler?: Scheduler;
  counter?: CollabClientCounter;
}

export interface IdleShutdownHandle {
  detach: () => void;
}

export interface CollabClientCounter {
  getCount: () => number;
  subscribe: (listener: (count: number) => void) => () => void;
  detach: () => void;
}

/**
 * DirectConnections (CC1 broadcaster, agent sessions) never transit an upgrade and are invisible
 * here, which is what keeps a permanently-connected internal consumer from pinning the count above
 * zero (precedent #14).
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
      if (ownsCounter) counter.detach();
      clearTimers();
    },
  };
}
