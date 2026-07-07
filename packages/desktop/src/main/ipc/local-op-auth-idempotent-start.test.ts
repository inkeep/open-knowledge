/**
 * Tests for the idempotent `:start` contract on the auth + clone IPC slot
 * lifecycles.
 *
 * Contract: when the renderer-side cancel-IPC fails to fire (modal cleanup
 * race, IPC drop, Radix Presence never unmounts the dialog, etc.), the
 * next `handleAuthStart` / `handleCloneStart` MUST atomically cancel the
 * stale flow and claim a fresh slot. Without this contract, the stale
 * slot pins until the CLI subprocess's wall-clock timeout (10 min)
 * clears it and the user is locked out of retry.
 *
 * The auth and clone suites both pin the foundational displacement
 * contract, plus the `.finally()` streamId guard that prevents the
 * stale subprocess's delayed `done` resolution from clobbering the new
 * slot. The remaining cases are regression pins for the explicit-cancel
 * happy path and the streamId-mismatch guard in handleAuthCancel /
 * handleCloneCancel.
 */
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
        // Mirror production: cancel sends SIGTERM; the subprocess exits a
        // tick later and resolves `done` then. Leave `done` pending so we
        // observe the synchronous slot-release contract independently of
        // subprocess exit timing.
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

// Mutable per-test override for the validateCloneInputs mock. Default `ok: true`
// keeps every existing test (which exercises slot-lifecycle behavior, not validation)
// unaffected. B-invalid flips this to assert validate-before-displace ordering.
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

    // Simulate the bug: renderer-side cleanup never fired, so no
    // handleAuthCancel runs between starts.

    const second = handleAuthStart(deps, makeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Fresh streamId — slot was atomically replaced.
    expect(second.streamId).not.toBe(first.streamId);

    // Stale subprocess was sent SIGTERM (observable side effect of cancel).
    expect(staleController?.cancelCalled).toBe(true);

    // Slot now tracks the new flow, not the stale one.
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

    // The stale subprocess exits AFTER displacement — its `done.finally`
    // fires asynchronously. Without the streamId guard in the
    // `controller.done.finally` hook, the stale `done` resolution would
    // null the new slot.
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

    // Cancel using the FIRST (now-stale) streamId — must not affect the
    // active second slot.
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

    // The stale subprocess exits AFTER displacement — its `done.finally`
    // fires asynchronously. Without the streamId guard in the
    // `controller.done.finally` hook, the stale `done` resolution would
    // null the new slot.
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

    // Second start with invalid validation result. handleCloneStart MUST
    // reject this request BEFORE touching the in-flight slot — otherwise
    // a typo'd URL in a user's retry would silently kill the running
    // clone they wanted to keep.
    validateResult = { ok: false, reason: 'invalid-url' };
    const second = handleCloneStart(deps, makeSender(), CLONE_REQ);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('URL protocol not allowed');
    // Slot still tracks the original flow; stale controller was NOT cancelled.
    expect(deps.state.cloneInFlight?.streamId).toBe(first.streamId);
    expect(staleEntry?.cancelCalled).toBe(false);
    // No second subprocess was spawned — validate-then-displace, not the reverse.
    expect(cloneControllers.length).toBe(1);
  });
});
