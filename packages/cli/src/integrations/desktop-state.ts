import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AppSupportOptions,
  pathApiForPlatform,
  resolveAppSupportPath,
} from '../commands/editors.ts';

export const DESKTOP_PRODUCT_NAME = 'OpenKnowledge';
export const DESKTOP_UPDATER_CACHE_DIR_NAME = '@inkeepopen-knowledge-desktop-updater';
export const DESKTOP_LEGACY_PRODUCT_NAME = 'Open Knowledge';

interface DesktopUserDataOptions extends AppSupportOptions {
  productName?: string;
}

export function desktopUserDataDir(options: DesktopUserDataOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const productName = options.productName ?? DESKTOP_PRODUCT_NAME;
  return pathApiForPlatform(platformName).join(
    resolveAppSupportPath({ ...options, platformName }),
    productName,
  );
}

export function desktopUpdaterCacheDir(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const pathApi = pathApiForPlatform(platformName);

  let base: string;
  if (platformName === 'win32') {
    base = env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
  } else if (platformName === 'darwin') {
    base = pathApi.join(home, 'Library', 'Caches');
  } else {
    base = env.XDG_CACHE_HOME || pathApi.join(home, '.cache');
  }

  return pathApi.join(base, DESKTOP_UPDATER_CACHE_DIR_NAME);
}

export interface DesktopRecentProject {
  path: string;
  name: string;
}

function parseRecentProjects(raw: unknown): DesktopRecentProject[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const recentRaw = (raw as Record<string, unknown>).recentProjects;
  if (!Array.isArray(recentRaw)) return null;
  const projects: DesktopRecentProject[] = [];
  for (const entry of recentRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path === 'string' && typeof item.name === 'string') {
      projects.push({ path: item.path, name: item.name });
    }
  }
  return projects;
}

export function readDesktopRecentProjects(userDataDir: string): DesktopRecentProject[] {
  const stateFile = join(userDataDir, 'state.json');
  if (!existsSync(stateFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return [];
  }
  return parseRecentProjects(parsed) ?? [];
}

export function stateDirIsOurs(userDataDir: string): boolean {
  const stateFile = join(userDataDir, 'state.json');
  if (!existsSync(stateFile)) return false;
  try {
    return parseRecentProjects(JSON.parse(readFileSync(stateFile, 'utf-8'))) !== null;
  } catch {
    return false;
  }
}
