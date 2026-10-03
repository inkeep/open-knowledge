import { dirname, win32 } from 'node:path';
import { wrapperPathInBundle } from './bundle-paths.ts';

export type InstallShape =
  | { kind: 'mac-bundle'; wrapperPath: string }
  | { kind: 'windows'; installRoot: string; wrapperPath: string }
  | { kind: 'linux'; installRoot: string; wrapperPath: string }
  | { kind: 'appimage' }
  | { kind: 'unsupported' };

export function classifyInstallShape(
  platform: 'darwin' | 'win32' | 'linux' | string,
  executablePath: string,
  env: Record<string, string | undefined>,
): InstallShape {
  if (platform === 'darwin') {
    if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) return { kind: 'unsupported' };
    return {
      kind: 'mac-bundle',
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  if (platform === 'win32') {
    if (!/\.exe$/i.test(executablePath)) return { kind: 'unsupported' };
    return {
      kind: 'windows',
      installRoot: win32.dirname(executablePath),
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  if (platform === 'linux') {
    if (env.APPIMAGE) return { kind: 'appimage' };
    if (!executablePath.startsWith('/')) return { kind: 'unsupported' };
    return {
      kind: 'linux',
      installRoot: dirname(executablePath),
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  return { kind: 'unsupported' };
}

export function isSupportedInstallShape(
  platform: string,
  executablePath: string,
  env: Record<string, string | undefined>,
): boolean {
  const { kind } = classifyInstallShape(platform, executablePath, env);
  return kind !== 'appimage' && kind !== 'unsupported';
}

export function agentConnectionsAvailability(
  isPackaged: boolean,
  platform: string,
  executablePath: string,
  env: Record<string, string | undefined>,
): { available: boolean; devBuild: boolean } {
  if (env.OK_RECLAIM_DISABLE === '1') return { available: false, devBuild: false };
  if (!isPackaged && env.OK_M6B_FORCE !== '1') return { available: false, devBuild: true };
  return { available: isSupportedInstallShape(platform, executablePath, env), devBuild: false };
}
