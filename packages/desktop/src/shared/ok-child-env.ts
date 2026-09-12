import { homedir } from 'node:os';
import {
  OK_DESKTOP_TERMINAL_ENV,
  OK_HOSTED_AGENT_ENV,
  posixOkManagedBinDir,
} from '@inkeep/open-knowledge-core';
import { windowsPathKey } from './windows-env.ts';

const STRIPPED_ENV_MARKERS = [
  'OK_ELECTRON_PROTOCOL_HOST',
  'OK_LOCK_KIND',
  'ELECTRON_RUN_AS_NODE',
  OK_DESKTOP_TERMINAL_ENV,
  OK_HOSTED_AGENT_ENV,
] as const;

export interface OkManagedBinDirsOptions {
  readonly platform: NodeJS.Platform;
  readonly home?: string | undefined;
  readonly cliBinDir?: string | undefined;
}

export function okPackagedCliBinDir(
  platform: NodeJS.Platform,
  resourcesPath: string | undefined,
): string | undefined {
  if (platform !== 'win32' || !resourcesPath) return undefined;
  return `${resourcesPath}\\cli\\bin`;
}

export function okChildHome(parentEnv: Record<string, string | undefined>): string | undefined {
  if (parentEnv.HOME) return parentEnv.HOME;
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

export function okChildEnvOptions(
  parentEnv: Record<string, string | undefined>,
  overrides: { platform?: NodeJS.Platform; cliBinDir?: string } = {},
): OkManagedBinDirsOptions {
  return {
    platform: overrides.platform ?? process.platform,
    home: okChildHome(parentEnv),
    cliBinDir: overrides.cliBinDir,
  };
}

export function okChildEnvOptionsFromProcess(): OkManagedBinDirsOptions {
  return okChildEnvOptions(process.env, {
    cliBinDir: okPackagedCliBinDir(process.platform, process.resourcesPath),
  });
}

export function okManagedBinDirs(options: OkManagedBinDirsOptions): readonly string[] {
  if (options.platform === 'win32') return options.cliBinDir ? [options.cliBinDir] : [];
  return options.home ? [posixOkManagedBinDir(options.home)] : [];
}

export function hasNoResolvableOkHome(options: OkManagedBinDirsOptions): boolean {
  return options.platform !== 'win32' && !options.home;
}

export function okPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function entryMatchesDir(entry: string, dir: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? entry.toLowerCase() === dir.toLowerCase() : entry === dir;
}

export function okChildPathEntries(
  env: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
): readonly string[] {
  return (env[windowsPathKey(env)] ?? '').split(okPathDelimiter(options.platform)).filter(Boolean);
}

export function hasOkManagedBinDirsOnPath(
  env: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
): boolean {
  const dirs = okManagedBinDirs(options);
  if (dirs.length === 0) return false;
  const entries = okChildPathEntries(env, options);
  return dirs.every((dir) =>
    entries.some((entry) => entryMatchesDir(entry, dir, options.platform)),
  );
}

function prependOkManagedBinDirs(
  env: Record<string, string>,
  options: OkManagedBinDirsOptions,
): Record<string, string> {
  const entries = okChildPathEntries(env, options);
  const additions = okManagedBinDirs(options).filter(
    (dir) => !entries.some((entry) => entryMatchesDir(entry, dir, options.platform)),
  );
  if (additions.length === 0) return { ...env };
  const joined = [...additions, ...entries].join(okPathDelimiter(options.platform));
  return { ...env, [windowsPathKey(env)]: joined };
}

export function composeOkChildEnv(
  parentEnv: Record<string, string | undefined>,
  options: OkManagedBinDirsOptions,
): Record<string, string> {
  const stripped = new Set<string>(STRIPPED_ENV_MARKERS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (stripped.has(key) || key.startsWith('GDK_PIXBUF_')) continue;
    out[key] = value;
  }
  return prependOkManagedBinDirs(out, options);
}
