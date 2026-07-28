/**
 * One launch convention for the Electron smoke suite.
 *
 * The suite runs in two structurally different shapes. Unpackaged it launches
 * `electron` against `out/main/index.js`, passing that main entry as the first
 * element of `args`. Packaged it launches the bundle's own binary via
 * `executablePath` and must NOT pass a main entry at all — a path swap between
 * the two does not work, which is why every call site routes through here.
 *
 * Mode is selected by `OK_DESKTOP_PACKAGED_APP`: set it to an `.app` bundle to
 * run the same test files against a packaged build. Absent, the suite behaves
 * exactly as it did before this helper existed.
 *
 * `env` is deliberately optional and never defaulted. Eight of the suite's
 * launch sites pass no `env` today; handing them a default that included
 * `OK_DESKTOP_E2E_SMOKE` would silently change behavior at
 * `dialog-helpers.ts:readTestPickedPath` and `index.ts:resolveEffectiveInstanceName`,
 * both of which read that variable unconditionally.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { _electron as electron } from '@playwright/test';

/** Playwright's own launch-options shape, so `env` stays exactly its type. */
type ElectronLaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;
export type SmokeLaunchEnv = NonNullable<ElectronLaunchOptions['env']>;

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `packages/desktop`. Exported so smoke files can resolve package-relative
 * paths without each re-deriving `__dirname` — which is not a runtime global
 * under this package's `"type": "module"`, and which `@types/node` declares
 * ambiently so a stale reference typechecks clean and only fails at import.
 */
export const DESKTOP_ROOT = resolve(HELPERS_DIR, '..', '..', '..');

/** Env var naming a packaged `.app` bundle to run the smoke subset against. */
export const PACKAGED_APP_ENV = 'OK_DESKTOP_PACKAGED_APP';

/** `electron-vite` output the unpackaged suite launches. */
export const UNPACKAGED_MAIN_ENTRY = join(DESKTOP_ROOT, 'out', 'main', 'index.js');

/**
 * Where `electron-builder --mac` drops the unpacked bundle locally. Only used
 * by suites that are packaged-only and get no env override — CI supplies the
 * override, so this is the local-developer convenience path.
 */
export const DEFAULT_LOCAL_PACKAGED_APP = join(
  DESKTOP_ROOT,
  'dist-desktop',
  'mac-arm64',
  'OpenKnowledge.app',
);

export type DesktopLaunchMode = 'packaged' | 'unpackaged';

export interface DesktopTarget {
  mode: DesktopLaunchMode;
  /** `.app` bundle root in packaged mode; undefined otherwise. */
  appPath?: string;
  /** The main entry (unpackaged) or the bundle executable (packaged). */
  targetPath: string;
  exists: boolean;
  /** Ready-to-use `test.skip` reason when `exists` is false. */
  missingReason: string;
}

export interface ResolveDesktopTargetOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve a packaged target even without the env override, falling back to
   * the local `electron-builder` output. For suites that only make sense
   * against a packaged bundle.
   */
  requirePackaged?: boolean;
}

/** `<bundle>.app/Contents/MacOS/<bundle>` — electron-builder's layout. */
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
  /** Defaults to `resolveDesktopTarget()`. */
  target?: DesktopTarget;
  /** Arguments after the main entry (`--user-data-dir=…`, deep links, flags). */
  args?: string[];
  /** Passed through verbatim. Omitted entirely when absent. */
  env?: SmokeLaunchEnv;
  /** Defaults to 30_000, matching every call site before this helper. */
  timeout?: number;
}

export interface DesktopLaunchOptions {
  args: string[];
  timeout: number;
  executablePath?: string;
  env?: SmokeLaunchEnv;
}

export const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Build the `electron.launch` options for the active mode. Unpackaged prepends
 * the main entry to `args` and sets no `executablePath`; packaged sets
 * `executablePath` and leaves `args` as the caller supplied them.
 */
export function desktopLaunchOptions(input: DesktopLaunchOptionsInput = {}): DesktopLaunchOptions {
  const target = input.target ?? resolveDesktopTarget();
  const extraArgs = input.args ?? [];
  const timeout = input.timeout ?? DEFAULT_LAUNCH_TIMEOUT_MS;

  const base: DesktopLaunchOptions =
    target.mode === 'packaged'
      ? { args: [...extraArgs], timeout, executablePath: target.targetPath }
      : { args: [target.targetPath, ...extraArgs], timeout };

  // Spread conditionally rather than assigning `env: input.env`: an explicit
  // `env: undefined` key is not the same as no key to Playwright, and the
  // no-env call sites depend on inheriting the parent environment untouched.
  return input.env === undefined ? base : { ...base, env: input.env };
}
