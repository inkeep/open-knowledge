import { describe, expect, test } from 'bun:test';
import {
  readPreferBareTerminal,
  TERMINAL_NEW_TAB_BARE_KEY,
  writePreferBareTerminal,
} from './terminal-new-tab-store';

/** In-memory Storage stand-in matching the `NewTabStorage` seam. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    has: (k: string) => map.has(k),
  };
}

describe('terminal-new-tab-store', () => {
  test('defaults to false when nothing is stored', () => {
    expect(readPreferBareTerminal(fakeStorage())).toBe(false);
  });

  test('writing true then reading returns true; writing false removes the key', () => {
    const s = fakeStorage();
    writePreferBareTerminal(true, s);
    expect(s.has(TERMINAL_NEW_TAB_BARE_KEY)).toBe(true);
    expect(readPreferBareTerminal(s)).toBe(true);

    // Clearing removes the key entirely (rather than storing '0'), so an absent
    // key and an explicit false are the same on the next read.
    writePreferBareTerminal(false, s);
    expect(s.has(TERMINAL_NEW_TAB_BARE_KEY)).toBe(false);
    expect(readPreferBareTerminal(s)).toBe(false);
  });

  test('a junk stored value is not treated as true', () => {
    const s = fakeStorage();
    s.setItem(TERMINAL_NEW_TAB_BARE_KEY, 'yes');
    expect(readPreferBareTerminal(s)).toBe(false);
  });
});
