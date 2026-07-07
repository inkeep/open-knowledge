/**
 * Desktop worktree selector service (worktree = window).
 *
 * The IO half of the worktree selector: spawns git to enumerate worktrees +
 * local branches and to create a new worktree, and hands the raw output to the
 * pure `core` builders (`buildWorktreeSelectorModel`, `worktreeRelativeDir`).
 * Lives in desktop main because worktree management is a desktop concern —
 * the same layer as `list-git-worktrees.ts` and `read-head-branch.ts`, which
 * this module reuses.
 *
 * Auto-location policy: a worktree for `<branch>` is created at
 * `<mainRoot>/.ok/worktrees/<branch>`, where `<mainRoot>` is the repo's PRIMARY
 * worktree (git lists it first) — so worktrees created from inside a linked
 * worktree still land in one place under the main root. The `.ok/worktrees/`
 * directory is appended to the shared `.git/info/exclude` so the nested
 * worktree never shows up as untracked in the parent repo's `git status`; this
 * keeps the parent's tracked `.gitignore` untouched (worktrees are local,
 * per-clone workspaces, not shared state).
 *
 * Every operation fails soft: git errors collapse to a discriminated result the
 * IPC handler forwards verbatim, never a throw.
 */

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  buildWorktreeSelectorModel,
  parseBranchList,
  stripRemotePrefix,
  WORKTREES_PARENT_DIR,
  type WorktreeCreateRequest,
  type WorktreeCreateResult,
  type WorktreeListResult,
  worktreeRelativeDir,
} from '@inkeep/open-knowledge-core';
import { listGitWorktrees } from './list-git-worktrees.ts';
import { seedWorktreeAutoSync } from './worktree-autosync-inherit.ts';
import { clearRecentGitCache } from './worktree-recents.ts';

const execFileAsync = promisify(execFile);

/** English-stable git env — mirrors `list-git-worktrees.ts` so stderr
 *  classification survives a non-English host locale. */
const GIT_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C' } as const;

export type { WorktreeCreateResult, WorktreeListResult };

export interface CreateWorktreeArgs extends WorktreeCreateRequest {
  /** A path inside the repo (the focused window's project) — the git anchor. */
  readonly anchorPath: string;
}

/**
 * Enumerate worktrees + local branches and build the selector model. Returns
 * `{ ok: false, reason: 'no-git' }` when the anchor isn't inside a git repo
 * (no worktrees enumerable). `currentProjectPath` flags the focused window's
 * entry; the caller passes the window's project path.
 */
export async function listWorktreeSelector(
  anchorPath: string,
  currentProjectPath: string,
): Promise<WorktreeListResult> {
  const worktrees = await listGitWorktrees(anchorPath);
  if (worktrees.length === 0) return { ok: false, reason: 'no-git' };
  const branches = await listLocalBranches(anchorPath);
  const remoteBranches = await listRemoteBranches(anchorPath);
  // "N behind origin" hint per local branch WITH an upstream — computed
  // READ-ONLY + NO-NETWORK (no fetch), so it reflects the last fetch and never
  // adds per-open latency or an offline stall. Nudges the user toward a fresh
  // `origin/<x>` base over a stale local one.
  const behind = await computeBehindCounts(anchorPath, branches, remoteBranches);
  // The model flags the current entry by exact path equality against a worktree
  // toplevel. But OK usually opens at a git SUBDIRECTORY (an OK subtree), so
  // `currentProjectPath` (the content dir) never equals any toplevel and the
  // focused window would never be marked current. Resolve the anchor to the
  // toplevel that CONTAINS it, and hand that to the pure builder. Fail-soft: if
  // no worktree contains the anchor, keep the original value.
  const resolvedCurrent = resolveAnchorToplevel(currentProjectPath, worktrees);
  const model = buildWorktreeSelectorModel({
    worktrees,
    branches,
    remoteBranches,
    behind,
    currentProjectPath: resolvedCurrent,
  });
  return { ok: true, model };
}

/**
 * Map an anchor path to the enumerated worktree toplevel that contains it
 * (exact match or ancestor), so a subdirectory anchor still flags the right
 * worktree as current. `worktrees` paths are realpath-collapsed by
 * `listGitWorktrees`; the anchor is realpath'd here to match. When several
 * toplevels contain the anchor (nested worktrees), the deepest wins. Returns
 * the original `anchorPath` when nothing contains it (fail-soft — the model
 * then flags nothing current, the prior behavior).
 */
function resolveAnchorToplevel(
  anchorPath: string,
  worktrees: readonly { readonly path: string; readonly prunable: boolean }[],
): string {
  let anchor = anchorPath;
  try {
    anchor = realpathSync(anchorPath);
  } catch {
    // Missing/unreadable anchor — compare with the raw path as given.
  }
  let best: string | null = null;
  for (const w of worktrees) {
    if (w.prunable) continue;
    const isSelfOrAncestor = anchor === w.path || anchor.startsWith(w.path + sep);
    if (isSelfOrAncestor && (best === null || w.path.length > best.length)) {
      best = w.path;
    }
  }
  return best ?? anchorPath;
}

/**
 * Create (or locate) the worktree for `branch` under the main root's
 * `.ok/worktrees/`. When the branch already has a worktree, returns its path
 * with `created: false` so the caller opens the existing window instead. On a
 * fresh create, appends the worktrees dir to `.git/info/exclude` first, then
 * runs `git worktree add`.
 */
export async function createWorktree(args: CreateWorktreeArgs): Promise<WorktreeCreateResult> {
  const rel = worktreeRelativeDir(args.branch);
  if (rel === null || !isAbsolute(args.anchorPath)) {
    return { ok: false, reason: 'invalid-branch' };
  }

  const worktrees = await listGitWorktrees(args.anchorPath);
  if (worktrees.length === 0) return { ok: false, reason: 'no-git' };
  const mainRoot = worktrees[0]?.path;
  if (mainRoot === undefined) return { ok: false, reason: 'no-git' };

  // Branch already checked out somewhere → hand back its path; the caller opens
  // that window rather than attempting a duplicate (git forbids it anyway).
  const existing = worktrees.find((w) => !w.prunable && w.branch === args.branch.trim());
  if (existing) return { ok: true, path: existing.path, created: false };

  const worktreePath = join(mainRoot, rel);

  ensureWorktreesExcluded(args.anchorPath);

  // `--` ends option parsing so a dash-prefixed positional (branch or base ref)
  // is taken as a literal, never a git flag. Without it, a name like `--detach`
  // that `worktreeRelativeDir` doesn't reject is consumed by git's option
  // parser: the checkout arm's trailing branch would silently create a
  // detached-HEAD worktree instead of checking out the branch. The `-b <branch>`
  // value is the flag's argument (not a positional), so only the trailing base
  // ref needs guarding in the create arm.
  const addArgs = buildAddArgs(args, worktreePath);

  try {
    await execFileAsync('git', addArgs, { cwd: args.anchorPath, env: GIT_ENV });
  } catch (err) {
    return { ok: false, ...classifyAddError(err) };
  }

  // The worktree now exists on disk — capture success before any post-create
  // step so a throw in seeding/cache-invalidation can't misclassify it as a
  // failed create (which would leave the dir orphaned).
  // Topology changed → drop the memoized worktree classification so the
  // switcher's next list-recent re-derives main-root / linked-worktree state.
  clearRecentGitCache();
  // Inherit the root project's auto-sync choice so the new worktree doesn't
  // re-prompt. Best-effort: `writeConfigPatch` rethrows unexpected errors, and
  // the created worktree must stand regardless — swallow so seeding can never
  // flip the success result (its own expected-failure path already logs).
  try {
    await seedWorktreeAutoSync(worktreePath, mainRoot);
  } catch {
    // Seed is advisory; the worktree opens fine without it (falls back to the
    // normal onboarding prompt).
  }
  return { ok: true, path: worktreePath, created: true };
}

/**
 * Assemble the `git worktree add` argv for the four create modes. Precedence:
 *
 *   1. `remoteRef` set → remote-tracking CHECKOUT: create a new LOCAL branch
 *      that TRACKS the explicit remote ref. `git worktree add --track -b
 *      <branch> <path> origin/<branch>`. The explicit ref (not a bare `-b`)
 *      avoids the multi-remote DWIM `fatal: invalid reference`, and preserves
 *      remote history instead of forking off stale HEAD. Highest-value fix.
 *   2. `baseRef` set (create mode) → new branch off a REMOTE base with
 *      `--no-track`: `git worktree add -b <branch> <path> origin/<base>
 *      --no-track`. A feature branch must not inherit the base's remote as its
 *      own upstream. The ref is a `<remote>/<branch>` string (never dash-
 *      prefixed) resolved as a ref, and `--no-track` is a trailing flag — no
 *      `--` guard needed.
 *   3. plain create (`createBranch`, local/no base) → `git worktree add -b
 *      <branch> <path> [-- <localBase>]`. The trailing local base IS a
 *      positional, so it keeps the `--` end-of-options guard.
 *   4. checkout (existing local branch) → `git worktree add <path> -- <branch>`.
 *
 * Modes 1 & 2 pass a `<remote>/<name>` ref git resolves unambiguously, so they
 * don't need the `--` guard the positional-base/branch arms rely on.
 */
function buildAddArgs(args: CreateWorktreeArgs, worktreePath: string): string[] {
  const branch = args.branch.trim();
  const remoteRef = args.remoteRef?.trim();
  if (remoteRef) {
    return ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef];
  }
  if (args.createBranch) {
    const baseRef = args.baseRef?.trim();
    if (baseRef) {
      return ['worktree', 'add', '-b', branch, worktreePath, baseRef, '--no-track'];
    }
    return [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      ...(args.baseBranch ? ['--', args.baseBranch] : []),
    ];
  }
  return ['worktree', 'add', worktreePath, '--', branch];
}

/** Local branch short-names via `git for-each-ref`; `[]` on any failure. */
async function listLocalBranches(anchorPath: string): Promise<string[]> {
  if (!isAbsolute(anchorPath)) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { cwd: anchorPath, env: GIT_ENV },
    );
    return parseBranchList(String(stdout));
  } catch {
    return [];
  }
}

/**
 * Remote-tracking branch refs WITH their remote prefix (`origin/main`,
 * `upstream/dev`) via `git for-each-ref refs/remotes/`. `<remote>/HEAD` symbolic
 * refs (git's per-remote default-branch pointer) are dropped — they're not
 * branches, and a `--track` against `origin/HEAD` would be nonsense. Fail-soft
 * `[]` (no remotes, or enumeration failed) exactly like `listLocalBranches`.
 * NO network — reads only local remote-tracking refs (whatever the last fetch
 * populated).
 */
async function listRemoteBranches(anchorPath: string): Promise<string[]> {
  if (!isAbsolute(anchorPath)) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'],
      { cwd: anchorPath, env: GIT_ENV },
    );
    // `refname:short` renders a `<remote>/HEAD` pointer as `<remote>` (no
    // trailing `/HEAD`) — drop any ref with no slash (a bare remote name), plus
    // any explicit `.../HEAD`, so only real `<remote>/<branch>` refs survive.
    return parseBranchList(String(stdout)).filter(
      (ref) => ref.includes('/') && stripRemotePrefix(ref) !== 'HEAD',
    );
  } catch {
    return [];
  }
}

/**
 * Per-local-branch "commits behind origin" counts, READ-ONLY + NO-NETWORK.
 * For each local branch that has a matching `origin/<branch>` remote-tracking
 * ref, run `git rev-list --count <branch>..origin/<branch>` — the number of
 * commits on `origin/<branch>` not yet on the local branch, as of the last
 * fetch. Branches with no `origin/<branch>` counterpart get no entry (the model
 * leaves their `behind` undefined → "unknown", not "0"). A count that fails to
 * parse is skipped. `origin` is the fixed remote we key on (the default-branch
 * convention across OK's flows); a branch tracked to a non-origin remote simply
 * gets no hint rather than a wrong one.
 */
async function computeBehindCounts(
  anchorPath: string,
  branches: readonly string[],
  remoteBranches: readonly string[],
): Promise<Record<string, number>> {
  if (!isAbsolute(anchorPath)) return {};
  const remoteRefSet = new Set(remoteBranches);
  const out: Record<string, number> = {};
  await Promise.all(
    branches.map(async (branch) => {
      const upstream = `origin/${branch}`;
      if (!remoteRefSet.has(upstream)) return;
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${branch}..${upstream}`],
          { cwd: anchorPath, env: GIT_ENV },
        );
        const n = Number.parseInt(String(stdout).trim(), 10);
        if (Number.isFinite(n) && n >= 0) out[branch] = n;
      } catch {
        // No hint for this branch — leave it out (undefined ≠ 0).
      }
    }),
  );
  return out;
}

/**
 * Append `/<WORKTREES_PARENT_DIR>/` to the repo's shared `.git/info/exclude`
 * (idempotent) so a worktree nested under `.ok/worktrees/` never surfaces as
 * untracked in the parent repo's `git status`. Uses the common git dir so a
 * single write covers every worktree of the repo. Best-effort: a failure here
 * doesn't block worktree creation (the untracked-dir noise is cosmetic).
 *
 * The committed `.ok/.gitignore` (OK_GITIGNORE_CONTENT in
 * @inkeep/open-knowledge-server) now carries the same `worktrees/` rule as the
 * universal, shared-on-clone exclusion; this per-clone write is the immediate,
 * on-create fallback for projects whose committed rule predates the selector.
 */
function ensureWorktreesExcluded(anchorPath: string): void {
  try {
    const commonDir = execFileSyncTrim(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      anchorPath,
    );
    if (commonDir === null) return;
    const excludePath = join(commonDir, 'info', 'exclude');
    const line = `/${WORKTREES_PARENT_DIR}/`;
    let current = '';
    try {
      current = readFileSync(excludePath, 'utf-8');
    } catch {
      // No exclude file yet — the append below creates it.
    }
    if (current.split('\n').some((l) => l.trim() === line)) return;
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(excludePath, `${prefix}${line}\n`);
  } catch {
    // Best-effort; cosmetic only.
  }
}

/** Synchronous git read that returns the trimmed stdout, or null on failure. */
function execFileSyncTrim(cmd: string, cmdArgs: string[], cwd: string): string | null {
  try {
    return String(execFileSync(cmd, cmdArgs, { cwd, env: GIT_ENV })).trim();
  } catch {
    return null;
  }
}

interface ExecErr {
  stderr?: string | Buffer;
  message?: string;
}

interface AddErrorClassification {
  readonly reason: 'branch-exists' | 'already-checked-out' | 'path-exists' | 'error';
  readonly message?: string;
}

function classifyAddError(err: unknown): AddErrorClassification {
  const e = typeof err === 'object' && err !== null ? (err as ExecErr) : null;
  const stderrRaw = e?.stderr;
  // Buffer.isBuffer narrows the stable `stderrRaw` local, so no non-null
  // assertion is needed (biome's --unsafe fix rewrites `!` → `?.`, which would
  // otherwise reintroduce a possibly-undefined `raw`).
  const raw: string =
    stderrRaw !== undefined && stderrRaw !== null
      ? Buffer.isBuffer(stderrRaw)
        ? stderrRaw.toString('utf-8')
        : String(stderrRaw)
      : String(e?.message ?? err);
  const stderr = raw.toLowerCase();
  if (stderr.includes('already checked out')) return { reason: 'already-checked-out' };
  if (stderr.includes('already exists') && stderr.includes('branch')) {
    return { reason: 'branch-exists' };
  }
  if (stderr.includes('already exists')) return { reason: 'path-exists' };
  return { reason: 'error', message: raw.replace(/\s+/g, ' ').slice(0, 300) };
}
