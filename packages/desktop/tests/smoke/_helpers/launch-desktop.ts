import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { _electron as electron } from '@playwright/test';

type ElectronLaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;
export type SmokeLaunchEnv = NonNullable<ElectronLaunchOptions['env']>;

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

export const DESKTOP_ROOT = resolve(HELPERS_DIR, '..', '..', '..');

export const PACKAGED_APP_ENV = 'OK_DESKTOP_PACKAGED_APP';

export const UNPACKAGED_MAIN_ENTRY = join(DESKTOP_ROOT, 'out', 'main', 'index.js');

export const DEFAULT_LOCAL_PACKAGED_APP = join(
  DESKTOP_ROOT,
  'dist-desktop',
  'mac-arm64',
  'OpenKnowledge.app',
);

export type DesktopLaunchMode = 'packaged' | 'unpackaged';

export interface DesktopTarget {
  mode: DesktopLaunchMode;
  appPath?: string;
  targetPath: string;
  exists: boolean;
  missingReason: string;
}

export interface ResolveDesktopTargetOptions {
  env?: NodeJS.ProcessEnv;
  requirePackaged?: boolean;
}

export function executableForAppBundle(appPath: string): string {
  return join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'));
}

export function resolveDesktopTarget(options: ResolveDesktopTargetOptions = {}): DesktopTarget {
  const env = options.env ?? process.env;
  const override = env[PACKAGED_APP_ENV];
  const appPath =
    override && override.length > 0
      ? resolve(override)
      : options.requirePackaged
        ? DEFAULT_LOCAL_PACKAGED_APP
        : undefined;

  if (appPath !== undefined) {
    const targetPath = executableForAppBundle(appPath);
    return {
      mode: 'packaged',
      appPath,
      targetPath,
      exists: existsSync(targetPath),
      missingReason: `Packaged desktop build missing at ${targetPath} — build a packaged app, or point ${PACKAGED_APP_ENV} at one.`,
    };
  }

  return {
    mode: 'unpackaged',
    targetPath: UNPACKAGED_MAIN_ENTRY,
    exists: existsSync(UNPACKAGED_MAIN_ENTRY),
    missingReason: `Main build missing at ${UNPACKAGED_MAIN_ENTRY} — run "pnpm run build:desktop" first.`,
  };
}

export interface DesktopLaunchOptionsInput {
  target?: DesktopTarget;
  args?: string[];
  env?: SmokeLaunchEnv;
  timeout?: number;
}

export interface DesktopLaunchOptions {
  args: string[];
  timeout: number;
  executablePath?: string;
  env?: SmokeLaunchEnv;
}

export const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

export function desktopLaunchOptions(input: DesktopLaunchOptionsInput = {}): DesktopLaunchOptions {
  const target = input.target ?? resolveDesktopTarget();
  const extraArgs = input.args ?? [];
  const timeout = input.timeout ?? DEFAULT_LAUNCH_TIMEOUT_MS;

  const base: DesktopLaunchOptions =
    target.mode === 'packaged'
      ? { args: [...extraArgs], timeout, executablePath: target.targetPath }
      : { args: [target.targetPath, ...extraArgs], timeout };

  return { ...base, env: { ...process.env, ...input.env, OK_LANG: 'en' } };
}
