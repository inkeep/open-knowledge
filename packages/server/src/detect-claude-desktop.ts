import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DetectClaudeDesktopOptions {
  home?: string;
  platformName?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function detectClaudeDesktopPresence(opts: DetectClaudeDesktopOptions = {}): boolean {
  const home = opts.home ?? homedir();
  const platformName = opts.platformName ?? process.platform;
  const env = opts.env ?? process.env;

  if (platformName === 'darwin') {
    return existsSync(join(home, 'Library', 'Application Support', 'Claude'));
  }

  if (platformName === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return existsSync(join(appData, 'Claude'));
  }

  return false;
}
