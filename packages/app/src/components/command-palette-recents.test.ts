import { describe, expect, test } from 'vitest';
import {
  filterOmnibarRecents,
  loadOmnibarRecents,
  makeOmnibarRecentKey,
  type OmnibarRecentEntry,
  rememberOmnibarRecent,
  saveOmnibarRecents,
} from './command-palette-recents';

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe('rememberOmnibarRecent', () => {
  test('dedupes by kind and path and moves the latest entry to the front', () => {
    const entries: OmnibarRecentEntry[] = [
      { kind: 'file', path: 'docs/api', lastOpenedAt: '2026-04-20T00:00:00Z' },
      { kind: 'folder', path: 'docs', lastOpenedAt: '2026-04-19T00:00:00Z' },
    ];

    expect(
      rememberOmnibarRecent(entries, {
        kind: 'file',
        path: 'docs/api',
        lastOpenedAt: '2026-04-21T00:00:00Z',
      }),
    ).toEqual([
      { kind: 'file', path: 'docs/api', lastOpenedAt: '2026-04-21T00:00:00Z' },
      { kind: 'folder', path: 'docs', lastOpenedAt: '2026-04-19T00:00:00Z' },
    ]);
  });
});

describe('storage helpers', () => {
  test('round-trips entries through the provided storage', () => {
    const storage = makeStorage();
    const entries: OmnibarRecentEntry[] = [
      { kind: 'file', path: 'docs/api', lastOpenedAt: '2026-04-21T00:00:00Z' },
    ];

    saveOmnibarRecents(entries, storage);
    expect(loadOmnibarRecents(storage)).toEqual(entries);
  });

  test('returns an empty list for invalid stored payloads', () => {
    const storage = makeStorage();
    storage.setItem('ok-omnibar-recents-v1', '{"bad":true}');
    expect(loadOmnibarRecents(storage)).toEqual([]);
  });
});

describe('filterOmnibarRecents', () => {
  test('keeps only recents still present in the current corpus', () => {
    const entries: OmnibarRecentEntry[] = [
      { kind: 'file', path: 'docs/api', lastOpenedAt: '2026-04-21T00:00:00Z' },
      { kind: 'folder', path: 'docs', lastOpenedAt: '2026-04-20T00:00:00Z' },
    ];
    const validKeys = new Set([makeOmnibarRecentKey('folder', 'docs')]);

    expect(filterOmnibarRecents(entries, validKeys)).toEqual([
      { kind: 'folder', path: 'docs', lastOpenedAt: '2026-04-20T00:00:00Z' },
    ]);
  });
});
