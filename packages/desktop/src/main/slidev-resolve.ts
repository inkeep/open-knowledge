import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlidevSource } from '../shared/ipc-channels.ts';

type SlidevResolution = { available: true; source: SlidevSource } | { available: false };

export interface SlidevResolveProbes {
  isExecutableFile: (absPath: string) => Promise<boolean>;
  isOnLoginPath: (bin: string) => Promise<boolean>;
}

export function projectLocalSlidevBin(projectRoot: string, platform: NodeJS.Platform): string {
  return join(projectRoot, 'node_modules', '.bin', platform === 'win32' ? 'slidev.cmd' : 'slidev');
}

export async function resolveSlidev(
  projectRoot: string | undefined,
  probes: SlidevResolveProbes,
  platform: NodeJS.Platform = process.platform,
): Promise<SlidevResolution> {
  if (projectRoot) {
    const local = projectLocalSlidevBin(projectRoot, platform);
    if (await probes.isExecutableFile(local)) {
      return { available: true, source: 'project-local' };
    }
  }
  if (await probes.isOnLoginPath('slidev')) {
    return { available: true, source: 'global' };
  }
  return { available: false };
}

export async function realIsExecutableFile(absPath: string): Promise<boolean> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
