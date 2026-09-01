import type { Awareness } from 'y-protocols/awareness';

export const AWARENESS_RENEW_INTERVAL_MS = 15_000;

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

  setAwareness(awareness: Awareness | null): void {
    this.awareness = awareness;
  }

  clearAwareness(awareness: Awareness): void {
    if (this.awareness === awareness) this.awareness = null;
  }

  renewIfStale(): void {
    const awareness = this.awareness;
    if (awareness === null) return;
    const local = awareness.getLocalState();
    if (local === null) return;
    const lastUpdated = awareness.meta.get(awareness.clientID)?.lastUpdated ?? 0;
    if (this.now() - lastUpdated >= this.renewIntervalMs) {
      awareness.setLocalState(local);
    }
  }
}
