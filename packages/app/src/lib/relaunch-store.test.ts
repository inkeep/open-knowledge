import { afterEach, describe, expect, mock, test } from 'bun:test';

const store = await import('./relaunch-store');

type RelaunchingCb = (info: { version: string }) => void;
type RelaunchFailedCb = (info: { version: string; message?: string }) => void;

function makeBridge() {
  let relaunching: RelaunchingCb = () => {};
  let relaunchFailed: RelaunchFailedCb = () => {};
  const bridge = {
    onUpdateRelaunching: mock((cb: RelaunchingCb) => {
      relaunching = cb;
      return () => {
        relaunching = () => {};
      };
    }),
    onUpdateRelaunchFailed: mock((cb: RelaunchFailedCb) => {
      relaunchFailed = cb;
      return () => {
        relaunchFailed = () => {};
      };
    }),
  };
  return {
    bridge: bridge as unknown as Parameters<typeof store.attachRelaunchStateSubscribers>[0],
    fireRelaunching: () => relaunching({ version: '9.9.9' }),
    fireRelaunchFailed: () => relaunchFailed({ version: '9.9.9', message: 'aborted' }),
    onRelaunching: bridge.onUpdateRelaunching,
    onRelaunchFailed: bridge.onUpdateRelaunchFailed,
  };
}

afterEach(() => {
  store.resetRelaunchStoreForTest();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('relaunch-store', () => {
  test('flips on relaunching, clears on relaunch-failed, and notifies subscribers', () => {
    const { bridge, fireRelaunching, fireRelaunchFailed } = makeBridge();
    const detach = store.attachRelaunchStateSubscribers(bridge);

    expect(store.getRelaunchInFlightSnapshot()).toBe(false);

    let notifications = 0;
    const unsub = store.subscribeRelaunchInFlight(() => {
      notifications += 1;
    });

    fireRelaunching();
    expect(store.getRelaunchInFlightSnapshot()).toBe(true);
    expect(notifications).toBe(1);

    fireRelaunching();
    expect(notifications).toBe(1);

    fireRelaunchFailed();
    expect(store.getRelaunchInFlightSnapshot()).toBe(false);
    expect(notifications).toBe(2);

    unsub();
    detach();
  });

  test('detach severs the bridge subscriptions so later events are ignored', () => {
    const { bridge, fireRelaunching } = makeBridge();
    const detach = store.attachRelaunchStateSubscribers(bridge);
    detach();

    fireRelaunching();
    expect(store.getRelaunchInFlightSnapshot()).toBe(false);
  });
});

describe('installRelaunchStateBridge', () => {
  test('no-op when window.okDesktop is undefined', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {} as Window & typeof globalThis,
    });
    expect(() => store.installRelaunchStateBridge()).not.toThrow();
  });

  test('subscribes once on the desktop bridge and is idempotent', () => {
    const { bridge, onRelaunching, onRelaunchFailed } = makeBridge();
    const testWindow = {} as Window & typeof globalThis;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
    Object.defineProperty(testWindow, 'okDesktop', { configurable: true, value: bridge });

    store.installRelaunchStateBridge();
    expect(onRelaunching).toHaveBeenCalledTimes(1);
    expect(onRelaunchFailed).toHaveBeenCalledTimes(1);

    store.installRelaunchStateBridge();
    expect(onRelaunching).toHaveBeenCalledTimes(1);
    expect(onRelaunchFailed).toHaveBeenCalledTimes(1);
  });
});
