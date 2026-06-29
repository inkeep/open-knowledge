import { describe, expect, test } from 'bun:test';
import { createSyncedReconnectGate } from './server-info-refresh';

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
    expect(calls).toBe(0); // first call is the cold-boot skip
    for (let i = 0; i < 10; i++) gate();
    expect(calls).toBe(10); // every subsequent call fires
  });
});
