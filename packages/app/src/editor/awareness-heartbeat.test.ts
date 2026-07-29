/**
 * Starvation contract for the worker-homed presence keepalive.
 *
 * Peers prune a presence entry after `outdatedTimeout` (30s) with no update.
 * The vendored renewal runs on a main-thread timer a backgrounded tab
 * throttles to ~1/min, so the entry would cross the prune line; the heartbeat
 * re-homes the renewal on an unthrottled worker clock. This drives that
 * renewal logic through an injected ticker + clock against REAL y-protocols
 * Awareness objects (real lastUpdated/clock bookkeeping, real update fan-out to
 * a wired peer). It does NOT reproduce real browser throttling — that is only
 * observable at a browser/long-run rung and is carried as an open residual,
 * not claimed here.
 *
 * Time base: y-protocols stamps `lastUpdated` from a reference to `Date.now`
 * captured at import, so fake timers can't reach it. Instead the heartbeat's
 * `now` is injected and each simulated renewal instant is written back into the
 * awareness meta, keeping the awareness's stamp and the heartbeat's clock in
 * one controlled time base.
 */

import { describe, expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  outdatedTimeout,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AwarenessHeartbeat, type HeartbeatTicker } from './awareness-heartbeat';

class ManualTicker implements HeartbeatTicker {
  private cb: (() => void) | null = null;
  start(onTick: () => void): void {
    this.cb = onTick;
  }
  stop(): void {
    this.cb = null;
  }
  fire(): void {
    this.cb?.();
  }
}

/** Pin the awareness's local stamp into the test-controlled time base. */
function setLastUpdated(aw: Awareness, t: number): void {
  const meta = aw.meta.get(aw.clientID);
  if (meta) aw.meta.set(aw.clientID, { clock: meta.clock, lastUpdated: t });
}

function wire(from: Awareness, to: Awareness): void {
  from.on(
    'update',
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated).concat(removed);
      applyAwarenessUpdate(to, encodeAwarenessUpdate(from, changed), 'wire');
    },
  );
}

describe('AwarenessHeartbeat starvation contract', () => {
  it('renews at worker cadence so consecutive updates never exceed the prune window', () => {
    const clientDoc = new Y.Doc();
    const peerDoc = new Y.Doc();
    const clientAw = new Awareness(clientDoc);
    const peerAw = new Awareness(peerDoc);
    wire(clientAw, peerAw);

    let clock = 0;
    const ticker = new ManualTicker();
    const heartbeat = new AwarenessHeartbeat(ticker, { now: () => clock });
    heartbeat.setAwareness(clientAw);
    heartbeat.start();

    // Publish at t=0. The publish is the first "fresh" instant.
    clientAw.setLocalState({ user: { name: 'me' } });
    setLastUpdated(clientAw, 0);
    const peerClockAtPublish = peerAw.meta.get(clientAw.clientID)?.clock ?? -1;

    const renewInstants: number[] = [0];
    clientAw.on('update', () => renewInstants.push(clock));

    // Worker ticks every 15s (its unthrottled cadence), well past the 30s line.
    for (const t of [15_000, 30_000, 45_000, 60_000]) {
      clock = t;
      ticker.fire();
      setLastUpdated(clientAw, t); // the renewal (if any) landed at this instant
    }

    // Every tick renewed (15s ≥ the 15s threshold), so the peer observed four
    // fresh updates and the largest gap between renewals stays under the prune
    // window — the entry never goes outdated.
    expect(renewInstants).toEqual([0, 15_000, 30_000, 45_000, 60_000]);
    let maxGap = 0;
    for (let i = 1; i < renewInstants.length; i++) {
      maxGap = Math.max(maxGap, renewInstants[i] - renewInstants[i - 1]);
    }
    expect(maxGap).toBeLessThan(outdatedTimeout);

    const peerClockNow = peerAw.meta.get(clientAw.clientID)?.clock ?? -1;
    expect(peerClockNow - peerClockAtPublish).toBe(4); // peer saw each renewal

    heartbeat.stop();
    clientAw.destroy();
    peerAw.destroy();
    clientDoc.destroy();
    peerDoc.destroy();
  });

  it('without the heartbeat renewing, the entry goes outdated past the prune window', () => {
    const doc = new Y.Doc();
    const aw = new Awareness(doc);

    let clock = 0;
    const ticker = new ManualTicker();
    // Registered but never started — models the clamped main thread with no
    // worker assist. Ticks that do fire must not renew.
    const heartbeat = new AwarenessHeartbeat(ticker, { now: () => clock });
    heartbeat.setAwareness(aw);

    aw.setLocalState({ user: { name: 'me' } });
    setLastUpdated(aw, 0);
    let updates = 0;
    aw.on('update', () => {
      updates += 1;
    });

    clock = 45_000;
    ticker.fire(); // heartbeat not started → inert

    expect(updates).toBe(0);
    const lastUpdated = aw.meta.get(aw.clientID)?.lastUpdated ?? 0;
    expect(clock - lastUpdated).toBeGreaterThanOrEqual(outdatedTimeout);

    aw.destroy();
    doc.destroy();
  });

  it('does not re-stamp an entry that is still fresh', () => {
    const doc = new Y.Doc();
    const aw = new Awareness(doc);

    let clock = 0;
    const ticker = new ManualTicker();
    const heartbeat = new AwarenessHeartbeat(ticker, { now: () => clock });
    heartbeat.setAwareness(aw);
    heartbeat.start();

    aw.setLocalState({ user: { name: 'me' } });
    setLastUpdated(aw, 0);
    let updates = 0;
    aw.on('update', () => {
      updates += 1;
    });

    clock = 5_000; // only 5s elapsed, under the 15s threshold
    ticker.fire();

    expect(updates).toBe(0);

    heartbeat.stop();
    aw.destroy();
    doc.destroy();
  });

  it('is a no-op when nothing is registered or the local state is null', () => {
    const ticker = new ManualTicker();
    const heartbeat = new AwarenessHeartbeat(ticker);
    heartbeat.start();
    expect(() => ticker.fire()).not.toThrow(); // no awareness registered

    const doc = new Y.Doc();
    const aw = new Awareness(doc); // local state null (never published)
    heartbeat.setAwareness(aw);
    expect(() => ticker.fire()).not.toThrow();

    heartbeat.stop();
    aw.destroy();
    doc.destroy();
  });

  it('clearAwareness clears only the current registration', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const awA = new Awareness(docA);
    const awB = new Awareness(docB);

    let clock = 0;
    const ticker = new ManualTicker();
    const heartbeat = new AwarenessHeartbeat(ticker, { now: () => clock });
    heartbeat.setAwareness(awA);
    heartbeat.start();

    awA.setLocalState({ user: { name: 'a' } });
    setLastUpdated(awA, 0);

    // Wrong instance → no-op; awA is still registered and renews when stale.
    heartbeat.clearAwareness(awB);
    clock = 20_000;
    ticker.fire();
    const clockAfterRenew = awA.meta.get(awA.clientID)?.clock ?? -1;
    expect(clockAfterRenew).toBeGreaterThan(0);
    setLastUpdated(awA, 20_000);

    // Correct instance → clears; a later stale tick no longer renews.
    heartbeat.clearAwareness(awA);
    clock = 60_000;
    ticker.fire();
    expect(awA.meta.get(awA.clientID)?.clock).toBe(clockAfterRenew);

    heartbeat.stop();
    awA.destroy();
    awB.destroy();
    docA.destroy();
    docB.destroy();
  });
});
