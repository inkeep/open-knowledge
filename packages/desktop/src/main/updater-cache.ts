import { readFile as fsReadFile, rm as fsRm, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

interface UpdaterCacheLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

/*
 * UPSTREAM(electron-updater@6.8.4): reimplements the private
 * `AppAdapter.getAppCacheDir()` that the updater joins its cache dir onto.
 * Nothing binds the two, so a change to the dep's private path logic drifts
 * silently.
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
  appUpdateConfigPath: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
  logger?: UpdaterCacheLogger;
  readFile?: (path: string) => Promise<string>;
  rm?: (path: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
}

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
