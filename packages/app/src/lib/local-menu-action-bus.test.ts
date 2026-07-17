import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { OkMenuAction } from './desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
  subscribeLocalMenuAction,
} from './local-menu-action-bus';

describe('local menu-action bus', () => {
  afterEach(() => {
    __resetLocalMenuActionBusForTests();
  });

  test('emit reaches every subscriber exactly once (no double-fire)', () => {
    const a = mock(() => {});
    const b = mock(() => {});
    subscribeLocalMenuAction(a);
    subscribeLocalMenuAction(b);

    emitLocalMenuAction('toggle-sidebar');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenLastCalledWith('toggle-sidebar');
    expect(b).toHaveBeenLastCalledWith('toggle-sidebar');
  });

  test('the same handler subscribed once fires once per emit', () => {
    const handler = mock(() => {});
    subscribeLocalMenuAction(handler);

    emitLocalMenuAction('new-terminal');
    emitLocalMenuAction('new-terminal');

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('unsubscribe stops delivery to that handler only', () => {
    const kept = mock(() => {});
    const dropped = mock(() => {});
    subscribeLocalMenuAction(kept);
    const unsubscribe = subscribeLocalMenuAction(dropped);

    unsubscribe();
    emitLocalMenuAction('duplicate');

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(0);
  });

  test('a handler that unsubscribes itself mid-dispatch still lets siblings run', () => {
    const order: string[] = [];
    let unsub: (() => void) | null = null;
    const first = mock(() => {
      order.push('first');
      unsub?.();
    });
    const second = mock(() => {
      order.push('second');
    });
    unsub = subscribeLocalMenuAction(first);
    subscribeLocalMenuAction(second);

    emitLocalMenuAction('rename');

    expect(order).toEqual(['first', 'second']);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a throwing subscriber does not block delivery to later subscribers', () => {
    const originalConsoleError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;
    try {
      const order: string[] = [];
      subscribeLocalMenuAction(() => {
        order.push('thrower');
        throw new Error('subscriber bug');
      });
      subscribeLocalMenuAction(() => {
        order.push('sibling');
      });

      expect(() => emitLocalMenuAction('rename')).not.toThrow();
      expect(order).toEqual(['thrower', 'sibling']);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('emitting with no subscribers is a no-op', () => {
    expect(() => emitLocalMenuAction('report-bug')).not.toThrow();
  });
});

// The forwarder path reads `window.okDesktop`, absent in this non-DOM unit env.
// These tests stub it and MUST restore `globalThis.window` afterward — a leaked
// stub breaks unrelated non-DOM tests on Linux CI.
describe('local menu-action bus — bridge forwarder', () => {
  const originalWindow = globalThis.window;

  function setDesktop(okDesktop: unknown): void {
    globalThis.window = { okDesktop } as unknown as Window & typeof globalThis;
  }

  afterEach(() => {
    __resetLocalMenuActionBusForTests();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  test('a single inbound native menu action fires each handler exactly once', () => {
    let inbound: ((action: OkMenuAction) => void) | null = null;
    setDesktop({
      onMenuAction: (cb: (action: OkMenuAction) => void) => {
        inbound = cb;
        return () => {};
      },
    });

    const handler = mock(() => {});
    subscribeLocalMenuAction(handler);
    // The forwarder installed exactly one bridge listener.
    expect(inbound).not.toBeNull();
    // One inbound native action → exactly one handler invocation (no double-fire).
    inbound?.('toggle-sidebar');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenLastCalledWith('toggle-sidebar');
  });

  test('the forwarder installs once (ref-counted) and tears down when the last subscriber leaves', () => {
    let installs = 0;
    const unsubscribe = mock(() => {});
    setDesktop({
      onMenuAction: () => {
        installs += 1;
        return unsubscribe;
      },
    });

    const off1 = subscribeLocalMenuAction(() => {});
    const off2 = subscribeLocalMenuAction(() => {});
    // One forwarder shared across subscribers, not one per subscriber.
    expect(installs).toBe(1);
    off1();
    expect(unsubscribe).toHaveBeenCalledTimes(0); // one subscriber remains
    off2();
    expect(unsubscribe).toHaveBeenCalledTimes(1); // last out → forwarder torn down
  });

  test('a partial bridge without onMenuAction never throws; direct emits still deliver', () => {
    setDesktop({}); // truthy-but-thin host (session-only / test stub)
    const handler = mock(() => {});
    expect(() => subscribeLocalMenuAction(handler)).not.toThrow();
    emitLocalMenuAction('rename');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
