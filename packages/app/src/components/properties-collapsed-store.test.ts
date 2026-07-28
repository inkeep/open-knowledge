import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPropertiesCollapsedForTests,
  getPropertiesCollapsed,
  setPropertiesCollapsed,
  subscribePropertiesCollapsed,
} from './properties-collapsed-store';

const STORAGE_KEY = 'ok-properties-collapsed-v1';

/** Minimal in-memory `localStorage` so the persistence path runs without jsdom —
 *  the store reads `window.localStorage` behind a `typeof window` guard, so a
 *  stub on `globalThis.window` exercises it (mirrors composer-draft-store.test). */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = makeLocalStorage();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: storage };
  __resetPropertiesCollapsedForTests();
});

afterEach(() => {
  __resetPropertiesCollapsedForTests();
  delete (globalThis as Record<string, unknown>).window;
});

describe('properties-collapsed-store', () => {
  it('defaults to open (not collapsed) with nothing persisted', () => {
    expect(getPropertiesCollapsed()).toBe(false);
  });

  it('persists collapsed=true and reads it back after a fresh load', () => {
    setPropertiesCollapsed(true);
    expect(getPropertiesCollapsed()).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBe('true');

    // Simulate a new session / fresh mount: drop the in-memory snapshot so the
    // next read re-loads from the (still-populated) storage.
    __resetPropertiesCollapsedForTests();
    expect(getPropertiesCollapsed()).toBe(true);
  });

  it('persists collapsed=false explicitly (not remove-on-open)', () => {
    setPropertiesCollapsed(true);
    setPropertiesCollapsed(false);
    expect(getPropertiesCollapsed()).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('falls back to the default on a malformed stored value', () => {
    storage.setItem(STORAGE_KEY, 'garbage');
    expect(getPropertiesCollapsed()).toBe(false);
  });

  it('notifies subscribers on change but not on a no-op write', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePropertiesCollapsed(listener);

    setPropertiesCollapsed(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op write (same value) neither notifies nor overwrites storage.
    storage.setItem(STORAGE_KEY, 'sentinel');
    setPropertiesCollapsed(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBe('sentinel');

    setPropertiesCollapsed(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPropertiesCollapsed(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
