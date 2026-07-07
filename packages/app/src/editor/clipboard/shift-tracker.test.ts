/**
 * Unit tests for the shift-tracker module — the latch that powers the
 * Cmd+Shift+V plain-text escape hatch.
 *
 * `bun test` runs in a Node-ish env with no DOM, so we install a minimal
 * fake `window` + `document` before importing the module. The tracker's
 * listeners attach to `window` at capture phase — we can then dispatch
 * via the fake window's `__dispatch(type, event)` helper.
 *
 * This gives us deterministic coverage of:
 *   - `isShiftHeld()` reflects the latch state set by preceding events.
 *   - `pasteShiftHeld(event)` honors both the latch and the test-injected
 *     `shiftKey` channel (Playwright's Object.defineProperty path).
 *   - Shift keyup + no-modifier keyup + blur all clear the latch.
 *   - `installShiftTracker()` is idempotent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

interface Listener {
  type: string;
  fn: (e: unknown) => void;
}
const listeners: Listener[] = [];

// Fake window with addEventListener/dispatchEvent-like shape.
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

// The tracker does `typeof window === 'undefined'` to bail in SSR. Install
// the fake BEFORE the module imports so ensureAttached wires up its
// listeners to our stub.
const origWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = fakeWindow;

// Dynamic import so the install happens after the fake is in place.
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
  // Clear any residual latch state from the previous test.
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
    // Latch is clear; the test-harness injection is the only signal.
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
    // Listener count is unchanged (same key+fn pair is registered once).
    expect(listeners.length).toBe(before);
  });
});
