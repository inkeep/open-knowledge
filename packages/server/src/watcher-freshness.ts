import { existsSync } from 'node:fs';
import { getLogger } from './logger.ts';
import {
  incrementWatcherResubscribes,
  incrementWatcherResubscribesAbandoned,
  incrementWatcherRootMissing,
} from './metrics.ts';
import type { WatcherClock, WatcherTimer } from './watcher-clock.ts';

const log = getLogger('watcher-freshness');

export const FRESHNESS_BASE_INTERVAL_MS = 5_000;
export const FRESHNESS_MAX_INTERVAL_MS = 60_000;
const FRESHNESS_DUTY_CYCLE_FACTOR = 20;

export const FRESHNESS_HASH_BUDGET = { files: 512, bytes: 64 * 1024 * 1024 } as const;

const RESUBSCRIBE_EARLY_DELAYS_MS: readonly number[] = [0, 1_000, 5_000];
const RESUBSCRIBE_FINAL_DELAY_MS = 30_000;
const RESUBSCRIBE_MAX_ATTEMPTS = 8;
export const RESUBSCRIBE_SLOW_RETRY_MS = 5 * 60_000;
const RESUBSCRIBE_ROOT_POLL_MS = 1_000;
const RESUBSCRIBE_STABLE_MS = 60_000;

type ResubscribeReason = 'error' | 'root-delete';

export type RecoveryMode = 'metadata' | 'full';

export function nextFreshnessDelayMs(lastPassMs: number, baseMs: number): number {
  const ceiling = Math.max(baseMs, FRESHNESS_MAX_INTERVAL_MS);
  const proportional = Math.ceil(Math.max(0, lastPassMs) * FRESHNESS_DUTY_CYCLE_FACTOR);
  return Math.min(ceiling, Math.max(baseMs, proportional));
}

function resubscribeDelayMs(attempt: number): number {
  return RESUBSCRIBE_EARLY_DELAYS_MS[attempt] ?? RESUBSCRIBE_FINAL_DELAY_MS;
}

export function resolveFreshnessInterval(option: number | null | undefined): number | null {
  if (option === null || option === undefined) return null;
  if (!Number.isFinite(option) || option <= 0) {
    throw new RangeError('freshnessIntervalMs must be a positive number of milliseconds or null');
  }
  return option;
}

interface WatcherSubscriptionLike {
  unsubscribe(): Promise<void>;
}

export interface Resubscriber {
  start(): Promise<void>;
  isLive(generation: number): boolean;
  lost(reason: ResubscribeReason, generation: number, err?: unknown): void;
  noticeRootMissing(): void;
  close(): Promise<void>;
}

export function createResubscriber(deps: {
  clock: WatcherClock;
  root: string;
  backendName: string;
  coverageWhileLost: string;
  subscribe: (generation: number) => Promise<WatcherSubscriptionLike>;
  onResubscribed: () => void;
  onGaveUp?: (err: unknown) => void;
  onBack?: () => void;
}): Resubscriber {
  let closed = false;
  let generation = 0;
  let liveGeneration: number | null = null;
  let current: WatcherSubscriptionLike | null = null;
  let liveSince = Number.NEGATIVE_INFINITY;
  let attempt = 0;
  let timer: WatcherTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let slowRetry = false;
  const releases = new Set<Promise<void>>();
  const backend = deps.backendName;

  const release = (subscription: WatcherSubscriptionLike): void => {
    const released = subscription.unsubscribe().catch((err: unknown) => {
      log.debug({ err, backend }, 'releasing a lost watcher subscription failed');
    });
    releases.add(released);
    void released.then(() => releases.delete(released));
  };

  const attemptResubscribe = async (reason: ResubscribeReason): Promise<void> => {
    if (closed) return;
    if (!existsSync(deps.root)) {
      log.debug(
        { backend, reason },
        'the watched directory is missing; waiting before resubscribing',
      );
      schedule(RESUBSCRIBE_ROOT_POLL_MS, reason);
      return;
    }
    const next = ++generation;
    liveGeneration = next;
    let subscription: WatcherSubscriptionLike;
    try {
      subscription = await deps.subscribe(next);
    } catch (err) {
      if (liveGeneration === next) liveGeneration = null;
      if (slowRetry) {
        log.debug({ err, backend, reason }, 'watcher still cannot subscribe; trying again later');
        schedule(RESUBSCRIBE_SLOW_RETRY_MS, reason);
        return;
      }
      attempt++;
      if (attempt >= RESUBSCRIBE_MAX_ATTEMPTS) {
        giveUp(reason, err);
        return;
      }
      log.warn({ err, backend, reason, attempt }, 'watcher resubscribe failed; retrying');
      schedule(resubscribeDelayMs(attempt), reason);
      return;
    }
    if (closed || liveGeneration !== next) {
      release(subscription);
      return;
    }
    current = subscription;
    liveSince = deps.clock.now();
    incrementWatcherResubscribes();
    if (slowRetry) {
      slowRetry = false;
      attempt = 0;
      log.info({ backend, reason }, 'watcher subscribed again after it had given up');
      deps.onBack?.();
    } else {
      log.info({ backend, reason, attempt }, 'watcher resubscribed');
    }
    deps.onResubscribed();
  };

  const giveUp = (reason: ResubscribeReason, err: unknown): void => {
    slowRetry = true;
    incrementWatcherResubscribesAbandoned();
    log.warn(
      { err, backend, reason, attempts: attempt, retryMs: RESUBSCRIBE_SLOW_RETRY_MS },
      `watcher subscription failed ${attempt} times in a row; it now tries again every ${RESUBSCRIBE_SLOW_RETRY_MS / 60_000} minutes, and until it is back ${deps.coverageWhileLost}`,
    );
    deps.onGaveUp?.(err);
    schedule(RESUBSCRIBE_SLOW_RETRY_MS, reason);
  };

  const schedule = (delayMs: number, reason: ResubscribeReason): void => {
    if (closed) return;
    timer = deps.clock.setTimeout(() => {
      timer = null;
      const work = attemptResubscribe(reason);
      inFlight = work;
      void work.finally(() => {
        if (inFlight === work) inFlight = null;
      });
    }, delayMs);
    timer.unref();
  };

  const lost = (reason: ResubscribeReason, lostGeneration: number, err?: unknown): void => {
    if (closed || lostGeneration !== liveGeneration) return;
    liveGeneration = null;
    const dead = current;
    current = null;
    if (dead) release(dead);
    if (reason === 'root-delete') incrementWatcherRootMissing();
    attempt = deps.clock.now() - liveSince < RESUBSCRIBE_STABLE_MS ? attempt + 1 : 0;
    if (attempt >= RESUBSCRIBE_MAX_ATTEMPTS) {
      giveUp(
        reason,
        err ??
          new Error(
            `the ${reason === 'error' ? 'subscription failed' : 'watched directory was deleted'}`,
          ),
      );
      return;
    }
    log.warn({ err, backend, reason, attempt }, 'watcher subscription lost; resubscribing');
    schedule(resubscribeDelayMs(attempt), reason);
  };

  return {
    async start() {
      const first = ++generation;
      liveGeneration = first;
      const subscription = await deps.subscribe(first);
      if (closed || liveGeneration !== first) {
        release(subscription);
        return;
      }
      current = subscription;
    },
    isLive: (candidate) => !closed && candidate === liveGeneration,
    lost,
    noticeRootMissing() {
      if (liveGeneration !== null) lost('root-delete', liveGeneration);
    },
    async close() {
      closed = true;
      deps.clock.clearTimeout(timer);
      timer = null;
      await inFlight;
      const live = current;
      current = null;
      liveGeneration = null;
      try {
        if (live) await live.unsubscribe();
      } finally {
        await Promise.all(releases);
      }
    },
  };
}
