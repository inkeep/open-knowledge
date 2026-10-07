import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

export class HomeProjectRootError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `Refusing to set up an OpenKnowledge project in your home directory (${projectRoot}).\n` +
        `  A project here would run 'git init' in your home directory and write project config\n` +
        `  and skills into your editors' user-global directories (~/.cursor, ~/.codex, ~/.claude).\n` +
        `  Make a folder for this project, then run 'ok init' inside it.`,
    );
    this.name = 'HomeProjectRootError';
    this.projectRoot = projectRoot;
  }
}

export class FilesystemRootProjectError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `Refusing to set up an OpenKnowledge project at the top of a drive (${projectRoot}).\n` +
        `  A project here would scan every file on the drive and run 'git init' at its root.\n` +
        `  Make a folder for this project, then run 'ok init' inside it.`,
    );
    this.name = 'FilesystemRootProjectError';
    this.projectRoot = projectRoot;
  }
}

const MACOS_DATA_VOLUME = '/System/Volumes/Data';

export function canonicalizeForCompare(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function isHomeDir(dir: string, home: string = nodeHomedir()): boolean {
  return canonicalizeForCompare(resolve(dir)) === canonicalizeForCompare(home);
}

export function isFilesystemRoot(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const resolved = path.resolve(dir);
  const abs = platform === process.platform ? canonicalizeForCompare(resolved) : resolved;
  return path.dirname(abs) === abs || (platform === 'darwin' && abs === MACOS_DATA_VOLUME);
}

export function assertSafeProjectRoot(dir: string, home?: string): void {
  if (isHomeDir(dir, home)) throw new HomeProjectRootError(resolve(dir));
  if (isFilesystemRoot(dir)) throw new FilesystemRootProjectError(resolve(dir));
}
