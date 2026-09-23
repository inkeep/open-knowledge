import type { spawn as NativeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  DESKTOP_PRODUCTS,
  desktopWindowsExecutableName,
  desktopWindowsInstallDirNames,
} from '@inkeep/open-knowledge-core';
import { spawnDetachedScrubbed } from '../utils/detached-spawn.ts';

export const DESKTOP_BUNDLE_ID = DESKTOP_PRODUCTS.stable.appId;

const DESKTOP_PRODUCT_LIST = [DESKTOP_PRODUCTS.stable, DESKTOP_PRODUCTS.beta] as const;

type DetectReason =
  | 'available'
  | 'darwin-only'
  | 'unsupported-platform'
  | 'force-browser'
  | 'no-bundle'
  | 'headless'
  | 'stat-error';

export interface DetectResult {
  readonly available: boolean;
  readonly reason: DetectReason;
  readonly bundlePath?: string;
}

export interface DetectDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly isTTY: boolean | undefined;
  readonly statSync: (
    path: string,
  ) => { isFile?: () => boolean; isDirectory?: () => boolean } | null;
  readonly homeDir?: string;
}

export function createRealDetectDeps(): DetectDeps {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    isTTY: process.stdout.isTTY,
    statSync: (p) => {
      try {
        return statSync(p, { throwIfNoEntry: false }) ?? null;
      } catch {
        return null;
      }
    },
  };
}

function resolveBundlePath(deps: DetectDeps): string | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const m = /(.+?\.app)\/Contents\/MacOS\//.exec(deps.execPath);
    if (m?.[1]) {
      return m[1];
    }
  }

  const home = deps.homeDir ?? homedir();
  for (const product of DESKTOP_PRODUCT_LIST) {
    for (const applicationsDir of [join(home, 'Applications'), '/Applications']) {
      const bundlePath = join(applicationsDir, `${product.productName}.app`);
      if (probeExecutable(deps, join(bundlePath, 'Contents', 'MacOS', product.productName))) {
        return bundlePath;
      }
    }
  }

  return null;
}

function probeExecutable(deps: DetectDeps, path: string): boolean {
  try {
    const meta = deps.statSync(path);
    if (!meta) return false;
    return typeof meta.isFile === 'function' ? meta.isFile() : false;
  } catch {
    return false;
  }
}

function resolveWindowsExecutable(deps: DetectDeps): string | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const bundledProduct = DESKTOP_PRODUCT_LIST.find((product) =>
      deps.execPath
        .toLowerCase()
        .endsWith(`\\${desktopWindowsExecutableName(product).toLowerCase()}`),
    );
    if (bundledProduct) return deps.execPath;
  }
  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) {
    for (const product of DESKTOP_PRODUCT_LIST) {
      for (const dirName of desktopWindowsInstallDirNames(product)) {
        const exe = win32.join(
          localAppData,
          'Programs',
          dirName,
          desktopWindowsExecutableName(product),
        );
        if (probeExecutable(deps, exe)) return exe;
      }
    }
  }
  return null;
}

function resolveLinuxExecutable(deps: DetectDeps): string | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const bundledProduct = DESKTOP_PRODUCT_LIST.find((product) =>
      deps.execPath.endsWith(`/${product.linuxExecutableName}`),
    );
    if (bundledProduct) return deps.execPath;
  }
  for (const product of DESKTOP_PRODUCT_LIST) {
    const debExe = `/opt/${product.productName}/${product.linuxExecutableName}`;
    if (probeExecutable(deps, debExe)) return debExe;
  }
  return null;
}

export function detectDesktop(deps: DetectDeps): DetectResult {
  if (deps.env.OK_FORCE_BROWSER === '1') {
    return { available: false, reason: 'force-browser' };
  }

  if (deps.platform !== 'darwin' && deps.platform !== 'win32' && deps.platform !== 'linux') {
    return { available: false, reason: 'unsupported-platform' };
  }

  let bundlePath: string | null;
  try {
    bundlePath =
      deps.platform === 'darwin'
        ? resolveBundlePath(deps)
        : deps.platform === 'win32'
          ? resolveWindowsExecutable(deps)
          : resolveLinuxExecutable(deps);
  } catch {
    return { available: false, reason: 'stat-error' };
  }

  if (!bundlePath) {
    return { available: false, reason: 'no-bundle' };
  }

  if (deps.env.OK_FORCE_DESKTOP === '1') {
    return { available: true, reason: 'available', bundlePath };
  }

  const ttyInteractive =
    deps.isTTY === true || (deps.platform === 'win32' && deps.isTTY === undefined && !deps.env.CI);
  if (!ttyInteractive || deps.env.SSH_CONNECTION || deps.env.SSH_TTY) {
    return { available: false, reason: 'headless', bundlePath };
  }

  if (deps.platform === 'linux' && !deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY) {
    return { available: false, reason: 'headless', bundlePath };
  }

  return { available: true, reason: 'available', bundlePath };
}

interface LaunchDeps {
  readonly spawn: typeof NativeSpawn;
  readonly log?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
}

export function launchDesktop(deps: LaunchDeps, detection?: DetectResult): void {
  const log = deps.log ?? ((m) => console.error(m));
  const platform = deps.platform ?? process.platform;
  log(
    'Launching OpenKnowledge desktop (use `ok start` for the browser server, or `OK_FORCE_BROWSER=1` to always skip)',
  );
  const target = detection?.bundlePath;
  if (!target) {
    log('Desktop launch skipped: no resolved desktop executable (caller bug).');
    return;
  }
  if (platform === 'darwin') {
    spawnDetachedScrubbed('open', ['-a', target], { spawn: deps.spawn });
    return;
  }
  spawnDetachedScrubbed(target, [], { spawn: deps.spawn });
}

export function notFoundMessage(reason: DetectReason = 'no-bundle'): string {
  switch (reason) {
    case 'no-bundle':
      return 'Desktop app not found (checked the standard install locations for this OS). Install it from https://openknowledge.ai/download, or omit --mode for browser mode.';
    case 'darwin-only':
    case 'unsupported-platform':
      return 'Desktop app is not available on this platform. Use --mode=browser, or omit --mode for the server fallback.';
    case 'headless':
      return 'Desktop launch is gated in headless contexts (CI, SSH, non-TTY stdout). Set OK_FORCE_DESKTOP=1 to override, or use --mode=browser.';
    case 'force-browser':
      return 'OK_FORCE_BROWSER=1 is set — desktop dispatch is disabled. Unset it to use --mode=app.';
    case 'stat-error':
      return 'Failed to inspect the desktop install (filesystem error). Check permissions or use --mode=browser.';
    case 'available':
      return 'Desktop app appears available but launch dispatch did not fire (caller bug).';
  }
}
