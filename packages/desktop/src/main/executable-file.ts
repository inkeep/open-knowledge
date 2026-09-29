import { accessSync, constants, statSync } from 'node:fs';

export function isExecutableFileSync(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!statSync(absPath).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
