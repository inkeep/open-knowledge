import { describe, expect, mock, test } from 'bun:test';
import type { KeyringSmokeResult } from '../utility/keyring-smoke.ts';
import { createDebugIpc } from './debug-ipc.ts';

function fakeUtility() {
  const posted: Array<{ type: string; correlationId?: string }> = [];
  return {
    postMessage: mock((m: unknown) => {
      posted.push(m as { type: string; correlationId?: string });
    }),
    get posted() {
      return posted;
    },
  };
}

function makeResult(overrides: Partial<KeyringSmokeResult> = {}): KeyringSmokeResult {
  return {
    ok: true,
    backend: 'keyring',
    durationMs: 12,
    timestamp: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('createDebugIpc', () => {
  test('happy path: posts smoke request and resolves with matching result', async () => {
    const utility = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
    });

    const promise = ipc.requestKeyringSmoke({});
    expect(utility.posted).toHaveLength(1);
    const posted = utility.posted[0];
    expect(posted?.type).toBe('debug-keyring-smoke');
    expect(typeof posted?.correlationId).toBe('string');

    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: posted?.correlationId,
      result: makeResult(),
    });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(ipc.pendingSize()).toBe(0);
  });

  test('gate closed: rejects with disabled-in-production error, does not post', async () => {
    const utility = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => false,
    });
    await expect(ipc.requestKeyringSmoke({})).rejects.toThrow(
      'debug-channel disabled in production',
    );
    expect(utility.posted).toHaveLength(0);
  });

  test('no utility for sender: rejects with informative error', async () => {
    const ipc = createDebugIpc({
      resolveUtility: () => null,
      isDebugAllowed: () => true,
    });
    await expect(ipc.requestKeyringSmoke({})).rejects.toThrow('no utility process');
    expect(ipc.pendingSize()).toBe(0);
  });

  test('timeout: rejects and removes pending entry (leak-free)', async () => {
    const utility = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
      timeoutMs: 15,
    });
    const promise = ipc.requestKeyringSmoke({});
    expect(ipc.pendingSize()).toBe(1);
    await expect(promise).rejects.toThrow(/timed out after 15ms/);
    expect(ipc.pendingSize()).toBe(0);
  });

  test('concurrent calls resolve independently by correlationId', async () => {
    const utility = fakeUtility();
    let counter = 0;
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
      generateCorrelationId: () => `corr-${++counter}`,
    });

    const p1 = ipc.requestKeyringSmoke({});
    const p2 = ipc.requestKeyringSmoke({});
    expect(utility.posted).toHaveLength(2);
    expect(ipc.pendingSize()).toBe(2);
    expect(utility.posted.map((m) => m.correlationId)).toEqual(['corr-1', 'corr-2']);

    // Reply to p2 first
    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'corr-2',
      result: makeResult({ durationMs: 222 }),
    });
    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'corr-1',
      result: makeResult({ durationMs: 111 }),
    });

    expect((await p1).durationMs).toBe(111);
    expect((await p2).durationMs).toBe(222);
    expect(ipc.pendingSize()).toBe(0);
  });

  test('unknown correlationId from utility is ignored (silently dropped)', async () => {
    const utility = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
    });
    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'nonexistent',
      result: makeResult(),
    });
    expect(ipc.pendingSize()).toBe(0);
  });

  test('malformed utility message is a no-op (no throw)', () => {
    const utility = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
    });
    expect(() => ipc.handleUtilityMessage(null)).not.toThrow();
    expect(() => ipc.handleUtilityMessage({ type: 'unrelated' })).not.toThrow();
    expect(() => ipc.handleUtilityMessage({ type: 'debug-keyring-smoke-result' })).not.toThrow();
    expect(ipc.pendingSize()).toBe(0);
  });

  test('postMessage throw is caught and surfaced as rejection', async () => {
    const utility = {
      postMessage: mock(() => {
        throw new Error('IPC port closed');
      }),
    };
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
    });
    await expect(ipc.requestKeyringSmoke({})).rejects.toThrow('IPC port closed');
    expect(ipc.pendingSize()).toBe(0);
  });

  test('returns propagated error result when utility reports ok:false', async () => {
    const utility = fakeUtility();
    let counter = 0;
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
      generateCorrelationId: () => `id-${++counter}`,
    });
    const promise = ipc.requestKeyringSmoke({});
    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'id-1',
      result: makeResult({ ok: false, error: 'module not found', backend: undefined }),
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('module not found');
  });

  test('cancelPendingForUtility rejects all in-flight requests for that utility', async () => {
    const utility = fakeUtility();
    let counter = 0;
    const ipc = createDebugIpc({
      resolveUtility: () => utility,
      isDebugAllowed: () => true,
      generateCorrelationId: () => `id-${++counter}`,
    });
    // Attach catch handlers eagerly — `cancelPendingForUtility` resolves the
    // rejections synchronously, so bun's unhandled-rejection tripwire fires
    // if we let the promises float without handlers even for one microtask.
    // Real callers always have an await/catch in their flow (renderer's
    // ipcRenderer.invoke); this test setup replicates that discipline.
    const p1 = ipc.requestKeyringSmoke({}).catch((e) => e);
    const p2 = ipc.requestKeyringSmoke({}).catch((e) => e);
    expect(ipc.pendingSize()).toBe(2);

    ipc.cancelPendingForUtility(utility);

    expect((await p1).message).toMatch(/utility exited before replying/);
    expect((await p2).message).toMatch(/utility exited before replying/);
    expect(ipc.pendingSize()).toBe(0);
  });

  test('cancelPendingForUtility leaves other utilities untouched', async () => {
    const utilityA = fakeUtility();
    const utilityB = fakeUtility();
    let counter = 0;
    const senders = { a: { id: 'a' }, b: { id: 'b' } };
    const ipc = createDebugIpc({
      resolveUtility: (sender) => ((sender as { id: string }).id === 'a' ? utilityA : utilityB),
      isDebugAllowed: () => true,
      generateCorrelationId: () => `id-${++counter}`,
    });
    // Same eager catch discipline as the cancel test above — the cancelled
    // utilityA promise rejects synchronously from cancelPendingForUtility.
    const pA = ipc.requestKeyringSmoke(senders.a).catch((e) => e);
    const pB = ipc.requestKeyringSmoke(senders.b);

    ipc.cancelPendingForUtility(utilityA);

    expect((await pA).message).toMatch(/utility exited before replying/);
    expect(ipc.pendingSize()).toBe(1);

    ipc.handleUtilityMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'id-2',
      result: makeResult({ durationMs: 123 }),
    });
    await expect(pB).resolves.toMatchObject({ durationMs: 123 });
    expect(ipc.pendingSize()).toBe(0);
  });

  test('cancelPendingForUtility is a no-op when utility has no pending entries', () => {
    const utilityA = fakeUtility();
    const utilityB = fakeUtility();
    const ipc = createDebugIpc({
      resolveUtility: () => utilityA,
      isDebugAllowed: () => true,
    });
    expect(() => ipc.cancelPendingForUtility(utilityB)).not.toThrow();
    expect(ipc.pendingSize()).toBe(0);
  });
});
