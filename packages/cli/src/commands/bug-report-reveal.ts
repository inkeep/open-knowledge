import { platform } from 'node:os';
import { dirname } from 'node:path';
import { spawnDetachedScrubbed } from '../utils/detached-spawn.ts';

export function revealBundle(
  zipPath: string,
  os: NodeJS.Platform = platform(),
  spawnDetached: (command: string, args: readonly string[]) => unknown = spawnDetachedScrubbed,
): void {
  try {
    if (os === 'darwin') spawnDetached('/usr/bin/open', ['-R', zipPath]);
    else if (os === 'win32') spawnDetached('explorer.exe', [dirname(zipPath)]);
    else spawnDetached('xdg-open', [dirname(zipPath)]);
  } catch {}
}
