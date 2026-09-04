import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadBoolPref, saveBoolPref } from './bool-pref';

const KEY = 'test-pref';

function installStorage(impl?: Partial<Storage>): Map<string, string> {
  const entries = new Map<string, string>();
  const storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    ...impl,
  } as Storage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
  return entries;
}

describe('bool-pref', () => {
  let entries: Map<string, string>;

  beforeEach(() => {
    entries = installStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default-off preferences (the pre-existing behavior)', () => {
    test('absent reads false and true persists as the deviation', () => {
      expect(loadBoolPref(KEY)).toBe(false);
      saveBoolPref(KEY, true);
      expect(entries.get(KEY)).toBe('true');
      expect(loadBoolPref(KEY)).toBe(true);
    });

    test('returning to the default clears the key rather than storing it', () => {
      saveBoolPref(KEY, true);
      saveBoolPref(KEY, false);
      expect(entries.has(KEY)).toBe(false);
      expect(loadBoolPref(KEY)).toBe(false);
    });

    test("a value written by the older 'true'-only writer still reads true", () => {
      entries.set(KEY, 'true');
      expect(loadBoolPref(KEY)).toBe(true);
    });
  });

  describe('default-on preferences', () => {
    test('absent reads true', () => {
      expect(loadBoolPref(KEY, true)).toBe(true);
    });

    test('false persists as the deviation and reads back', () => {
      saveBoolPref(KEY, false, true);
      expect(entries.get(KEY)).toBe('false');
      expect(loadBoolPref(KEY, true)).toBe(false);
    });

    test('returning to the default clears the key', () => {
      saveBoolPref(KEY, false, true);
      saveBoolPref(KEY, true, true);
      expect(entries.has(KEY)).toBe(false);
      expect(loadBoolPref(KEY, true)).toBe(true);
    });

    test('clearing storage restores the default instead of flipping it off', () => {
      saveBoolPref(KEY, false, true);
      entries.clear();
      expect(loadBoolPref(KEY, true)).toBe(true);
    });
  });

  describe('storage is a trust boundary', () => {
    test('a throwing read falls back to the default', () => {
      installStorage({
        getItem: () => {
          throw new Error('SecurityError');
        },
      });
      expect(loadBoolPref(KEY)).toBe(false);
      expect(loadBoolPref(KEY, true)).toBe(true);
    });

    test('a throwing write is swallowed so the caller still works', () => {
      installStorage({
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {
          throw new Error('QuotaExceededError');
        },
      });
      expect(() => saveBoolPref(KEY, true)).not.toThrow();
      expect(() => saveBoolPref(KEY, false, true)).not.toThrow();
    });
  });
});
