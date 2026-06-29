
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isProjectRoot } from '@inkeep/open-knowledge-server';

const ANCESTOR_WALK_DEPTH_LIMIT = 30;

export interface ResolveProjectRootResult {
  /** Where `.ok/` lives or will live. Equals `realpath(cwd)` when no
   * promotion happened; otherwise the ancestor that owned `.ok/config.yml`
   * or the git working-tree root. */
  readonly projectRoot: string;
  /** Path the caller should write to `config.yml`'s `content.dir`. Always
   * `'.'`. On `gitRootPromoted: true`, the picked sub-folder is intentionally
   * NOT used as a default scope — `projectRoot` and content scope align by
   * default; the user can narrow via `content.dir` post-init. */
  readonly defaultContentDir: string;
  readonly ancestorPromoted: boolean;
  /** True iff the git working-tree root sat above `cwd` and won the
   * promotion (no ancestor `.ok/`). Mutually exclusive with
   * `ancestorPromoted`. */
  readonly gitRootPromoted: boolean;
}

export interface ResolveProjectRootOptions {
  /** Defaults to `os.homedir()`. Tests inject a fake home so fixtures live
   * inside it without involving the real user's tree. */
  homeDir?: string;
  /** Resolves the git working-tree root for `cwd`. Defaults to shelling out
   * to `git rev-parse --show-toplevel`. Tests inject a deterministic stub
   * to avoid spinning up real git fixtures for unit-level coverage. */
  gitTopLevel?: (cwd: string) => string | null;
}

function isDescendantOfHome(p: string, home: string): boolean {
  const rel = relative(home, p);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

const defaultGitTopLevel = (cwd: string): string | null => {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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
