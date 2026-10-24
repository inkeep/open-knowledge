import { basename, dirname, resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { inspectLock, type LockState } from './lock-state.ts';

export function projectDirectoryForLockDir(lockDir: string): string | null {
  const parent = dirname(lockDir);
  if (basename(lockDir) === LOCAL_DIR && basename(parent) === OK_DIR) return dirname(parent);
  if (basename(lockDir) === OK_DIR) return parent;
  return null;
}

export interface PsObservation {
  lockDir: string;
  projectRoot: string | null;
  state: LockState;
}

export class PsObservationDiscoveryError extends Error {}

export async function collectPsObservations(
  deps: { discover?: () => Promise<string[]>; inspect?: (lockDir: string) => LockState } = {},
): Promise<PsObservation[]> {
  const discover = deps.discover ?? discoverLockDirs;
  const inspect = deps.inspect ?? ((dir: string) => inspectLock(dir, 'server'));
  const paths = new Map<string, string>();
  let discovered: string[];
  try {
    discovered = await discover();
  } catch (error) {
    throw new PsObservationDiscoveryError(error instanceof Error ? error.message : String(error));
  }
  for (const dir of discovered) {
    const normalized = resolve(dir);
    const path = resolve(normalized, 'server.lock');
    if (!paths.has(path)) paths.set(path, normalized);
  }
  return [...paths]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, lockDir]) => ({
      lockDir,
      projectRoot: projectDirectoryForLockDir(lockDir),
      state: inspect(lockDir),
    }));
}
