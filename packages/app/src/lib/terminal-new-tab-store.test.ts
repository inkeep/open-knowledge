import { describe, expect, test } from 'vitest';
import {
  readPreferBareTerminal,
  subscribePreferBareTerminal,
  TERMINAL_NEW_TAB_BARE_KEY,
  writePreferBareTerminal,
} from './terminal-new-tab-store';

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

describe('cross-surface publication', () => {
  test('a write notifies every subscriber, and each re-reads the new value', () => {
    const shared = fakeStorage();
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const stopA = subscribePreferBareTerminal(() => seenA.push(readPreferBareTerminal(shared)));
    const stopB = subscribePreferBareTerminal(() => seenB.push(readPreferBareTerminal(shared)));

    writePreferBareTerminal(true, shared);
    writePreferBareTerminal(false, shared);

    stopA();
    stopB();
    expect(seenA).toEqual([true, false]);
    expect(seenB).toEqual(seenA);
  });

  test('an unsubscribed surface stops being notified', () => {
    const shared = fakeStorage();
    const seen: boolean[] = [];
    const stop = subscribePreferBareTerminal(() => seen.push(readPreferBareTerminal(shared)));
    stop();
    writePreferBareTerminal(true, shared);
    expect(seen).toEqual([]);
  });
});
