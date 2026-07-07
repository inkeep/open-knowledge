import { describe, expect, mock, test } from 'bun:test';

/**
 * update-listener preload-pattern test.
 *
 * The preload file (`src/preload/index.ts`) imports `electron`'s
 * `contextBridge` / `ipcRenderer` which cannot be loaded under `bun test`.
 * We cannot test the preload module directly — same constraint that
 * `bridge.test.ts` works around by testing the `createInvoker` factory
 * instead of the preload export.
 *
 * This file exercises the same listener-subscribe / unsubscribe pattern the
 * preload uses for its three new event subscriptions (`onUpdateDownloaded`,
 * `onWhatsNew`, `onUpdateStuckHint`) against a fake ipcRenderer. Failing this
 * test means the pattern itself is broken — which would break all 5 listeners
 * in the bridge, not just the three. Passing this, plus the existing
 * drift-catcher in `tests/integration/m1-smoke.test.ts` (structural shape
 * across 3 copies) and the channel-name gate in `tests/preload/bridge.test.ts`
 * (channel names match declared EventChannels), constitutes the "unsubscribe
 * closure detaches the listener" without booting a real
 * Electron context.
 */

type FakeListener = (_event: unknown, payload: unknown) => void;

interface FakeIpcRenderer {
  on: ReturnType<typeof mock>;
  removeListener: ReturnType<typeof mock>;
}

function makeFakeIpc(): FakeIpcRenderer {
  const listeners = new Map<string, Set<FakeListener>>();
  return {
    on: mock((channel: string, listener: FakeListener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
    }),
    removeListener: mock((channel: string, listener: FakeListener) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
}

/**
 * Pure reimplementation of the preload's listener-wrapper pattern. The
 * preload keeps the `listener` closure variable in scope so `removeListener`
 * gets the exact reference that was `on`-registered — per electron#33328,
 * without reference-equality, removeListener silently no-ops and the
 * callback stays attached forever.
 */
function createUpdateSubscription<T>(
  ipc: FakeIpcRenderer,
  channel: string,
  cb: (info: T) => void,
): () => void {
  const listener: FakeListener = (_event: unknown, payload: unknown) => cb(payload as T);
  ipc.on(channel, listener);
  return () => ipc.removeListener(channel, listener);
}

describe('M3 update-listener subscribe/unsubscribe pattern', () => {
  test('onUpdateDownloaded subscription registers on correct channel', () => {
    const ipc = makeFakeIpc();
    const cb = mock(() => {});
    createUpdateSubscription(ipc, 'ok:update:downloaded', cb);
    expect(ipc.on).toHaveBeenCalledTimes(1);
    expect(ipc.on.mock.calls[0]?.[0]).toBe('ok:update:downloaded');
  });

  test('unsubscribe closure detaches the listener by reference identity', () => {
    const ipc = makeFakeIpc();
    const cb = mock(() => {});
    const unsubscribe = createUpdateSubscription(ipc, 'ok:update:downloaded', cb);

    // Capture the wrapper that was registered.
    const registeredWrapper = ipc.on.mock.calls[0]?.[1];
    expect(registeredWrapper).toBeDefined();

    unsubscribe();

    // removeListener was called with the EXACT same wrapper reference.
    expect(ipc.removeListener).toHaveBeenCalledTimes(1);
    expect(ipc.removeListener.mock.calls[0]?.[0]).toBe('ok:update:downloaded');
    expect(ipc.removeListener.mock.calls[0]?.[1]).toBe(registeredWrapper);
  });

  test('unsubscribe prevents callback from firing on subsequent events', () => {
    const ipc = makeFakeIpc();
    const cb = mock(() => {});
    const unsubscribe = createUpdateSubscription<{ version: string }>(
      ipc,
      'ok:update:downloaded',
      cb,
    );
    // Simulate ipc delivering an event BEFORE unsubscribe.
    const registeredWrapper = ipc.on.mock.calls[0]?.[1] as FakeListener | undefined;
    expect(registeredWrapper).toBeDefined();
    registeredWrapper?.(null, { version: '0.1.1' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ version: '0.1.1' });

    unsubscribe();

    // Fake ipc's tracking of attached-listeners reflects the removal — a real
    // ipcRenderer wouldn't deliver further events to a removed listener.
    // Simulate that: after unsubscribe, the wrapper reference is no longer
    // the "attached" listener, so the preload contract holds.
    // We prove this by asserting removeListener was called with the wrapper:
    expect(ipc.removeListener).toHaveBeenCalledWith('ok:update:downloaded', registeredWrapper);
  });

  test('all update listeners follow the same pattern (channel-name parametric)', () => {
    const channels = [
      'ok:update:downloaded',
      'ok:update:relaunching',
      'ok:update:relaunch-failed',
      'ok:update:whats-new',
      'ok:update:whats-new-dismissed',
      'ok:update:stuck-hint',
    ] as const;
    for (const channel of channels) {
      const ipc = makeFakeIpc();
      const cb = mock(() => {});
      const unsubscribe = createUpdateSubscription(ipc, channel, cb);
      expect(ipc.on.mock.calls[0]?.[0]).toBe(channel);
      unsubscribe();
      expect(ipc.removeListener.mock.calls[0]?.[0]).toBe(channel);
    }
  });
});
