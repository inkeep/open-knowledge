import type { spawn as NativeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  DESKTOP_PRODUCTS,
  type DesktopProduct,
  type DesktopProductName,
  desktopChannelLabel,
  desktopWindowsExecutableName,
  desktopWindowsInstallDirNames,
  OK_CHANNEL_ENV,
  resolveDesktopProductName,
} from '@inkeep/open-knowledge-core';
import { spawnDetachedScrubbed } from '../utils/detached-spawn.ts';

export const DESKTOP_BUNDLE_ID = DESKTOP_PRODUCTS.stable.appId;

const ALL_DESKTOP_PRODUCTS = Object.keys(DESKTOP_PRODUCTS) as readonly DesktopProductName[];

const PUBLIC_DESKTOP_PRODUCTS: readonly DesktopProductName[] = ['stable', 'beta'];

interface ResolvedDesktop {
  readonly path: string;
  readonly product: DesktopProductName;
}

export function runningDesktopProduct(
  env: NodeJS.ProcessEnv,
  execPath: string,
  warn: (message: string) => void = (message) => console.error(message),
): DesktopProductName {
  try {
    return resolveDesktopProductName(env, execPath);
  } catch (err) {
    const product = resolveDesktopProductName({ ...env, [OK_CHANNEL_ENV]: undefined }, execPath);
    warn(
      `Treating this CLI as ${desktopChannelLabel(product)} for this command: ${err instanceof Error ? err.message : String(err)}`,
    );
    return product;
  }
}

export function desktopProductsVisibleTo(
  cliProduct: DesktopProductName,
): readonly DesktopProductName[] {
  return PUBLIC_DESKTOP_PRODUCTS.includes(cliProduct)
    ? PUBLIC_DESKTOP_PRODUCTS
    : [cliProduct, ...PUBLIC_DESKTOP_PRODUCTS];
}

type DetectReason =
  | 'available'
  | 'darwin-only'
  | 'unsupported-platform'
  | 'force-browser'
  | 'no-bundle'
  | 'headless'
  | 'stat-error';

interface DetectResultBase {
  readonly available: boolean;
  readonly reason: DetectReason;
  readonly cliProduct: DesktopProductName;
}

export type DetectResult =
  | (DetectResultBase & { readonly bundlePath?: undefined; readonly product?: undefined })
  | (DetectResultBase & { readonly bundlePath: string; readonly product: DesktopProductName });

export interface DesktopAppTarget {
  readonly bundlePath: string;
  readonly protocolScheme: DesktopProduct['protocolScheme'];
}

export function desktopAppTarget(detection: DetectResult): DesktopAppTarget | null {
  if (detection.bundlePath === undefined) return null;
  return {
    bundlePath: detection.bundlePath,
    protocolScheme: DESKTOP_PRODUCTS[detection.product].protocolScheme,
  };
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
  readonly warn?: (message: string) => void;
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

function resolveBundlePath(
  deps: DetectDeps,
  cliProduct: DesktopProductName,
): ResolvedDesktop | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const m = /(.+?\.app)\/Contents\/MacOS\//.exec(deps.execPath);
    if (m?.[1]) {
      const bundle = m[1];
      const product =
        ALL_DESKTOP_PRODUCTS.find((name) =>
          bundle.endsWith(`/${DESKTOP_PRODUCTS[name].productName}.app`),
        ) ?? cliProduct;
      return { path: bundle, product };
    }
  }

  const home = deps.homeDir ?? homedir();
  for (const product of desktopProductsVisibleTo(cliProduct)) {
    const { productName } = DESKTOP_PRODUCTS[product];
    for (const applicationsDir of [join(home, 'Applications'), '/Applications']) {
      const bundlePath = join(applicationsDir, `${productName}.app`);
      if (probeExecutable(deps, join(bundlePath, 'Contents', 'MacOS', productName))) {
        return { path: bundlePath, product };
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

function resolveWindowsExecutable(
  deps: DetectDeps,
  cliProduct: DesktopProductName,
): ResolvedDesktop | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const bundledProduct = ALL_DESKTOP_PRODUCTS.find((name) =>
      deps.execPath
        .toLowerCase()
        .endsWith(`\\${desktopWindowsExecutableName(DESKTOP_PRODUCTS[name]).toLowerCase()}`),
    );
    if (bundledProduct) return { path: deps.execPath, product: bundledProduct };
  }
  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) {
    for (const product of desktopProductsVisibleTo(cliProduct)) {
      for (const dirName of desktopWindowsInstallDirNames(DESKTOP_PRODUCTS[product])) {
        const exe = win32.join(
          localAppData,
          'Programs',
          dirName,
          desktopWindowsExecutableName(DESKTOP_PRODUCTS[product]),
        );
        if (probeExecutable(deps, exe)) return { path: exe, product };
      }
    }
  }
  return null;
}

function resolveLinuxExecutable(
  deps: DetectDeps,
  cliProduct: DesktopProductName,
): ResolvedDesktop | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const bundledProduct = ALL_DESKTOP_PRODUCTS.find((name) =>
      deps.execPath.endsWith(`/${DESKTOP_PRODUCTS[name].linuxExecutableName}`),
    );
    if (bundledProduct) return { path: deps.execPath, product: bundledProduct };
  }
  for (const product of desktopProductsVisibleTo(cliProduct)) {
    const { productName, linuxExecutableName } = DESKTOP_PRODUCTS[product];
    const debExe = `/opt/${productName}/${linuxExecutableName}`;
    if (probeExecutable(deps, debExe)) return { path: debExe, product };
  }
  return null;
}

export function detectDesktop(deps: DetectDeps): DetectResult {
  const cliProduct = runningDesktopProduct(deps.env, deps.execPath, deps.warn);

  if (deps.env.OK_FORCE_BROWSER === '1') {
    return { available: false, reason: 'force-browser', cliProduct };
  }

  if (deps.platform !== 'darwin' && deps.platform !== 'win32' && deps.platform !== 'linux') {
    return { available: false, reason: 'unsupported-platform', cliProduct };
  }

  let resolved: ResolvedDesktop | null;
  try {
    resolved =
      deps.platform === 'darwin'
        ? resolveBundlePath(deps, cliProduct)
        : deps.platform === 'win32'
          ? resolveWindowsExecutable(deps, cliProduct)
          : resolveLinuxExecutable(deps, cliProduct);
  } catch {
    return { available: false, reason: 'stat-error', cliProduct };
  }

  if (!resolved) {
    return { available: false, reason: 'no-bundle', cliProduct };
  }
  const app = { bundlePath: resolved.path, product: resolved.product, cliProduct };

  if (deps.env.OK_FORCE_DESKTOP === '1') {
    return { available: true, reason: 'available', ...app };
  }

  const ttyInteractive =
    deps.isTTY === true || (deps.platform === 'win32' && deps.isTTY === undefined && !deps.env.CI);
  if (!ttyInteractive || deps.env.SSH_CONNECTION || deps.env.SSH_TTY) {
    return { available: false, reason: 'headless', ...app };
  }

  if (deps.platform === 'linux' && !deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY) {
    return { available: false, reason: 'headless', ...app };
  }

  return { available: true, reason: 'available', ...app };
}

interface LaunchDeps {
  readonly spawn: typeof NativeSpawn;
  readonly log?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
}

export function launchDesktop(deps: LaunchDeps, detection: DetectResult): void {
  const log = deps.log ?? ((m) => console.error(m));
  const platform = deps.platform ?? process.platform;
  if (detection.bundlePath === undefined) {
    log('Desktop launch skipped: no resolved desktop executable (caller bug).');
    return;
  }
  const { productName } = DESKTOP_PRODUCTS[detection.product];
  const [cliCommandName] = DESKTOP_PRODUCTS[detection.cliProduct].cliCommandNames;
  log(
    `Launching ${productName} desktop (use \`${cliCommandName} start\` for the browser server, or \`OK_FORCE_BROWSER=1\` to always skip)`,
  );
  const target = detection.bundlePath;
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
