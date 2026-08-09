/**
 * Unit tests for `createSyncedReconnectGate` — the shared "fire on
 * every `synced` event AFTER the first" wire-up used by both
 * `SystemDocSubscriber` (production) and `attachSystemDocSubscriber`
 * (integration harness).
 *
 * The gate is a small closure but is load-bearing: the production
 * trigger for `refreshServerInfo` on `__system__` reconnect, which
 * is the only recovery path for missed disk-ack frames. Reverting
 * the gate to "always fire" or "never fire" would silently break
 * the late-join recovery contract verified end-to-end.
 *
 * The manual `refreshServerInfo` call structurally can't exercise
 * the gate (dispose + recreate isn't a WebSocket reconnect, so the
 * gate's same-provider-lifetime contract is never observed). These
 * targeted unit tests close the coverage gap by testing the gate
 * directly.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProviderPool } from '../editor/provider-pool';
import { createSyncedReconnectGate, refreshServerInfo } from './server-info-refresh';

vi.mock('../editor/branch-invalidation', () => ({
  handleBranchSwitched: vi.fn(() => Promise.resolve()),
}));
vi.mock('./documents-events', () => ({
  emitBranchChanged: vi.fn(),
  subscribeToBranchChanged: vi.fn(() => () => {}),
}));
vi.mock('./server-instance-store', () => ({
  setServerInstanceId: vi.fn(),
}));

describe('createSyncedReconnectGate', () => {
  test('does NOT fire on the first invocation (cold boot)', () => {
    let calls = 0;
    const gate = createSyncedReconnectGate(() => {
      calls += 1;
    });
    gate();
    expect(calls).toBe(0);
  });

  test('fires on the second and every subsequent invocation', () => {
    let calls = 0;
    const gate = createSyncedReconnectGate(() => {
      calls += 1;
    });
    gate(); // first synced (cold boot)
    expect(calls).toBe(0);
    gate(); // second synced (reconnect)
    expect(calls).toBe(1);
    gate(); // third synced (another reconnect)
    expect(calls).toBe(2);
    gate(); // fourth synced
    expect(calls).toBe(3);
  });

  test('is per-instance — fresh gates start at the cold-boot state', () => {
    // Production semantics: each new HocuspocusProvider gets its own
    // gate, so disposing + recreating a subscriber correctly skips
    // the fresh provider's first synced (covered by the boot fetch
    // in DocumentContext, not the reconnect gate).
    let aCalls = 0;
    let bCalls = 0;
    const gateA = createSyncedReconnectGate(() => {
      aCalls += 1;
    });
    const gateB = createSyncedReconnectGate(() => {
      bCalls += 1;
    });
    gateA();
    gateA();
    gateA();
    gateB();
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(0);
    gateB();
    expect(bCalls).toBe(1);
  });

  test('passes the onReconnect callback through verbatim', () => {
    // The callback receives no args and returns void. Confirms the
    // gate doesn't mangle arguments or swallow return values that
    // future consumers might rely on.
    const sentinel = Symbol('reconnect-fired');
    const fired: unknown[] = [];
    const gate = createSyncedReconnectGate(() => {
      fired.push(sentinel);
    });
    gate();
    gate();
    gate();
    expect(fired).toEqual([sentinel, sentinel]);
  });

  test('regression guard — flipping the gate condition would fail this test', () => {
    // If someone refactors the gate to fire on the FIRST synced
    // (and skip subsequent), the production contract breaks: the
    // boot fetch races with a redundant first-synced refresh, AND
    // every actual reconnect silently drops its refresh.
    //
    // This test pins the contract: first call = no-op, subsequent
    // calls = fire. The single-call zero and multi-call non-zero
    // is the structural assertion.
    let calls = 0;
    const gate = createSyncedReconnectGate(() => {
      calls += 1;
    });
    gate();
    expect(calls).toBe(0); // first call is the cold-boot skip
    for (let i = 0; i < 10; i++) gate();
    expect(calls).toBe(10); // every subsequent call fires
  });
});

/**
 * `refreshServerInfo` is what the pool runs when the server rejects a connect
 * with `branch-mismatch`. It is the ONLY thing that stops the pool re-claiming
 * a branch the server has already disagreed with: the claim is read from
 * `localStorage` on every auth token, so without adoption the client would
 * re-offer the same rejected value on every reconnect forever.
 */
describe('refreshServerInfo — branch adoption', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  function stubServerInfo(body: Record<string, unknown>) {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response),
    ) as unknown as typeof globalThis.fetch;
  }

  function createPoolStub() {
    const observed: string[] = [];
    const pool = {
      setExpectedServerInstanceId: vi.fn(),
      compareAndUpdateObservedBranch: vi.fn((branch: string) => {
        observed.push(branch);
        return true;
      }),
      observeDiskAckBatch: vi.fn(),
    };
    return { pool: pool as unknown as ProviderPool, observed, spies: pool };
  }

  test('adopts the branch the server reports', async () => {
    stubServerInfo({ serverInstanceId: 'srv-1', currentBranch: 'master' });
    const { pool, observed, spies } = createPoolStub();

    await refreshServerInfo(pool);

    expect(observed).toEqual(['master']);
    expect(spies.setExpectedServerInstanceId).toHaveBeenCalledWith('srv-1');
  });

  test('adopts nothing when the endpoint is unreachable', async () => {
    // The claim stays as-is and the next reconnect retries — silently
    // overwriting it with a guess would be worse than re-offering it.
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('network down')),
    ) as unknown as typeof globalThis.fetch;
    const { pool, observed } = createPoolStub();

    await refreshServerInfo(pool);

    expect(observed).toEqual([]);
  });
});
