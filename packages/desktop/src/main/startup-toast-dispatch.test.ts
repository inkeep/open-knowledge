import { describe, expect, test, vi } from 'vitest';
import {
  dispatchStartupToastAcrossLoads,
  STARTUP_TOAST_REDELIVERY_WINDOW_MS,
  type StartupToastPayload,
  type StartupToastWindow,
} from './startup-toast-dispatch.ts';

const PAYLOAD: StartupToastPayload = {
  kind: 'startup-reclaim',
  mcp: {
    status: 'failed',
    failures: [{ editor: 'cursor', reason: 'EACCES' }],
    repaired: ['claude'],
  },
  path: { status: 'none' },
};

function fakeWindow(opts: { loading?: boolean } = {}) {
  const loadListeners = new Set<() => void>();
  const closedListeners = new Set<() => void>();
  let loading = opts.loading ?? false;
  let destroyed = false;
  const send = vi.fn();
  const win: StartupToastWindow = {
    isDestroyed: () => destroyed,
    webContents: {
      isLoading: () => loading,
      isDestroyed: () => destroyed,
      send,
      on: (_event, listener) => loadListeners.add(listener),
      off: (_event, listener) => loadListeners.delete(listener),
    },
    once: (_event, listener) => closedListeners.add(listener),
  };
  return {
    win,
    send,
    finishLoad: () => {
      loading = false;
      for (const listener of loadListeners) listener();
    },
    close: () => {
      destroyed = true;
      for (const listener of closedListeners) listener();
    },
    loadListenerCount: () => loadListeners.size,
  };
}

function harness(windows: StartupToastWindow[] = []) {
  let clock = 1_000;
  const created = new Set<(win: StartupToastWindow) => void>();
  const timers: { fn: () => void; ms: number }[] = [];
  const warn = vi.fn();
  const deps = {
    getAllWindows: () => windows,
    onWindowCreated: (listener: (win: StartupToastWindow) => void) => {
      created.add(listener);
      return () => created.delete(listener);
    },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    now: () => clock,
    warn,
  };
  return {
    deps,
    warn,
    advance: (ms: number) => {
      clock += ms;
    },
    createWindow: (win: StartupToastWindow) => {
      for (const listener of created) listener(win);
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer.fn();
    },
    createdListenerCount: () => created.size,
  };
}

describe('dispatchStartupToastAcrossLoads', () => {
  test('a window that is already loaded gets the payload once', () => {
    const first = fakeWindow();
    const h = harness([first.win]);
    const handle = dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenCalledWith('ok:onboarding:toast', PAYLOAD);
    expect(handle.deliveries()).toBe(1);
  });

  test('a window still loading gets the payload on did-finish-load, not before', () => {
    const first = fakeWindow({ loading: true });
    const h = harness([first.win]);
    dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    expect(first.send).not.toHaveBeenCalled();
    first.finishLoad();
    expect(first.send).toHaveBeenCalledTimes(1);
  });

  test('the same window loading a new document within the window is served again', () => {
    const first = fakeWindow();
    const h = harness([first.win]);
    dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    h.advance(6_000);
    first.finishLoad();
    expect(first.send).toHaveBeenCalledTimes(2);
  });

  test('a window created after the first one closes is served on its first load', () => {
    const first = fakeWindow();
    const h = harness([first.win]);
    dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    const second = fakeWindow({ loading: true });
    h.advance(6_000);
    h.createWindow(second.win);
    first.close();
    expect(second.send).not.toHaveBeenCalled();
    second.finishLoad();
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(first.loadListenerCount()).toBe(0);
  });

  test('loads after the redelivery window get nothing and every listener is detached', () => {
    const first = fakeWindow();
    const h = harness([first.win]);
    dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    h.advance(STARTUP_TOAST_REDELIVERY_WINDOW_MS + 1);
    first.finishLoad();
    expect(first.send).toHaveBeenCalledTimes(1);
    h.fireTimers();
    expect(first.loadListenerCount()).toBe(0);
    expect(h.createdListenerCount()).toBe(0);
    const late = fakeWindow();
    h.createWindow(late.win);
    expect(late.send).not.toHaveBeenCalled();
  });

  test('a send that throws is warned about and does not block other windows', () => {
    const broken = fakeWindow();
    broken.send.mockImplementation(() => {
      throw new Error('channel closed');
    });
    const healthy = fakeWindow();
    const h = harness([broken.win, healthy.win]);
    const handle = dispatchStartupToastAcrossLoads(PAYLOAD, h.deps);
    expect(h.warn).toHaveBeenCalledWith('[main] startup reclaim toast send failed', {
      err: expect.objectContaining({ message: 'channel closed' }),
    });
    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect(handle.deliveries()).toBe(1);
  });
});
