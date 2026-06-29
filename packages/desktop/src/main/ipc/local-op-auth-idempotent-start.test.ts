import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthEvent, CloneEvent } from '@inkeep/open-knowledge-server';

interface DeviceFlowEntry {
  resolve: () => void;
  cancelCalled: boolean;
  onEvent: (event: AuthEvent) => void;
}
interface CloneEntry {
  resolve: () => void;
  cancelCalled: boolean;
  onEvent: (event: CloneEvent) => void;
}

const deviceFlowControllers: DeviceFlowEntry[] = [];
const cloneControllers: CloneEntry[] = [];

mock.module('@inkeep/open-knowledge-server', () => ({
  runAuthStatusSubprocess: () => Promise.resolve({ authenticated: false, host: 'github.com' }),
  runAuthReposSubprocess: () => Promise.resolve({ ok: false, error: 'unused' }),
  runDeviceFlowSubprocess: ({ onEvent }: { onEvent: (event: AuthEvent) => void }) => {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: DeviceFlowEntry = { resolve: resolveDone, cancelCalled: false, onEvent };
    deviceFlowControllers.push(entry);
    return {
      done,
      cancel: () => {
        entry.cancelCalled = true;
      },
    };
  },
  runCloneSubprocess: ({ onEvent }: { onEvent: (event: CloneEvent) => void }) => {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: CloneEntry = { resolve: resolveDone, cancelCalled: false, onEvent };
    cloneControllers.push(entry);
    return {
      done,
      cancel: () => {
        entry.cancelCalled = true;
      },
    };
  },
  validateCloneInputs: () => validateResult,
}));

let validateResult: { ok: true } | { ok: false; reason: 'invalid-url' | 'invalid-dir' } = {
  ok: true,
};

const {
  createLocalOpState,
  handleAuthStart,
  handleAuthCancel,
  handleCloneStart,
  handleCloneCancel,
} = await import('./local-op.ts');

function makeSender() {
  return {
    isDestroyed: () => false,
    send: () => {},
  };
}

function makeDeps() {
  return {
    resolveCliArgs: () => ['open-knowledge'],
    state: createLocalOpState(),
  };
}

const CLONE_REQ = { url: 'https://example.test/r.git', dir: '/tmp/r' };

beforeEach(() => {
  deviceFlowControllers.length = 0;
  cloneControllers.length = 0;
  validateResult = { ok: true };
});

describe('handleAuthStart idempotent against stale slot', () => {
  test('A1: second start without intervening cancel auto-cancels stale flow and claims fresh slot', () => {
    const deps = makeDeps();

    const first = handleAuthStart(deps, makeSender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const staleController = deviceFlowControllers[0];
    expect(staleController).toBeDefined();
    expect(deps.state.authInFlight?.streamId).toBe(first.streamId);


    const second = handleAuthStart(deps, makeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.streamId).not.toBe(first.streamId);

    expect(staleController?.cancelCalled).toBe(true);

    expect(deps.state.authInFlight?.streamId).toBe(second.streamId);
  });

  test('A1b: stale subprocess `done` resolution does not evict the new slot (.finally streamId guard)', async () => {
    const deps = makeDeps();

    const first = handleAuthStart(deps, makeSender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = handleAuthStart(deps, makeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    deviceFlowControllers[0]?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deps.state.authInFlight?.streamId).toBe(second.streamId);
  });

  test('A2: explicit cancel before next start still works (regression pin)', () => {
    const deps = makeDeps();

    const first = handleAuthStart(deps, makeSender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    handleAuthCancel(deps, first.streamId);
    expect(deps.state.authInFlight).toBeNull();
    expect(deviceFlowControllers[0]?.cancelCalled).toBe(true);

    const second = handleAuthStart(deps, makeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(deps.state.authInFlight?.streamId).toBe(second.streamId);
  });

  test('A3: cancel of a stale streamId is a no-op (does not clear current slot)', () => {
    const deps = makeDeps();

    const first = handleAuthStart(deps, makeSender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    handleAuthCancel(deps, first.streamId);
    expect(deps.state.authInFlight).toBeNull();

    const second = handleAuthStart(deps, makeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    handleAuthCancel(deps, first.streamId);
    expect(deps.state.authInFlight?.streamId).toBe(second.streamId);
  });
});

describe('handleCloneStart idempotent against stale slot', () => {
  test('B1: second clone start without intervening cancel auto-cancels stale flow and claims fresh slot', () => {
    const deps = makeDeps();

    const first = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const staleController = cloneControllers[0];
    expect(staleController).toBeDefined();
    expect(deps.state.cloneInFlight?.streamId).toBe(first.streamId);

    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.streamId).not.toBe(first.streamId);
    expect(staleController?.cancelCalled).toBe(true);
    expect(deps.state.cloneInFlight?.streamId).toBe(second.streamId);
  });

  test('B1b: stale clone subprocess `done` resolution does not evict the new slot (.finally streamId guard)', async () => {
    const deps = makeDeps();

    const first = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    cloneControllers[0]?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deps.state.cloneInFlight?.streamId).toBe(second.streamId);
  });

  test('B2: explicit clone cancel before next start still works (regression pin)', () => {
    const deps = makeDeps();

    const first = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    handleCloneCancel(deps, first.streamId);
    expect(deps.state.cloneInFlight).toBeNull();
    expect(cloneControllers[0]?.cancelCalled).toBe(true);

    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(deps.state.cloneInFlight?.streamId).toBe(second.streamId);
  });

  test('B3: clone cancel of a stale streamId is a no-op (does not clear current slot)', () => {
    const deps = makeDeps();

    const first = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    handleCloneCancel(deps, first.streamId);
    expect(deps.state.cloneInFlight).toBeNull();

    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    handleCloneCancel(deps, first.streamId);
    expect(deps.state.cloneInFlight?.streamId).toBe(second.streamId);
  });

  test('B-invalid: invalid clone request does NOT displace stale slot (validate-before-displace ordering)', () => {
    const deps = makeDeps();

    const first = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const staleSlot = deps.state.cloneInFlight;
    expect(staleSlot?.streamId).toBe(first.streamId);
    const staleEntry = cloneControllers[0];
    expect(staleEntry?.cancelCalled).toBe(false);

    validateResult = { ok: false, reason: 'invalid-url' };
    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('URL protocol not allowed');
    expect(deps.state.cloneInFlight?.streamId).toBe(first.streamId);
    expect(staleEntry?.cancelCalled).toBe(false);
    expect(cloneControllers.length).toBe(1);
  });
});
