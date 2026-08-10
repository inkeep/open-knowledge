import { platform } from 'node:os';
import { dirname } from 'node:path';
import { spawnDetachedScrubbed } from '../utils/detached-spawn.ts';

/**
 * Reveal the finished bundle in the OS file manager. Finder can select the
 * file itself (`open -R`); Windows and Linux open the containing folder
 * instead. Explorer's `/select,<path>` verb is deliberately avoided: Node
 * quotes any argv element containing a space, and a quoted `"/select,C:\…"`
 * stops parsing as a switch — Explorer then opens a default folder. A bare
 * directory argument quotes cleanly, and bug-report bundles live under the
 * home directory, where spaces are common.
 *
 * Lives apart from `bug-report.ts` because that module imports `cli.ts`
 * (which parses argv at load) — this one stays import-safe for unit tests.
 */
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
