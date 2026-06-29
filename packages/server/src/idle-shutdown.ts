
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
}

export interface IdleShutdownHandle {
  detach: () => void;
}

export function attachIdleShutdown(opts: AttachIdleShutdownOptions): IdleShutdownHandle {
  const scheduler = opts.scheduler ?? defaultScheduler;
  const warnBeforeMs = opts.warnBeforeMs ?? DEFAULT_WARN_BEFORE_MS;

  let webSocketClientCount = 0;
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
    if (webSocketClientCount !== 0) return;

    if (warnBeforeMs > 0 && warnBeforeMs < opts.thresholdMs) {
      warnTimer = scheduler.setTimeout(() => {
        warnTimer = null;
        if (webSocketClientCount === 0 && !fired) {
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
      if (webSocketClientCount !== 0) return;
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

  const onUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    if (!req.url?.startsWith('/collab')) return;
    webSocketClientCount++;
    clearTimers();
    socket.once('close', () => {
      webSocketClientCount--;
      if (webSocketClientCount < 0) webSocketClientCount = 0;
      if (webSocketClientCount === 0) scheduleShutdown();
    });
  };

  opts.httpServer.on('upgrade', onUpgrade);
  scheduleShutdown();

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      opts.httpServer.off('upgrade', onUpgrade);
      clearTimers();
    },
  };
}
