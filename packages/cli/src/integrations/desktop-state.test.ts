import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_LEGACY_PRODUCT_NAME,
  DESKTOP_PRODUCT_NAME,
  desktopUserDataDir,
  readDesktopRecentProjects,
  stateDirIsOurs,
} from './desktop-state.ts';

describe('desktopUserDataDir', () => {
  test('resolves the Electron userData path per platform', () => {
    expect(desktopUserDataDir({ home: '/Users/x', platformName: 'darwin' })).toBe(
      '/Users/x/Library/Application Support/OpenKnowledge',
    );
    expect(
      desktopUserDataDir({
        home: '/home/x',
        platformName: 'linux',
        env: { XDG_CONFIG_HOME: '/home/x/.config' },
      }),
    ).toBe('/home/x/.config/OpenKnowledge');
    expect(
      desktopUserDataDir({
        home: 'C:\\Users\\x',
        platformName: 'win32',
        env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      }),
    ).toContain('OpenKnowledge');
  });

  test('the legacy product name resolves the space-named macOS dir', () => {
    expect(
      desktopUserDataDir({
        home: '/Users/x',
        platformName: 'darwin',
        productName: DESKTOP_LEGACY_PRODUCT_NAME,
      }),
    ).toBe('/Users/x/Library/Application Support/Open Knowledge');
    // Sanity: the two product names differ.
    expect(DESKTOP_PRODUCT_NAME).not.toBe(DESKTOP_LEGACY_PRODUCT_NAME);
  });
});

function writeState(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'state.json'), JSON.stringify(value));
}

describe('readDesktopRecentProjects', () => {
  test('reads the recent-projects list, keeping only string path+name entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-state-'));
    try {
      writeState(dir, {
        recentProjects: [
          { path: '/a', name: 'A', lastOpenedAt: 't' },
          { path: '/b', name: 'B' },
          { path: 123, name: 'bad' }, // dropped — non-string path
          'garbage', // dropped
        ],
        lastOpenedProject: '/a',
      });
      expect(readDesktopRecentProjects(dir)).toEqual([
        { path: '/a', name: 'A' },
        { path: '/b', name: 'B' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns [] for an absent, malformed, or foreign-shaped state.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-state-'));
    try {
      expect(readDesktopRecentProjects(dir)).toEqual([]); // absent
      writeFileSync(join(dir, 'state.json'), 'not json');
      expect(readDesktopRecentProjects(dir)).toEqual([]); // malformed
      writeState(dir, { somethingElse: true }); // foreign — no recentProjects array
      expect(readDesktopRecentProjects(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stateDirIsOurs', () => {
  test('true only when state.json parses as our AppState shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-state-'));
    try {
      expect(stateDirIsOurs(dir)).toBe(false); // absent
      writeState(dir, { recentProjects: [] }); // our shape (even if empty)
      expect(stateDirIsOurs(dir)).toBe(true);
      writeState(dir, { recentProjects: [{ path: '/p', name: 'P', lastOpenedAt: 't' }] });
      expect(stateDirIsOurs(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('false for a FOREIGN vendor’s same-named dir (no recentProjects array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-state-'));
    try {
      // Another app literally named "Open Knowledge" with its own state format.
      writeState(dir, { windows: [], preferences: { theme: 'dark' } });
      expect(stateDirIsOurs(dir)).toBe(false);
      writeFileSync(join(dir, 'state.json'), '{ broken json');
      expect(stateDirIsOurs(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
