import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { resolve } from 'node:path';

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

export function assertNotHomeProjectRoot(dir: string, home?: string): void {
  if (isHomeDir(dir, home)) throw new HomeProjectRootError(resolve(dir));
}
