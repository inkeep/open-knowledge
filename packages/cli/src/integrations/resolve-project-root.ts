/**
 * Resolve a CLI project root via ancestor-walk for `.ok/config.yml` first,
 * git-root promotion second. Mirrors desktop `discoverProject` from
 * `packages/desktop/src/main/folder-admission.ts` with a flat record shape and
 * synchronous execution suited to CLI ergonomics — `ok init` calls this
 * before any filesystem side effect. It is init-only by design: git-root
 * promotion and the home-dir stop are scaffolding concerns. Lifecycle
 * commands anchor to an EXISTING project via the CLI preAction hook's
 * `resolveProjectAnchor` (`findEnclosingProjectRoot` semantics) instead.
 *
 * Walk-up rules:
 *   - Realpath cwd, stop at home, filesystem root, or 30 levels.
 *   - First `.ok/config.yml` hit wins; cursor != cwd ⇒ ancestorPromoted.
 *   - No ancestor: try `git rev-parse --show-toplevel`; promote only when the
 *     resolved root is a strict descendant of homeDir (carve-out for
 *     hypothetical `~/.git/`).
 *   - Otherwise: projectRoot = cwd, no promotion (today's CLI behavior).
 *
 * `defaultContentDir` is always `'.'` — content scope equals the resolved
 * `projectRoot`. On git-root promotion the user can still narrow scope via
 * `config.yml`'s `content.dir`, but the default aligns "opened folder" and
 * "content dir" so the two never diverge silently.
 *
 * Pure of stdout — the caller decides whether to print `[ok] Opened existing
 * project at …` or a git-root disclosure line based on the returned record
 * plus its own `existsSync(<projectRoot>/.ok)` probe.
 */

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
  /** True iff a `.ok/` was found above `cwd`. */
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

/**
 * Strict descendant — equal-to-home does NOT promote, so a hypothetical
 * `~/.git/` (e.g., dotfiles repo) is never picked as the project boundary.
 * Mirrors the equivalent helper in desktop's `discoverProject`.
 */
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

/**
 * Classify `cwd` for the CLI scaffolding decision. See module docstring for
 * the rule order; the result fully describes which `projectRoot` and
 * `content.dir` value the caller should use.
 */
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
    // Don't refuse on transient FS issues — operate against the resolved
    // path. Downstream `existsSync` walk handles missing dirs by yielding
    // the no-promotion branch.
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
      // No promotion — git's toplevel equals our cwd. Return the caller's
      // input shape (absCwd) so downstream `join(projectRoot, …)` builds
      // user-visible paths instead of realpath-canonical ones (matters when
      // `/var` is a symlink to `/private/var` on macOS — preserves path
      // equality for callers comparing against their own input).
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

  // Fall-through: no ancestor `.ok/`, no gitRoot promotion. projectRoot
  // semantically equals cwd — use the input shape per the same reasoning
  // as the gitRoot===cwd branch above.
  return {
    projectRoot: absCwd,
    defaultContentDir: '.',
    ancestorPromoted: false,
    gitRootPromoted: false,
  };
}
