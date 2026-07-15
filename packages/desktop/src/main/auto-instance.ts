/**
 * Auto-derive a dev-instance name from the git checkout so each worktree /
 * feature branch runs as its own isolated OpenKnowledge desktop instance
 * without the developer setting `OK_INSTANCE` by hand. The derived name feeds
 * the same `OK_INSTANCE` machinery (`instance-isolation.ts` relocates
 * `userData`; `instance-identity.ts` surfaces the label in the menu bar +
 * window titles), so two `bun run dev` launches from different worktrees no
 * longer collide on the single-instance lock.
 *
 * Split into a pure derivation (`deriveAutoInstanceName`, Electron- and
 * git-free, unit-testable) and a thin best-effort git reader
 * (`readGitInstanceContext`). Dev-only: the caller gates on `!app.isPackaged`,
 * lets an explicit `OK_INSTANCE` win, and honors an `OK_AUTO_INSTANCE=0`
 * opt-out.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Branch names treated as the repo's default line — no auto-instance for
 * these, so a plain `bun run dev` on `main` keeps the classic shared
 * `OpenKnowledge` `userData` (and its recents / consent state) rather than
 * silently migrating to a `main`-labelled sibling. Only feature branches and
 * worktrees (always on a non-default branch) get their own instance.
 */
const DEFAULT_BRANCH_NAMES = new Set(['main', 'master']);

export interface GitInstanceContext {
  /** Current branch name, or null when detached / not a git checkout. */
  readonly branch: string | null;
  /** Absolute path of the worktree root, or null when unavailable. */
  readonly worktreeDir: string | null;
}

function runGit(args: readonly string[], dir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      // Silence git's stderr — a non-repo / missing-git failure is expected
      // and handled via the null return, not surfaced to the desktop log.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read the branch + worktree root of the git checkout containing `dir`.
 * Best-effort: any git failure (not a repo, git missing, timeout) yields
 * nulls so the caller falls back to the default `userData`.
 */
function readGitInstanceContext(dir: string): GitInstanceContext {
  return {
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    worktreeDir: runGit(['rev-parse', '--show-toplevel'], dir),
  };
}

/**
 * Derive the auto-instance name from a git context. Prefers the branch name —
 * what a developer recognizes, and what git guarantees is unique across
 * simultaneously-running worktrees (a branch can be checked out in only one
 * worktree at a time). Falls back to the worktree directory basename when HEAD
 * is detached (`git rev-parse --abbrev-ref HEAD` prints `HEAD`), so a
 * tag / SHA checkout still gets a stable per-worktree instance.
 *
 * Returns null for the default branch (see {@link DEFAULT_BRANCH_NAMES}) or
 * when nothing usable is available — signalling the caller to leave `userData`
 * at the default install location. The returned raw name is sanitized
 * downstream by `deriveInstanceUserDataDir` (path-segment safety).
 */
export function deriveAutoInstanceName(ctx: GitInstanceContext): string | null {
  const branch = ctx.branch;
  if (branch && branch !== 'HEAD') {
    if (DEFAULT_BRANCH_NAMES.has(branch)) return null;
    return branch;
  }
  if (ctx.worktreeDir) {
    const base = basename(ctx.worktreeDir);
    return base.length > 0 ? base : null;
  }
  return null;
}

/**
 * Resolve the effective dev-instance name from the environment + a lazily-read
 * git context. Encapsulates the precedence so `index.ts` stays declarative:
 *
 *   1. explicit `OK_INSTANCE` (non-empty, trimmed) always wins — including on
 *      the default branch, so `OK_INSTANCE=main` still isolates on purpose;
 *   2. `OK_AUTO_INSTANCE` in {`0`,`false`,`off`} disables auto-derivation
 *      (→ default `userData`), as does `opts.autoDeriveEnabled: false` (the
 *      caller sets this for automated launches like the E2E desktop smoke, so
 *      no git subprocess runs on the launch path and `userData` is never
 *      relocated out from under a test);
 *   3. otherwise derive from git via `opts.readGit(appDir)`.
 *
 * `opts.readGit` is injected so the whole precedence chain is unit-testable
 * without spawning git. Returns null to leave `userData` untouched.
 */
export function resolveEffectiveInstanceName(
  env: { readonly OK_INSTANCE?: string; readonly OK_AUTO_INSTANCE?: string },
  appDir: string,
  opts: {
    readonly readGit?: (dir: string) => GitInstanceContext;
    readonly autoDeriveEnabled?: boolean;
  } = {},
): { name: string; source: 'env' | 'git' } | null {
  const explicit = env.OK_INSTANCE?.trim();
  if (explicit) return { name: explicit, source: 'env' };
  if (opts.autoDeriveEnabled === false) return null;
  if (/^(0|false|off)$/i.test(env.OK_AUTO_INSTANCE ?? '')) return null;
  const readGit = opts.readGit ?? readGitInstanceContext;
  const derived = deriveAutoInstanceName(readGit(appDir));
  return derived ? { name: derived, source: 'git' } : null;
}
