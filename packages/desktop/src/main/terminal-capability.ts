import { release as osRelease } from 'node:os';
import { isTerminalPlatform } from '../shared/terminal-platform.ts';

export const WINDOWS_CONPTY_MIN_BUILD = 17763;
export const TERMINAL_AVAILABLE_ARG = '--ok-pty-available=1';

export function parseWindowsBuildNumber(release: string): number | null {
  const build = release.split('.')[2];
  if (build === undefined || !/^\d+$/.test(build)) return null;
  const parsed = Number(build);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isTerminalAvailable(
  platform: NodeJS.Platform = process.platform,
  windowsBuildNumber?: number | null,
): boolean {
  if (!isTerminalPlatform(platform)) return false;
  if (platform !== 'win32') return true;
  const build =
    windowsBuildNumber === undefined ? parseWindowsBuildNumber(osRelease()) : windowsBuildNumber;
  return (
    typeof build === 'number' && Number.isSafeInteger(build) && build >= WINDOWS_CONPTY_MIN_BUILD
  );
}

export function withTerminalCapabilityArg(args: readonly string[], available: boolean): string[] {
  return available ? [...args, TERMINAL_AVAILABLE_ARG] : [...args];
}
