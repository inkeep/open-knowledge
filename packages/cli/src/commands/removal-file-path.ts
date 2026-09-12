import { lstatSync, statSync } from 'node:fs';
import { resolveHarnessWritePaths } from '../native/symlink-resolve.ts';
import {
  type ConfigFileDeclineReason,
  configFileDeclineReason,
} from '../utils/config-file-error.ts';

type RemovalFilePath =
  | { kind: 'ready'; path: string; symlink: boolean }
  | { kind: 'not-present' }
  | { kind: 'declined'; reason: ConfigFileDeclineReason };

export function resolveRemovalFilePath(configPath: string): RemovalFilePath {
  let symlink: boolean;
  try {
    symlink = lstatSync(configPath).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'not-present' }
      : { kind: 'declined', reason: configFileDeclineReason(error) };
  }

  const resolved = resolveHarnessWritePaths(configPath);
  if (resolved.readPath === null) return { kind: 'declined', reason: 'unresolved-symlink' };
  try {
    if (!statSync(resolved.readPath).isFile()) return { kind: 'declined', reason: 'not-a-file' };
  } catch (error) {
    return {
      kind: 'declined',
      reason:
        symlink && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing-symlink-target'
          : configFileDeclineReason(error),
    };
  }
  return { kind: 'ready', path: resolved.writePath, symlink };
}
