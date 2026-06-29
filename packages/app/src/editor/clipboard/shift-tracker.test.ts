
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

interface Listener {
  type: string;
  fn: (e: unknown) => void;
}
const listeners: Listener[] = [];

const fakeWindow = {
  addEventListener(type: string, fn: (e: unknown) => void, _opts?: unknown) {
    listeners.push({ type, fn });
  },
  removeEventListener(type: string, fn: (e: unknown) => void) {
    const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (idx >= 0) listeners.splice(idx, 1);
  },
  __dispatch(type: string, event: unknown) {
    for (const l of listeners) {
      if (l.type === type) l.fn(event);
    }
  },
};

const origWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = fakeWindow;

// biome-ignore lint/suspicious/noExplicitAny: dynamic module surface for tests
let mod: any;

beforeAll(async () => {
  mod = await import('./shift-tracker.ts');
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = origWindow;
});

beforeEach(() => {
  mod.installShiftTracker();
  fakeWindow.__dispatch('keyup', { key: 'Shift', shiftKey: false });
});

describe('shift-tracker', () => {
  test('isShiftHeld returns false when no Shift event has fired', () => {
    expect(mod.isShiftHeld()).toBe(false);
  });

  test('keydown with shiftKey=true latches the tracker', () => {
    fakeWindow.__dispatch('keydown', { key: 'Shift', shiftKey: true });
    expect(mod.isShiftHeld()).toBe(true);
  });

  test('keyup on Shift itself clears the latch', () => {
    fakeWindow.__dispatch('keydown', { key: 'Shift', shiftKey: true });
    expect(mod.isShiftHeld()).toBe(true);
    fakeWindow.__dispatch('keyup', { key: 'Shift', shiftKey: false });
    expect(mod.isShiftHeld()).toBe(false);
  });

  test('keyup on any key reporting no-modifier state clears the latch', () => {
    fakeWindow.__dispatch('keydown', { key: 'Shift', shiftKey: true });
    expect(mod.isShiftHeld()).toBe(true);
    fakeWindow.__dispatch('keyup', { key: 'a', shiftKey: false });
    expect(mod.isShiftHeld()).toBe(false);
  });

  test('blur clears the latch (Alt+Tab-while-Shift-held recovery)', () => {
    fakeWindow.__dispatch('keydown', { key: 'Shift', shiftKey: true });
    expect(mod.isShiftHeld()).toBe(true);
    fakeWindow.__dispatch('blur', {});
    expect(mod.isShiftHeld()).toBe(false);
  });

  test('pasteShiftHeld returns true when the latch is set', () => {
    fakeWindow.__dispatch('keydown', { key: 'Shift', shiftKey: true });
    const evt = {} as unknown as ClipboardEvent;
    expect(mod.pasteShiftHeld(evt)).toBe(true);
  });

  test('pasteShiftHeld returns true when the event carries a Playwright-injected shiftKey', () => {
    const evt = {} as { shiftKey?: boolean };
    evt.shiftKey = true;
    expect(mod.pasteShiftHeld(evt as unknown as ClipboardEvent)).toBe(true);
  });

  test('pasteShiftHeld returns false when neither channel is set', () => {
    const evt = {} as unknown as ClipboardEvent;
    expect(mod.pasteShiftHeld(evt)).toBe(false);
  });

  test('installShiftTracker is idempotent — multiple calls do not double-register', () => {
    const before = listeners.length;
    mod.installShiftTracker();
    mod.installShiftTracker();
    mod.installShiftTracker();
    expect(listeners.length).toBe(before);
  });
});
