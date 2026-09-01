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
    gate();
    expect(calls).toBe(0);
    gate();
    expect(calls).toBe(1);
    gate();
    expect(calls).toBe(2);
    gate();
    expect(calls).toBe(3);
  });

  test('is per-instance — fresh gates start at the cold-boot state', () => {
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
    let calls = 0;
    const gate = createSyncedReconnectGate(() => {
      calls += 1;
    });
    gate();
    expect(calls).toBe(0);
    for (let i = 0; i < 10; i++) gate();
    expect(calls).toBe(10);
  });
});

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
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('network down')),
    ) as unknown as typeof globalThis.fetch;
    const { pool, observed } = createPoolStub();

    await refreshServerInfo(pool);

    expect(observed).toEqual([]);
  });
});
