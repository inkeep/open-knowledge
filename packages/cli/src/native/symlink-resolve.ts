import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { debugNativeLoadFailure, requireNativeConfigModule } from './load-native-config.ts';

export interface SymlinkWritePaths {
  readPath: string | null;
  writePath: string;
}

interface NativeSymlinkBinding {
  resolveSymlinkWritePath(path: string): { readPath?: string | null; writePath: string };
}

function requireNativeSymlinkBinding(): NativeSymlinkBinding | null {
  const mod = requireNativeConfigModule();
  return mod && typeof (mod as Partial<NativeSymlinkBinding>).resolveSymlinkWritePath === 'function'
    ? (mod as NativeSymlinkBinding)
    : null;
}

function resolveSymlinkWritePathsJs(path: string): SymlinkWritePaths {
  let current = path;
  const visited = new Set<string>();

  for (;;) {
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { readPath: current, writePath: current };
      }
      return { readPath: null, writePath: path };
    }

    if (!isSymlink) return { readPath: current, writePath: current };

    if (visited.has(current)) return { readPath: null, writePath: path };
    visited.add(current);

    let target: string;
    try {
      target = readlinkSync(current);
    } catch (err) {
      debugNativeLoadFailure('readlinkSync threw during symlink walk', err);
      return { readPath: null, writePath: path };
    }
    current = isAbsolute(target) ? target : join(dirname(current), target);
  }
}

let cachedBinding: NativeSymlinkBinding | null | undefined;

function cachedNativeBinding(): NativeSymlinkBinding | null {
  if (cachedBinding === undefined) cachedBinding = requireNativeSymlinkBinding();
  return cachedBinding;
}

export function resolveHarnessWritePaths(
  configPath: string,
  loadNative: () => NativeSymlinkBinding | null = cachedNativeBinding,
): SymlinkWritePaths {
  const native = loadNative();
  if (native) {
    try {
      const resolved = native.resolveSymlinkWritePath(configPath);
      return { readPath: resolved.readPath ?? null, writePath: resolved.writePath };
    } catch (err) {
      debugNativeLoadFailure('resolveSymlinkWritePath threw', err);
    }
  }
  return resolveSymlinkWritePathsJs(configPath);
}
