import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getUpdaterBaseCacheDir,
  readUpdaterCacheDirName,
  reclaimPendingUpdateCache,
} from './updater-cache.ts';

describe('getUpdaterBaseCacheDir', () => {
  test('win32 prefers %LOCALAPPDATA%', () => {
    expect(
      getUpdaterBaseCacheDir({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        homeDir: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local');
  });

  test('win32 falls back to <home>/AppData/Local when LOCALAPPDATA is unset', () => {
    expect(getUpdaterBaseCacheDir({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\u' })).toBe(
      join('C:\\Users\\u', 'AppData', 'Local'),
    );
  });

  test('darwin uses ~/Library/Caches', () => {
    expect(getUpdaterBaseCacheDir({ platform: 'darwin', env: {}, homeDir: '/Users/u' })).toBe(
      '/Users/u/Library/Caches',
    );
  });

  test('linux prefers $XDG_CACHE_HOME', () => {
    expect(
      getUpdaterBaseCacheDir({
        platform: 'linux',
        env: { XDG_CACHE_HOME: '/xdg/cache' },
        homeDir: '/home/u',
      }),
    ).toBe('/xdg/cache');
  });

  test('linux falls back to ~/.cache', () => {
    expect(getUpdaterBaseCacheDir({ platform: 'linux', env: {}, homeDir: '/home/u' })).toBe(
      '/home/u/.cache',
    );
  });
});

describe('readUpdaterCacheDirName', () => {
  test('extracts the generated cache dir name', () => {
    const yml = [
      'provider: github',
      'owner: inkeep',
      'repo: open-knowledge',
      "updaterCacheDirName: '@inkeepopen-knowledge-desktop-updater'",
    ].join('\n');
    expect(readUpdaterCacheDirName(yml)).toBe('@inkeepopen-knowledge-desktop-updater');
  });

  test('returns null when the key is absent', () => {
    expect(readUpdaterCacheDirName('provider: github\nrepo: x')).toBeNull();
  });

  test('returns null on empty or non-string values', () => {
    expect(readUpdaterCacheDirName("updaterCacheDirName: ''")).toBeNull();
    expect(readUpdaterCacheDirName('updaterCacheDirName: 3')).toBeNull();
    expect(readUpdaterCacheDirName('updaterCacheDirName: [a]')).toBeNull();
  });

  test('returns null on unparseable yaml', () => {
    expect(readUpdaterCacheDirName('{{{{not yaml')).toBeNull();
  });

  test('rejects multi-segment / traversal / absolute shapes (rm -rf safety net)', () => {
    // Single-quoted YAML so the backslash case reaches the parser literally
    // (double-quoted YAML would decode `\b` as a backspace escape).
    for (const bad of ['a/b', 'a\\b', '..', '.', '../evil', '/etc']) {
      expect(readUpdaterCacheDirName(`updaterCacheDirName: '${bad}'`)).toBeNull();
    }
  });
});

describe('reclaimPendingUpdateCache', () => {
  const tempRoots: string[] = [];
  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-updater-cache-'));
    tempRoots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Lay out <root>/{resources/app-update.yml, cache/<name>/pending/...}. */
  async function scaffold(root: string, cacheDirName = 'ok-updater') {
    const configPath = join(root, 'resources', 'app-update.yml');
    await mkdir(join(root, 'resources'), { recursive: true });
    await writeFile(configPath, `provider: github\nupdaterCacheDirName: ${cacheDirName}\n`);
    const pendingDir = join(root, 'cache', cacheDirName, 'pending');
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, 'OpenKnowledge-Setup-x64.exe'), 'staged-installer-bytes');
    await writeFile(join(pendingDir, 'update-info.json'), '{}');
    return { configPath, pendingDir };
  }

  function linuxDeps(root: string, configPath: string) {
    return {
      appUpdateConfigPath: configPath,
      platform: 'linux' as const,
      env: { XDG_CACHE_HOME: join(root, 'cache') },
      homeDir: join(root, 'home'),
    };
  }

  test('removes the pending dir (and only it) once invoked', async () => {
    const root = makeTempRoot();
    const { configPath, pendingDir } = await scaffold(root);
    const outcome = await reclaimPendingUpdateCache(linuxDeps(root, configPath));
    expect(outcome).toBe('reclaimed');
    await expect(stat(pendingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    // The enclosing updater cache dir survives — only pending/ is reclaimed.
    await expect(stat(join(root, 'cache', 'ok-updater'))).resolves.toBeDefined();
  });

  test('reports nothing-staged when pending/ does not exist', async () => {
    const root = makeTempRoot();
    const { configPath, pendingDir } = await scaffold(root);
    rmSync(pendingDir, { recursive: true, force: true });
    expect(await reclaimPendingUpdateCache(linuxDeps(root, configPath))).toBe('nothing-staged');
  });

  test('reports a stat failure instead of treating it as a missing cache', async () => {
    const root = makeTempRoot();
    const { configPath } = await scaffold(root);
    const warn = vi.fn();
    const statError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const outcome = await reclaimPendingUpdateCache({
      ...linuxDeps(root, configPath),
      exists: () => Promise.reject(statError),
      logger: { info: vi.fn(), warn, debug: vi.fn() },
    });

    expect(outcome).toBe('failed');
    expect(warn).toHaveBeenCalledWith('failed to inspect staged updater cache', {
      pendingDir: join(root, 'cache', 'ok-updater', 'pending'),
      err: statError,
    });
  });

  test('missing app-update.yml skips without touching disk', async () => {
    const root = makeTempRoot();
    const { pendingDir } = await scaffold(root);
    const outcome = await reclaimPendingUpdateCache(
      linuxDeps(root, join(root, 'resources', 'does-not-exist.yml')),
    );
    expect(outcome).toBe('config-unreadable');
    await expect(stat(pendingDir)).resolves.toBeDefined();
  });

  test('unusable updaterCacheDirName skips without touching disk', async () => {
    const root = makeTempRoot();
    const { configPath, pendingDir } = await scaffold(root);
    await writeFile(configPath, 'provider: github\n');
    const outcome = await reclaimPendingUpdateCache(linuxDeps(root, configPath));
    expect(outcome).toBe('no-cache-dir-name');
    await expect(stat(pendingDir)).resolves.toBeDefined();
  });

  test('rm failure is reported, not thrown', async () => {
    const root = makeTempRoot();
    const { configPath } = await scaffold(root);
    const outcome = await reclaimPendingUpdateCache({
      ...linuxDeps(root, configPath),
      rm: () => Promise.reject(new Error('EACCES')),
    });
    expect(outcome).toBe('failed');
  });
});
