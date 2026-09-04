import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalizeForCompare,
  isHomeDir,
  isProjectRoot,
  withHiddenWindowsConsole,
} from '@inkeep/open-knowledge-server';

export { canonicalizeForCompare, isHomeDir };

const ANCESTOR_WALK_DEPTH_LIMIT = 30;

export interface ResolveProjectRootResult {
  readonly projectRoot: string;
  readonly defaultContentDir: string;
  readonly ancestorPromoted: boolean;
  readonly gitRootPromoted: boolean;
}

export interface ResolveProjectRootOptions {
  homeDir?: string;
  gitTopLevel?: (cwd: string) => string | null;
}

function isDescendantOfHome(p: string, home: string): boolean {
  const rel = relative(canonicalizeForCompare(home), canonicalizeForCompare(p));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

const defaultGitTopLevel = (cwd: string): string | null => {
  try {
    const result = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      withHiddenWindowsConsole({
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

export function resolveProjectRoot(
  cwd: string,
  opts: ResolveProjectRootOptions = {},
): ResolveProjectRootResult {
  const home = opts.homeDir ?? nodeHomedir();
  const gitTopLevel = opts.gitTopLevel ?? defaultGitTopLevel;

  const absCwd = resolve(cwd);
  let realCwd: string;
  try {
    realCwd = realpathSync(absCwd);
  } catch {
    realCwd = absCwd;
  }

  let cursor = realCwd;
  let depth = 0;
  while (depth < ANCESTOR_WALK_DEPTH_LIMIT) {
    if (cursor === home || cursor === '/' || cursor === '') break;
    if (isProjectRoot(cursor)) {
      return {
        projectRoot: cursor,
        defaultContentDir: '.',
        ancestorPromoted: cursor !== realCwd,
        gitRootPromoted: false,
      };
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
    depth += 1;
  }

  const gitRoot = gitTopLevel(realCwd);
  if (gitRoot !== null && isDescendantOfHome(gitRoot, home)) {
    if (gitRoot === realCwd) {
      return {
        projectRoot: absCwd,
        defaultContentDir: '.',
        ancestorPromoted: false,
        gitRootPromoted: false,
      };
    }
    return {
      projectRoot: gitRoot,
      defaultContentDir: '.',
      ancestorPromoted: false,
      gitRootPromoted: true,
    };
  }

  return {
    projectRoot: absCwd,
    defaultContentDir: '.',
    ancestorPromoted: false,
    gitRootPromoted: false,
  };
}
