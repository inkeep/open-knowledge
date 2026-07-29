/**
 * Worker-homed keepalive for per-doc presence.
 *
 * The vendored y-protocols Awareness renews the local entry every
 * `outdatedTimeout / 2` (15s) and peers prune an entry after `outdatedTimeout`
 * (30s) with no update. That renewal runs on a MAIN-THREAD `setInterval`,
 * which a backgrounded tab throttles to ~1/min — long enough for peers to
 * drop this client as outdated, so presence flaps when the tab returns. This
 * heartbeat re-homes the renewal on a Web Worker clock (worker timers are not
 * background-throttled), re-stamping the local entry within the prune window
 * so peers keep seeing it.
 *
 * Non-authoritative and best-effort: it is a presence assist, not a durability
 * mechanism (that is flush-on-hide). Real background-throttling behavior is
 * only observable at a browser/long-run rung; the hermetic test drives the
 * renewal logic through an injected ticker and does not claim real throttling.
 */
import type { Awareness } from 'y-protocols/awareness';

/** `outdatedTimeout / 2` — the vendored Awareness renewal threshold. */
export const AWARENESS_RENEW_INTERVAL_MS = 15_000;

/**
 * Drives the heartbeat's ticks. Production uses a Web Worker whose timer the
 * browser does not throttle; tests inject a manual ticker to advance renewals
 * deterministically.
 */
export interface HeartbeatTicker {
  start(onTick: () => void): void;
  stop(): void;
}

export interface AwarenessHeartbeatOptions {
  renewIntervalMs?: number;
  now?: () => number;
}

export class AwarenessHeartbeat {
  private awareness: Awareness | null = null;
  private started = false;
  private readonly renewIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly ticker: HeartbeatTicker,
    options: AwarenessHeartbeatOptions = {},
  ) {
    this.renewIntervalMs = options.renewIntervalMs ?? AWARENESS_RENEW_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ticker.start(() => this.renewIfStale());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.ticker.stop();
    this.awareness = null;
  }

  /** Point the heartbeat at the active doc's awareness, or `null` to idle. */
  setAwareness(awareness: Awareness | null): void {
    this.awareness = awareness;
  }

  /**
   * Clear only if the heartbeat still points at `awareness`. An unmounting
   * editor uses this so a cleanup that races a newly-active editor's
   * `setAwareness` can't blank the new registration.
   */
  clearAwareness(awareness: Awareness): void {
    if (this.awareness === awareness) this.awareness = null;
  }

  /** Re-stamp the local entry when it is within one interval of going stale. */
  renewIfStale(): void {
    const awareness = this.awareness;
    if (awareness === null) return;
    const local = awareness.getLocalState();
    // A nulled entry is an intentional removal (navigate-away), not a
    // starvation candidate — nothing to keep alive.
    if (local === null) return;
    const lastUpdated = awareness.meta.get(awareness.clientID)?.lastUpdated ?? 0;
    if (this.now() - lastUpdated >= this.renewIntervalMs) {
      // Re-setting the same state bumps lastUpdated and fans a fresh update to
      // peers — the exact renewal the vendored main-thread timer would do.
      awareness.setLocalState(local);
    }
  }
}
