/**
 * Updater-cache reclamation — deletes electron-updater's staged installer
 * once it can no longer be needed.
 *
 * electron-updater stages every downloaded update under
 * `<baseCacheDir>/<updaterCacheDirName>/pending/` and only empties that
 * directory when a DIFFERENT version is later downloaded
 * (`DownloadedUpdateHelper.cleanCacheDirForPendingUpdate`). After an install
 * commits, the staged installer for the version now running just sits there
 * until the next release — a constant ~250 MB of dead weight on every
 * platform.
 *
 * The caller (auto-updater boot reconciliation) decides WHEN reclaiming is
 * safe — strictly after the install-success signal, never while an update is
 * still staged or a manual Linux install may still consume the file. This
 * module only knows HOW: resolve the cache dir exactly the way
 * electron-updater does (`AppAdapter.getAppCacheDir` + `updaterCacheDirName`
 * from app-update.yml) and remove `pending/`.
 *
 * The Windows-only sibling copy (`<updaterCacheDirName>\installer.exe`, made
 * by the NSIS installer itself to seed differential updates) is handled at
 * install time by `build/installer.nsh`, not here — this process can't win a
 * race against its own installer.
 *
 * The macOS sibling (`<updaterCacheDirName>/update.zip`, copied beside
 * `pending/` by `MacUpdater.doDownloadUpdate`) is deliberately NOT
 * reclaimed: unlike the inert Windows copy it has a live consumer — it is
 * the base electron-updater's differential download patches against on the
 * next mac update (`canDifferentialDownload` gates on its presence), and
 * removing it would demote every future mac update to a full download.
 */

import { readFile as fsReadFile, rm as fsRm, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

interface UpdaterCacheLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Mirror of electron-updater's `AppAdapter.getAppCacheDir()` — the base the
 * updater cache dir is joined onto. Kept in sync manually; the shape is
 * stable across electron-updater releases (win: %LOCALAPPDATA%, mac:
 * ~/Library/Caches, linux: $XDG_CACHE_HOME or ~/.cache).
 */
export function getUpdaterBaseCacheDir(opts: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
}): string {
  const { platform, env, homeDir } = opts;
  if (platform === 'win32') {
    return env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Caches');
  }
  return env.XDG_CACHE_HOME || join(homeDir, '.cache');
}

/**
 * Extract `updaterCacheDirName` from app-update.yml text. Returns null when
 * the key is absent, empty, non-string, or the YAML fails to parse — callers
 * skip reclaiming rather than guessing a directory to delete.
 */
export function readUpdaterCacheDirName(appUpdateYmlText: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(appUpdateYmlText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = (parsed as Record<string, unknown>).updaterCacheDirName;
  if (typeof value !== 'string' || value === '') return null;
  // Recursive-delete safety net: the name must be a plain single path
  // segment. electron-builder always generates one; anything else (path
  // separators, traversal, absolute) means a corrupt or tampered
  // app-update.yml and is not worth pointing `rm -rf` at.
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value === '.') {
    return null;
  }
  return value;
}

export type ReclaimOutcome =
  | 'reclaimed'
  | 'nothing-staged'
  | 'config-unreadable'
  | 'no-cache-dir-name'
  | 'failed';

export interface ReclaimPendingUpdateCacheDeps {
  /** `join(process.resourcesPath, 'app-update.yml')` in a packaged build. */
  appUpdateConfigPath: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
  logger?: UpdaterCacheLogger;
  /** Injectable fs seams for tests. */
  readFile?: (path: string) => Promise<string>;
  rm?: (path: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
}

/**
 * Delete `<updater cache>/pending/` wholesale. electron-updater recreates the
 * directory (and its `update-info.json`) on the next download, so removing
 * the directory itself is exactly what its own `emptyDir`-based cleanup does
 * when a new version supersedes the staged one.
 */
export async function reclaimPendingUpdateCache(
  deps: ReclaimPendingUpdateCacheDeps,
): Promise<ReclaimOutcome> {
  const {
    appUpdateConfigPath,
    platform,
    env,
    homeDir,
    logger = { info: () => {}, warn: () => {}, debug: () => {} },
    readFile = (p) => fsReadFile(p, 'utf8'),
    rm = (p) => fsRm(p, { recursive: true, force: true }),
    exists = async (p) => {
      try {
        await fsStat(p);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },
  } = deps;

  let configText: string;
  try {
    configText = await readFile(appUpdateConfigPath);
  } catch (err) {
    logger.debug('app-update.yml unreadable — skipping updater-cache reclaim', {
      appUpdateConfigPath,
      err,
    });
    return 'config-unreadable';
  }

  const cacheDirName = readUpdaterCacheDirName(configText);
  if (cacheDirName === null) {
    logger.warn('app-update.yml has no usable updaterCacheDirName — skipping reclaim', {
      appUpdateConfigPath,
    });
    return 'no-cache-dir-name';
  }

  const pendingDir = join(
    getUpdaterBaseCacheDir({ platform, env, homeDir }),
    cacheDirName,
    'pending',
  );
  let pendingExists: boolean;
  try {
    pendingExists = await exists(pendingDir);
  } catch (err) {
    logger.warn('failed to inspect staged updater cache', { pendingDir, err });
    return 'failed';
  }
  if (!pendingExists) {
    logger.debug('no staged updater cache to reclaim', { pendingDir });
    return 'nothing-staged';
  }

  try {
    await rm(pendingDir);
  } catch (err) {
    logger.warn('failed to reclaim staged updater cache', { pendingDir, err });
    return 'failed';
  }
  logger.info('reclaimed staged updater cache', { pendingDir });
  return 'reclaimed';
}
