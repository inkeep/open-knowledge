/**
 * Folder-pick admission helpers — classifiers the desktop main process runs
 * against a path the user picked (system folder dialog, drag-drop from Finder,
 * Recents click, or `openknowledge://` deep-link) BEFORE spawning a project
 * window. `validateFolderPick` is pure and surfaces "this looks like an
 * unusual choice" warnings without ever blocking (warn, never refuse).
 * `discoverProject` walks the filesystem to decide whether the picked path
 * (a) is already inside an OK-managed tree (promote to ancestor),
 * (b) sits inside a git working tree (promote `.ok/` to git root),
 * or (c) is a fresh standalone folder.
 *
 * `homeDir` and `gitTopLevel` are injectable so tests don't depend on the real
 * process environment or shell out to git.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { isProjectRoot } from '@inkeep/open-knowledge-server';

const execFileAsync = promisify(execFile);

/**
 * Discriminated union of sensitive-path categories surfaced in the consent
 * dialog. The dialog renders one paragraph per warning entry — order in the
 * returned array matches output order.
 */
export type SensitivePathWarning =
  | { readonly kind: 'root' }
  | { readonly kind: 'home' }
  | { readonly kind: 'home-documents' }
  | { readonly kind: 'home-desktop' }
  | { readonly kind: 'home-downloads' }
  | { readonly kind: 'volumes-mount' }
  | { readonly kind: 'drive-root' };

export interface FolderPickValidation {
  readonly warnings: readonly SensitivePathWarning[];
  /**
   * Always `false`. Reserved — promoted to a real boolean if telemetry shows
   * users mistakenly pick `/` or drive roots ≥ 1% of opens. Never refuse
   * today.
   */
  readonly blocked: boolean;
}

export interface ValidateFolderPickOptions {
  /** Defaults to `os.homedir()`. Tests inject a fixed value to avoid coupling
   * assertions to the real environment's home path. */
  homeDir?: string;
}

/**
 * Classify `absPath` against known sensitive locations. Pure function:
 * `path.resolve` normalizes the input and the comparisons are static against
 * `homeDir` and platform roots. No fs reads, no async, no side effects.
 *
 * The returned `warnings` array is ordered by the categories declared in
 * `SensitivePathWarning` so the dialog renders deterministically.
 */
export function validateFolderPick(
  absPath: string,
  opts: ValidateFolderPickOptions = {},
): FolderPickValidation {
  const home = opts.homeDir ?? nodeHomedir();
  const warnings: SensitivePathWarning[] = [];

  // Windows drive root: `C:`, `C:\`, `C:/`. Match against the raw input —
  // POSIX `path.resolve` treats `C:\` as a relative path and prepends cwd,
  // which would mask the Windows shape on the macOS-only desktop. Enumerated
  // for shape stability when a future Windows port lands.
  if (/^[A-Za-z]:[\\/]?$/.test(absPath)) {
    warnings.push({ kind: 'drive-root' });
  }

  const resolved = resolve(absPath);

  if (resolved === '/') {
    warnings.push({ kind: 'root' });
  }

  if (resolved === home) {
    warnings.push({ kind: 'home' });
  }

  if (resolved === join(home, 'Documents')) {
    warnings.push({ kind: 'home-documents' });
  }

  if (resolved === join(home, 'Desktop')) {
    warnings.push({ kind: 'home-desktop' });
  }

  if (resolved === join(home, 'Downloads')) {
    warnings.push({ kind: 'home-downloads' });
  }

  // `/Volumes` is the macOS mount-points root; subpaths represent mounted
  // volumes (external drives, network shares, dmgs). Warn for the mount-points
  // dir AND any descendant — anything under /Volumes can disappear when a
  // drive ejects, which is worth flagging even at depth.
  if (resolved === '/Volumes' || resolved.startsWith('/Volumes/')) {
    warnings.push({ kind: 'volumes-mount' });
  }

  return { warnings, blocked: false };
}

/**
 * State of `<projectDir>/.git` after discovery. `'shell-only'` is a `.git`
 * directory containing only the shadow-repo subtree but missing `HEAD`,
 * `config`, and `refs/`.
 */
export type GitState = 'present' | 'absent' | 'shell-only';

/**
 * Reasons `discoverProject` may refuse the picked path. Surfaces to the user
 * as a non-consent error dialog rather than feeding into the consent flow.
 */
export type RejectionReason = 'symlink-escape' | 'unreadable';

/**
 * Discriminated result of `discoverProject`. `pickedPath` is preserved on
 * non-rejected branches so callers know what the user picked vs. what got
 * promoted (ancestor `.ok/` or git root).
 */
export type DiscoverProjectResult =
  | {
      readonly kind: 'managed';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly ancestorPromoted: boolean;
    }
  | {
      // Same shape as `managed` but the resolved ancestor failed the
      // boot-budget probe — caller MUST surface user confirmation before
      // forking the utility against `projectDir`. Reaches this branch only
      // when the ancestor walk strictly promoted (`cursor !== realPicked`)
      // AND a `dirSizeProbe` was provided AND the probe reported
      // `exceedsCap: true`. Direct-pick managed never gates on the probe.
      readonly kind: 'managed-requires-confirmation';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly ancestorPromoted: true;
    }
  | {
      readonly kind: 'fresh';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly defaultContentDir: string;
      readonly gitState: GitState;
      readonly gitRootPromoted: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: RejectionReason };

export interface DiscoverProjectOptions {
  /** Defaults to `os.homedir()`. The walk stops without checking home (and
   * never promotes to a git root at-or-above home). Tests inject a fixed
   * value to keep assertions stable. */
  homeDir?: string;
  /** Resolves the git working-tree root for a given cwd. Defaults to shelling
   * out to `git rev-parse --show-toplevel`; tests inject a deterministic
   * stub. Returns `null` when the cwd is not inside a git working tree (or
   * when `git` itself is unavailable). */
  gitTopLevel?: (cwd: string) => Promise<string | null>;
  /**
   * Required. Consulted only when the ancestor walk would strictly promote —
   * the user picked a descendant of an ancestor `.ok/config.yml`. When the
   * probe reports `exceedsCap: true`, `discoverProject` returns
   * `kind: 'managed-requires-confirmation'` so the caller can prompt before
   * forking the utility against an ancestor too large to boot inside the
   * 15s init budget. When the probe reports
   * `exceedsCap: false`, behavior is unchanged.
   *
   * Pass `null` to opt out of boot-budget gating (e.g. CLI flows that never
   * ancestor-promote, tests that don't exercise the new branch). The type
   * system requires a conscious choice; silent `undefined` is no longer
   * accepted, which prevents future callers from silently regressing to
   * the bug-present silent-ancestor-promote behavior.
   */
  dirSizeProbe: ((dir: string) => Promise<{ readonly exceedsCap: boolean }>) | null;
}

/**
 * Maximum number of ancestor levels we walk before giving up. Realistic
 * project depths are <10; the cap is a defensive bound on pathological inputs
 * (a symlinked tree that resolves to a deeper canonical path, or a malicious
 * input crafted to make us walk forever).
 */
const ANCESTOR_WALK_DEPTH_LIMIT = 30;

/**
 * Classify `pickedPath` against the filesystem. Drives the desktop's open
 * orchestration: which `projectDir` to spawn the editor against, whether to
 * surface the consent dialog, and whether to pre-fill `content.dir` with a
 * sub-path under a promoted git root.
 *
 * Resolution order:
 *   1. `realpathSync` the picked path; refuse on EACCES / ELOOP / ENOENT.
 *   2. Detect symlink escape — picked-path realpath that doesn't sit inside
 *      its apparent parent's realpath.
 *   3. Walk up from the realpath, checking each ancestor for `.ok/config.yml`.
 *      First hit wins (`kind: 'managed'`). Walk stops just below `homeDir`
 *      and the filesystem root, and after `ANCESTOR_WALK_DEPTH_LIMIT` levels.
 *   4. No ancestor hit → consult `git rev-parse --show-toplevel`. Promote to
 *      the git root only when it sits strictly below `homeDir` (we never
 *      promote to home itself or to anything above — carve-out for
 *      hypothetical `~/.git/`). `defaultContentDir` is always `'.'`; the
 *      opened folder and the default content scope intentionally align so
 *      the user is never silently looking at the parent while writing under
 *      the picked sub-folder. Narrowing to the sub-folder remains available
 *      via the consent dialog's Content directory field.
 *   5. Compute `gitState` against the resolved `projectDir`.
 *
 * The walk is realpath-canonicalized — every cursor is a real on-disk path —
 * so symlinked sub-trees don't yield phantom ancestors. Worktree-aware:
 * `git rev-parse --show-toplevel` returns the worktree root from inside a
 * linked worktree, so each linked worktree is its own project.
 */
export async function discoverProject(
  pickedPath: string,
  opts: DiscoverProjectOptions,
): Promise<DiscoverProjectResult> {
  const home = opts.homeDir ?? nodeHomedir();
  const gitTopLevel = opts.gitTopLevel ?? defaultGitTopLevel;
  const dirSizeProbe = opts.dirSizeProbe;
  const absPicked = resolve(pickedPath);

  let realPicked: string;
  let realParent: string;
  try {
    realPicked = realpathSync(absPicked);
    realParent = realpathSync(dirname(absPicked));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ELOOP' || code === 'ENOENT') {
      return { kind: 'rejected', reason: 'unreadable' };
    }
    throw err;
  }

  // The picked path is a symlink that resolves outside its apparent parent's
  // realpath — we'd walk an unrelated tree if we proceeded.
  if (!isDescendantOrEqual(realPicked, realParent)) {
    return { kind: 'rejected', reason: 'symlink-escape' };
  }

  // Linked-worktree carveout: an UN-initialized linked-worktree root is a
  // standalone project regardless of any ancestor's .ok/. A `git worktree
  // add .claude/worktrees/feat-bar` produces a worktree at
  // agents-private/.claude/worktrees/feat-bar whose `.git` is a pointer
  // file — the worktree is its own first-class git working tree
  // (`git rev-parse --show-toplevel` from inside returns the worktree
  // path). Without this carveout, the ancestor-walk below would promote
  // the picked path to agents-private/.ok/ (a parent OK project), so
  // opening the worktree would dispatch into the wrong project. Allowing
  // standalone treatment lets the server-side ok-init endpoint scaffold
  // `.ok/config.yml` inside the worktree root itself.
  //
  // **An ALREADY-INITIALIZED linked worktree (its own .ok/config.yml
  // present) is excluded from the carveout** — the worktree's own config
  // takes precedence and it classifies as `managed` via the ancestor walk
  // below. Without this guard, opening an already-set-up worktree
  // re-prompts the consent dialog on every launch (the carveout would
  // short-circuit to `fresh` before the ancestor walk sees the worktree's
  // own config). Common when `.ok/config.yml` is git-tracked: any worktree
  // checked out from a branch carries the file.
  //
  // Tightly scoped: only the picked path being itself a linked-worktree root
  // qualifies. A subfolder of a linked worktree (rare but possible if the
  // user picks a deep directory) still falls into the ancestor-walk path so
  // existing managed-project ancestor promotion semantics apply.
  if (isPickedPathLinkedWorktreeRoot(realPicked) && !isProjectRoot(realPicked)) {
    return {
      kind: 'fresh',
      pickedPath: realPicked,
      projectDir: realPicked,
      defaultContentDir: '.',
      // A linked worktree always has `.git` as a pointer file (not a directory);
      // computeGitState classifies it as 'present' on that codepath. Stay
      // consistent with the rest of the function rather than hardcoding here.
      gitState: computeGitState(realPicked),
      gitRootPromoted: false,
    };
  }

  let cursor = realPicked;
  let depth = 0;
  while (depth < ANCESTOR_WALK_DEPTH_LIMIT) {
    if (cursor === home || cursor === '/' || cursor === '') break;
    if (isProjectRoot(cursor)) {
      const ancestorPromoted = cursor !== realPicked;
      if (ancestorPromoted && dirSizeProbe !== null) {
        const { exceedsCap } = await dirSizeProbe(cursor);
        if (exceedsCap) {
          return {
            kind: 'managed-requires-confirmation',
            pickedPath: realPicked,
            projectDir: cursor,
            ancestorPromoted: true,
          };
        }
      }
      return {
        kind: 'managed',
        pickedPath: realPicked,
        projectDir: cursor,
        ancestorPromoted,
      };
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
    depth += 1;
  }

  const gitRoot = await gitTopLevel(realPicked);
  let projectDir = realPicked;
  let gitRootPromoted = false;
  if (gitRoot !== null && isDescendantOfHome(gitRoot, home)) {
    projectDir = gitRoot;
    gitRootPromoted = gitRoot !== realPicked;
  }

  return {
    kind: 'fresh',
    pickedPath: realPicked,
    projectDir,
    defaultContentDir: '.',
    gitState: computeGitState(projectDir),
    gitRootPromoted,
  };
}

/**
 * `relative(parent, child)` returns `''` for equal paths, a `..`-prefixed
 * string when child sits outside parent, and a non-`..` relative path when
 * child is a descendant. The early `child === parent` short-circuit is
 * defensive for trailing-slash / OS-quirk equality.
 */
function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Strict descendant — equal-to-home does NOT promote. */
function isDescendantOfHome(p: string, home: string): boolean {
  const rel = relative(home, p);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function computeGitState(projectDir: string): GitState {
  const dotGit = resolve(projectDir, '.git');
  if (!existsSync(dotGit)) return 'absent';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return 'absent';
  }
  // Worktree-pointer file (`.git` is a regular file containing `gitdir: ...`)
  // — there's no HEAD at this layer; the linked worktree's git dir owns it.
  if (!stat.isDirectory()) return 'present';
  if (existsSync(resolve(dotGit, 'HEAD'))) return 'present';
  return 'shell-only';
}

/**
 * Returns true iff `pickedPath` is the root of a linked git worktree —
 * `pickedPath/.git` is a pointer file (not a directory) that targets an
 * admin gitdir elsewhere. Used by the linked-worktree carveout in
 * `discoverProject`: a linked-worktree root is a standalone project
 * regardless of any ancestor's `.ok/`.
 *
 * `resolveGitDirDetailed` is the source of truth for `.git` classification,
 * but it WALKS UP when `pickedPath/.git` is absent — so a subfolder of a linked
 * worktree also resolves to `kind: 'linked'` (the ancestor's pointer file),
 * distinguished only by a non-empty `projectSubPath`. We require
 * `projectSubPath === ''` so the carveout fires ONLY when `pickedPath` is the
 * worktree root itself; a subfolder must fall through to the ancestor-walk +
 * git-root promotion, else `discoverProject` scaffolds `.ok/` inside the
 * subfolder instead of promoting to the git root. The variants `'directory'`
 * (main checkout), `'absent'`, `'malformed-pointer'`, and `'inaccessible'` all
 * fall through to the ancestor-walk path so existing behavior is preserved.
 */
function isPickedPathLinkedWorktreeRoot(pickedPath: string): boolean {
  try {
    const resolved = resolveGitDirDetailed(pickedPath);
    return resolved.kind === 'linked' && resolved.projectSubPath === '';
  } catch {
    return false;
  }
}

async function defaultGitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
