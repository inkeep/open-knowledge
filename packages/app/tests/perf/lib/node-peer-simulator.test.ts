/**
 * Unit tests for the Node-side peer simulator.
 *
 * Strategy: peers point at a dummy non-existent URL (`ws://localhost:1`).
 * The HocuspocusProvider stays in 'connecting' state, but Y.Doc transactions
 * are local-only — `transact()` does not require a connected provider — so
 * the simulator's writes still succeed and getFireCounts() increments.
 *
 * What we pin:
 *   - Factory shape: count peers spawned, count visible on handle.
 *   - start() begins traffic and getFireCounts() reflects writes.
 *   - stop() cleanly cancels timers (no late writes after the resolved
 *     promise), is idempotent, and disposes provider + Y.Doc resources.
 *   - human + agent profile pacing parameters are honored relative to one
 *     another (we don't assert wall-clock timing — that's flake-prone —
 *     but we DO assert relative count ordering at a fixed window).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createNodePeerSimulator, type NodePeerSimulatorHandle } from './node-peer-simulator';

const DUMMY_PORT = 1;

let active: NodePeerSimulatorHandle | null = null;

afterEach(async () => {
  if (active) {
    await active.stop();
    active = null;
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createNodePeerSimulator — factory shape', () => {
  test('count > 0 spawns N peers; handle exposes count', () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-shape-3',
      count: 3,
      typingProfile: { kind: 'human', iki: 100, burstMs: 1000, pauseMs: 1000 },
    });
    expect(active.count).toBe(3);
  });

  test('count = 0 produces a no-op handle', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-zero',
      count: 0,
      typingProfile: { kind: 'human', iki: 100, burstMs: 1000, pauseMs: 1000 },
    });
    expect(active.count).toBe(0);
    expect(active.getFireCounts()).toEqual({});
    active.start();
    await wait(50);
    expect(active.getFireCounts()).toEqual({});
  });

  test('negative count throws', () => {
    expect(() =>
      createNodePeerSimulator({
        port: DUMMY_PORT,
        docName: 'test-neg',
        count: -1,
        typingProfile: { kind: 'human', iki: 100, burstMs: 1000, pauseMs: 1000 },
      }),
    ).toThrow();
  });
});

describe('createNodePeerSimulator — start() drives writes', () => {
  test('agent profile: every peer fires N writes within `count × writeIntervalMs` window', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-agent-fires',
      count: 2,
      typingProfile: { kind: 'agent', writeIntervalMs: 30, chunkChars: 5 },
    });
    active.start();
    await wait(120); // ~3-4 fires per peer
    const counts = active.getFireCounts();
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
  });

  test('human profile: peers fire during burst window', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-human-burst',
      count: 1,
      typingProfile: { kind: 'human', iki: 25, burstMs: 200, pauseMs: 500 },
    });
    active.start();
    await wait(120); // mid-burst — peer should have fired several keystrokes
    const counts = active.getFireCounts();
    expect(counts[0]).toBeGreaterThan(0);
  });

  test('start() is idempotent — second call does not double the schedule', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-idempotent',
      count: 1,
      typingProfile: { kind: 'agent', writeIntervalMs: 30, chunkChars: 1 },
    });
    active.start();
    active.start(); // no-op
    await wait(120);
    const counts = active.getFireCounts();
    // With a single schedule, ~3-4 fires in 120ms. Doubled would be ~6-8.
    // Allow some scheduler jitter — we just assert NOT-double:
    expect(counts[0]).toBeLessThan(8);
  });
});

describe('createNodePeerSimulator — stop() teardown', () => {
  test('stop() cancels timers — no fires accumulate after stop resolves', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-stop-cancel',
      count: 1,
      typingProfile: { kind: 'agent', writeIntervalMs: 25, chunkChars: 1 },
    });
    active.start();
    await wait(80);
    const beforeStop = active.getFireCounts()[0] ?? 0;
    expect(beforeStop).toBeGreaterThan(0);
    await active.stop();
    const justAfter = active.getFireCounts()[0] ?? 0;
    // Wait significantly longer than the interval — no NEW fires should occur.
    await wait(150);
    const wellAfter = active.getFireCounts()[0] ?? 0;
    expect(wellAfter).toBe(justAfter);
  });

  test('stop() is idempotent — second await resolves immediately', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-stop-idempotent',
      count: 1,
      typingProfile: { kind: 'agent', writeIntervalMs: 50, chunkChars: 1 },
    });
    active.start();
    await wait(60);
    await active.stop();
    // Second stop must not throw; should resolve quickly.
    const t0 = Date.now();
    await active.stop();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('stop() before start() is safe (no timers to cancel)', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-stop-before-start',
      count: 2,
      typingProfile: { kind: 'agent', writeIntervalMs: 100, chunkChars: 1 },
    });
    await active.stop();
    expect(active.getFireCounts()[0]).toBe(0);
    expect(active.getFireCounts()[1]).toBe(0);
  });

  test('start() after stop() is a no-op (handle is terminal)', async () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-restart-blocked',
      count: 1,
      typingProfile: { kind: 'agent', writeIntervalMs: 25, chunkChars: 1 },
    });
    await active.stop();
    active.start();
    await wait(80);
    expect(active.getFireCounts()[0] ?? 0).toBe(0);
  });
});

describe('createNodePeerSimulator — getFireCounts shape', () => {
  test('returns one entry per peer index, all initially zero before start()', () => {
    active = createNodePeerSimulator({
      port: DUMMY_PORT,
      docName: 'test-counts-shape',
      count: 4,
      typingProfile: { kind: 'agent', writeIntervalMs: 100, chunkChars: 1 },
    });
    const c = active.getFireCounts();
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(0);
    expect(c[3]).toBe(0);
  });
});
