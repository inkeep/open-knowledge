import { release as osRelease } from 'node:os';
import { isTerminalPlatform } from '../shared/terminal-platform.ts';

/** Windows 10 version 1809, the first release with the ConPTY API. */
export const WINDOWS_CONPTY_MIN_BUILD = 17763;
export const TERMINAL_AVAILABLE_ARG = '--ok-pty-available=1';

/** Extract the numeric build component from Node's Windows os.release() value. */
export function parseWindowsBuildNumber(release: string): number | null {
  const build = release.split('.')[2];
  if (build === undefined || !/^\d+$/.test(build)) return null;
  const parsed = Number(build);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Main-process terminal capability, with an injectable Windows build seam. */
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

/** Carry main's capability verdict into the sandboxed preload. */
export function withTerminalCapabilityArg(args: readonly string[], available: boolean): string[] {
  return available ? [...args, TERMINAL_AVAILABLE_ARG] : [...args];
}
