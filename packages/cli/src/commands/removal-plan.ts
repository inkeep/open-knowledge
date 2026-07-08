/**
 * The shared removal engine behind `ok deinit` (one project) and `ok uninstall`
 * (the whole machine) — a pure plan builder + an injectable executor, following
 * the `clean.ts` house pattern (`buildCleanPlan` / `runClean`).
 *
 * `buildDeinitPlan` / `buildUninstallPlan` return an ordered list of typed,
 * data-only `RemovalOp`s (no closures) so a `--dry-run` can render the exact
 * plan without touching anything, and every builder is unit-testable in
 * isolation. `runRemoval` is the SINGLE execution site: it dispatches each op by
 * `kind`, wraps every op in its own try/catch, and returns `{ removed, failed }`
 * — one op failing (a locked keychain, an EACCES dir, an unparseable config)
 * never aborts the rest of the run.
 *
 * Ordering is load-bearing for uninstall: stop servers first; remove the
 * `~/.ok` machinery dir LAST, so the run's own file logger (which writes under
 * `~/.ok/logs`) survives until the end.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
// `resolveShadowDir` (resolves `<gitdir>/ok/`, worktree-aware; throws on a
// malformed/inaccessible .git pointer) lives in the node:fs-importing subpath
// the core barrel omits. Used over `getShadowRepoPath` so a shadow dir that
// exists WITHOUT a HEAD (a torn init) is still swept — the executor's own
// existsSync gates the actual removal.
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { resolveLockDir } from '@inkeep/open-knowledge-server';
import { clearEmbeddingsKeyFromAllBackends } from '../auth/embeddings-key-store.ts';
import { clearTokenFromAllBackends } from '../auth/token-store.ts';
import {
  DESKTOP_LEGACY_PRODUCT_NAME,
  desktopUserDataDir,
  stateDirIsOurs,
} from '../integrations/desktop-state.ts';
import {
  extraSymlinkStillOurs,
  type PathInstallMarker,
  stripManagedPathBlock,
} from '../integrations/path-shim.ts';
import { userGlobalSkillBundleTargets } from '../integrations/skill-teardown.ts';
import { assertProjectRemovalSafe } from '../integrations/write-project-skill.ts';
import {
  getExcludedOkPaths,
  getOkArtifactPaths,
  removeOkPathsFromGitExclude,
} from '../sharing/git-exclude.ts';
import { ALL_EDITOR_IDS, EDITOR_TARGETS, type EditorId } from './editors.ts';
import { existingFileMode } from './jsonc-surgical.ts';
import { removeOwnLaunchEntry } from './launch-json-removal.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';
import { runStop } from './stop.ts';

// ---------------------------------------------------------------------------
// Op model
// ---------------------------------------------------------------------------

/** Section a `RemovalOp` renders under in the confirmable plan. */
export type RemovalGroup = string;

/**
 * A single removal operation, as pure data. The executor interprets `kind`; no
 * op carries a closure so plans stay serializable + comparable (for `--json`
 * and tests).
 */
export type RemovalOp =
  | { kind: 'stop-server'; group: RemovalGroup; label: string; lockDir: string }
  | { kind: 'keychain-token'; group: RemovalGroup; label: string; host: string }
  | { kind: 'embeddings-key'; group: RemovalGroup; label: string }
  | { kind: 'shell-block'; group: RemovalGroup; label: string; rcFile: string }
  | { kind: 'extra-symlink'; group: RemovalGroup; label: string; path: string; target: string }
  | {
      kind: 'mcp-entry';
      group: RemovalGroup;
      label: string;
      editorId: EditorId;
      scope: 'user' | 'project';
      cwd: string;
      home: string;
      /** Explicit config path (project scope); user scope resolves from the target. */
      configPath?: string;
    }
  | { kind: 'launch-entry'; group: RemovalGroup; label: string; projectRoot: string }
  | { kind: 'git-exclude'; group: RemovalGroup; label: string; projectRoot: string }
  | {
      kind: 'remove-path';
      group: RemovalGroup;
      label: string;
      path: string;
      /** Child names under `path` to KEEP (the `~/.ok/skills` carve-out). */
      preserve?: string[];
      /** Only remove when `path`'s `state.json` proves it is ours (legacy dir). */
      requireOurState?: boolean;
      /**
       * Assert `path` is contained within this project root before removing
       * (via `assertProjectRemovalSafe`) — set for project-scoped removals so
       * a planted ancestor symlink (a `.claude -> /etc` in a cloned repo) or a
       * poisoned skill name in `installed-skills.json` can't route the `rmSync`
       * outside the project. A symlink at `path` itself is fine (OK's skill
       * projections are symlinks; removal unlinks the link, not its target).
       * Unset for out-of-project targets (`~/.ok`, `~/Library`, the shadow
       * repo — which legitimately lives outside a linked worktree).
       */
      containWithin?: string;
    };

export interface RemovalPlan {
  scope: 'uninstall' | 'deinit';
  ops: RemovalOp[];
}

/** Per-op result. `not-present` = nothing was there (a clean no-op);
 *  `skipped` = deliberately left (foreign config, unverified dir);
 *  `failed` = an error the run isolated + continued past. */
type RemovalStatus = 'removed' | 'not-present' | 'skipped' | 'failed';

interface RemovalOpResult {
  op: RemovalOp;
  status: RemovalStatus;
  /** Bounded human detail — a decline reason, a foreign marker, an error, or a
   *  manual-removal hint. Never config contents. */
  detail?: string;
}

export interface RemovalOutcome {
  results: RemovalOpResult[];
  removed: RemovalOpResult[];
  failed: RemovalOpResult[];
}

// ---------------------------------------------------------------------------
// Plan builders (pure)
// ---------------------------------------------------------------------------

function tildify(p: string, home: string): string {
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** POSIX-ify a project-relative path for comparison against `getOkArtifactPaths`. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * The per-project removal ring — reused by `ok deinit` AND by `ok uninstall`'s
 * recent-projects sweep. Removes that project's OK footprint while leaving the
 * user's markdown content untouched.
 */
export function deinitOps(
  projectRoot: string,
  home: string,
  group: RemovalGroup = 'This project',
): RemovalOp[] {
  const ops: RemovalOp[] = [];

  // 1. Stop that project's server first, so no process outlives its files.
  ops.push({
    kind: 'stop-server',
    group,
    label: 'Stop the project server (if running)',
    lockDir: resolveLockDir(projectRoot),
  });

  // 2. Surgically remove OK's own entry from each project MCP config (shared
  //    files — a user's other servers are preserved).
  const mcpRelPaths = new Set<string>();
  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    if (!target.projectConfigPath) continue;
    const configPath = target.projectConfigPath(projectRoot);
    mcpRelPaths.add(toPosix(relative(projectRoot, configPath)));
    ops.push({
      kind: 'mcp-entry',
      group,
      label: `Remove OK's MCP entry from ${target.label} (${toPosix(relative(projectRoot, configPath))})`,
      editorId: id,
      scope: 'project',
      cwd: projectRoot,
      home,
      configPath,
    });
  }

  // 3. Surgically remove OK's launch.json entry (shared file; user configs kept).
  ops.push({
    kind: 'launch-entry',
    group,
    label: "Remove OK's entry from .claude/launch.json",
    projectRoot,
  });

  // 4. Strip OK's lines from .git/info/exclude.
  ops.push({
    kind: 'git-exclude',
    group,
    label: 'Remove OK paths from .git/info/exclude',
    projectRoot,
  });

  // 5. Whole-remove the OK-owned dirs/files — everything in the artifact set
  //    EXCEPT the surgically-handled MCP configs + launch.json.
  for (const rel of getOkArtifactPaths(projectRoot)) {
    const bare = rel.replace(/\/$/, '');
    if (mcpRelPaths.has(bare)) continue; // handled surgically
    if (bare === '.claude/launch.json') continue; // handled by launch-entry
    ops.push({
      kind: 'remove-path',
      group,
      label: `Remove ${rel}`,
      path: join(projectRoot, bare),
      // These paths (incl. skill-projection dirs whose names come from
      // installed-skills.json) live under the project — guard the rmSync against
      // a symlink/poisoned-name escape, matching the write side.
      containWithin: projectRoot,
    });
  }

  // 6. The shadow repo (`<gitdir>/ok/`). A malformed/absent .git pointer means
  //    there is nothing to remove.
  try {
    ops.push({
      kind: 'remove-path',
      group,
      label: 'Remove the OK shadow repo (.git/ok/)',
      path: resolveShadowDir(projectRoot),
    });
  } catch {
    // No resolvable gitdir — no shadow repo to sweep.
  }

  return ops;
}

export function buildDeinitPlan(projectRoot: string, home: string): RemovalPlan {
  return { scope: 'deinit', ops: deinitOps(projectRoot, home) };
}

export interface UninstallPlanInput {
  home: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** GitHub host whose keychain token to clear (default `github.com`). */
  host: string;
  /** Live server lock dirs (from `discoverLockDirs()`). */
  lockDirs: string[];
  /** The PATH-install manifest (from `readPathInstallMarker(home)`), or null. */
  marker: PathInstallMarker | null;
  /** Project roots the user chose to `deinit` in the recent-projects sweep. */
  recentDeinitProjectRoots: string[];
  /** Also remove user-authored content (`~/.ok/skills/`). */
  purgeContent: boolean;
}

/**
 * The full machine removal plan. Ordered: stop servers → credentials → PATH
 * shim → editor configs → skill bundles → application data → recent projects →
 * the `~/.ok` machinery dir LAST.
 */
export function buildUninstallPlan(input: UninstallPlanInput): RemovalPlan {
  const { home, platform, host, lockDirs, marker, recentDeinitProjectRoots, purgeContent } = input;
  const ops: RemovalOp[] = [];

  // 1. Stop every running server.
  for (const lockDir of lockDirs) {
    ops.push({
      kind: 'stop-server',
      group: 'Running servers',
      label: `Stop server at ${tildify(join(lockDir, '..', '..'), home)}`,
      lockDir,
    });
  }

  // 2. Credentials (keychain token + embeddings key; the auth.yml / secrets.yml
  //    files are swept with ~/.ok, but the keychain token is out-of-dir).
  ops.push({
    kind: 'keychain-token',
    group: 'Credentials',
    label: `Remove the GitHub credential (${host}) from the OS keychain + auth.yml`,
    host,
  });
  ops.push({
    kind: 'embeddings-key',
    group: 'Credentials',
    label: 'Remove the embeddings API key (secrets.yml)',
  });

  // 3. PATH shim revert — strip the managed block from each recorded rc file and
  //    remove recorded extra symlinks (both live OUTSIDE ~/.ok).
  ops.push(...pathRevertOps(marker, home));

  // 4. Editor MCP configs (user-global, surgical).
  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    let configPath: string;
    try {
      configPath = target.configPath('', home);
    } catch {
      continue; // platform-unavailable target (e.g. Claude Desktop on Linux)
    }
    ops.push({
      kind: 'mcp-entry',
      group: 'Editor MCP configs',
      label: `Remove OK's MCP entry from ${target.label} (${tildify(configPath, home)})`,
      editorId: id,
      scope: 'user',
      cwd: home,
      home,
      configPath,
    });
  }

  // 5. Skill bundles (built-in discovery + write-skill; central + per-host).
  for (const target of userGlobalSkillBundleTargets(home)) {
    ops.push({
      kind: 'remove-path',
      group: 'Skill bundles',
      label: `Remove ${tildify(target.path, home)}`,
      path: target.path,
    });
  }

  // 6. Application data (macOS desktop) — the current + identity-gated legacy
  //    userData dirs and the updater cache.
  ops.push(...applicationDataOps(home, platform, input.env));

  // 7. Recent projects — each selected project runs the deinit ring.
  for (const projectRoot of recentDeinitProjectRoots) {
    ops.push(...deinitOps(projectRoot, home, `Project: ${basename(projectRoot)}`));
  }

  // 8. The ~/.ok machinery dir LAST (preserving user-authored skills unless
  //    --purge-content), so the run's file logger under ~/.ok/logs survives.
  ops.push({
    kind: 'remove-path',
    group: 'Global directory',
    label: purgeContent
      ? 'Remove ~/.ok (including user-authored skills)'
      : 'Remove ~/.ok (keeping ~/.ok/skills)',
    path: join(home, '.ok'),
    preserve: purgeContent ? undefined : ['skills'],
  });

  return { scope: 'uninstall', ops };
}

/**
 * The rc files the desktop installer's `rcTargets` can write the managed block
 * into. Checked directly (independent of the marker) because the block is
 * SELF-IDENTIFYING via its fence markers — see `pathRevertOps`.
 */
function standardRcFiles(home: string): string[] {
  return [
    join(home, '.zshrc'),
    join(home, '.bash_profile'),
    join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish'),
  ];
}

/**
 * PATH-shim revert ops.
 *
 * The managed rc block is stripped from the standard rc locations AND any
 * marker-recorded rc file — NOT only the marker's list. The block is
 * self-identifying (`# >>> open-knowledge cli >>>` … `<<<`), so it can be found
 * and removed WITHOUT the manifest; relying on the marker alone left the block
 * behind whenever the manifest was absent (a prior partial uninstall that
 * already removed `~/Library/.../OpenKnowledge`, an older install, or an
 * unreadable manifest) — the exact "won't fully leave" failure this exists to
 * prevent. Only rc files that exist are listed; the executor additionally
 * no-ops any file that turns out to hold no OK block.
 *
 * Extra symlinks live in arbitrary bin dirs and are NOT self-identifying, so
 * those still come only from the manifest.
 */
function pathRevertOps(marker: PathInstallMarker | null, home: string): RemovalOp[] {
  const ops: RemovalOp[] = [];
  const rcCandidates = new Set([...standardRcFiles(home), ...(marker?.rcFiles ?? [])]);
  for (const rcFile of rcCandidates) {
    if (!existsSync(rcFile)) continue;
    ops.push({
      kind: 'shell-block',
      group: 'Shell PATH',
      label: `Strip the OK block from ${tildify(rcFile, home)}`,
      rcFile,
    });
  }
  for (const extra of marker?.extraSymlinks ?? []) {
    ops.push({
      kind: 'extra-symlink',
      group: 'Shell PATH',
      label: `Remove the ok symlink at ${tildify(extra.path, home)}`,
      path: extra.path,
      target: extra.target,
    });
  }
  return ops;
}

/**
 * macOS desktop application-data dirs (current + identity-gated legacy userData,
 * updater cache). Empty on non-macOS: OK Desktop is macOS-only, so the app-data
 * surface is simply absent elsewhere (OK Desktop is macOS-only).
 */
function applicationDataOps(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined,
): RemovalOp[] {
  if (platform !== 'darwin') return [];
  const options = { home, platformName: platform, env };

  const current = desktopUserDataDir(options);
  // The legacy dir name is generic ("Open Knowledge") — another vendor could own
  // it — so it is ONLY removed when its state.json proves it is ours.
  const legacy = desktopUserDataDir({ ...options, productName: DESKTOP_LEGACY_PRODUCT_NAME });
  const updaterCache = join(home, 'Library', 'Caches', 'OpenKnowledge-updater');

  return [
    {
      kind: 'remove-path',
      group: 'Application data',
      label: `Remove ${tildify(current, home)}`,
      path: current,
    },
    {
      kind: 'remove-path',
      group: 'Application data',
      label: `Remove ${tildify(legacy, home)} (only if it is OpenKnowledge's)`,
      path: legacy,
      requireOurState: true,
    },
    {
      kind: 'remove-path',
      group: 'Application data',
      label: `Remove ${tildify(updaterCache, home)}`,
      path: updaterCache,
    },
  ];
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface RunRemovalDeps {
  /** Clear the keychain token + auth.yml. Injectable (touches the real keychain). */
  clearToken?: (
    host: string,
  ) => Promise<{ touched: Array<'keychain' | 'file'>; keychainError?: string }>;
  /** Clear the embeddings key. Injectable (touches ~/.ok/secrets.yml). */
  clearEmbeddingsKey?: () => Promise<{ touched: Array<'file'> }>;
  /**
   * Stop a server. Injectable (SIGTERMs real processes). Returns both the count
   * stopped AND any stops that FAILED — `runStop` reports a failed SIGTERM
   * (EPERM, etc.) by return value, not by throwing, so the executor must inspect
   * `failed` to avoid deleting files out from under a still-running server.
   */
  stopServer?: (lockDir: string) => {
    stopped: number;
    failed: Array<{ pid: number; error: string }>;
  };
}

/**
 * Execute a removal plan, op by op, isolating every failure. Async because the
 * credential ops are. Returns `{ results, removed, failed }`.
 */
export async function runRemoval(
  plan: RemovalPlan,
  deps: RunRemovalDeps = {},
): Promise<RemovalOutcome> {
  const clearToken = deps.clearToken ?? clearTokenFromAllBackends;
  const clearEmbeddingsKey = deps.clearEmbeddingsKey ?? clearEmbeddingsKeyFromAllBackends;
  const stopServer =
    deps.stopServer ??
    ((lockDir: string) => {
      const outcome = runStop({ lockDir, log: () => {}, error: () => {} });
      return {
        stopped: outcome.stopped.length,
        failed: outcome.failed.map((f) => ({ pid: f.target.pid, error: f.error })),
      };
    });

  const results: RemovalOpResult[] = [];
  for (const op of plan.ops) {
    try {
      results.push(await executeOp(op, { clearToken, clearEmbeddingsKey, stopServer }));
    } catch (err) {
      results.push({
        op,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    removed: results.filter((r) => r.status === 'removed'),
    failed: results.filter((r) => r.status === 'failed'),
  };
}

type ResolvedDeps = Required<RunRemovalDeps>;

async function executeOp(op: RemovalOp, deps: ResolvedDeps): Promise<RemovalOpResult> {
  switch (op.kind) {
    case 'stop-server': {
      const { stopped, failed } = deps.stopServer(op.lockDir);
      if (failed.length > 0) {
        // A SIGTERM that failed (EPERM, foreign-host live PID) means a process
        // may still be holding the files this run is about to remove. Surface it
        // as failed so the exit code + summary reflect it and the user is warned
        // — the run continues (per-op isolation), matching the SIGTERM-only,
        // don't-await-exit stop model.
        const detail = failed.map((f) => `pid ${f.pid}: ${f.error}`).join('; ');
        return {
          op,
          status: 'failed',
          detail: `could not stop the server (${detail}); a process may still be using files that were removed`,
        };
      }
      return { op, status: stopped > 0 ? 'removed' : 'not-present' };
    }
    case 'keychain-token': {
      const { touched, keychainError } = await deps.clearToken(op.host);
      if (keychainError) {
        // a locked/permission-denied keychain never aborts the run — mark
        // it unresolved + hand the user a manual-removal recipe.
        return {
          op,
          status: 'failed',
          detail: `keychain unreachable (${keychainError}); remove manually: Keychain Access → service "open-knowledge"`,
        };
      }
      return { op, status: touched.length > 0 ? 'removed' : 'not-present' };
    }
    case 'embeddings-key': {
      const { touched } = await deps.clearEmbeddingsKey();
      return { op, status: touched.length > 0 ? 'removed' : 'not-present' };
    }
    case 'shell-block': {
      if (!existsSync(op.rcFile)) return { op, status: 'not-present' };
      const before = readFileSync(op.rcFile, 'utf-8');
      const { text, changed, emptyAfter } = stripManagedPathBlock(before);
      if (!changed) return { op, status: 'not-present' };
      if (emptyAfter) {
        // The file was OK-owned (e.g. the fish conf) — nothing left, delete it.
        rmSync(op.rcFile, { force: true });
        return { op, status: 'removed', detail: 'file removed (was OK-owned)' };
      }
      // Atomic write + mode preservation, matching the sibling config-removal
      // paths — an interrupted write must never truncate a user's rc file.
      atomicWriteFileSync(op.rcFile, text, { mode: existingFileMode(op.rcFile) });
      return { op, status: 'removed' };
    }
    case 'extra-symlink': {
      if (!extraSymlinkStillOurs(op.path, op.target)) return { op, status: 'not-present' };
      unlinkSync(op.path);
      return { op, status: 'removed' };
    }
    case 'mcp-entry': {
      const outcome = removeOwnMcpEntry(
        EDITOR_TARGETS[op.editorId],
        op.cwd,
        op.home,
        op.configPath,
      );
      switch (outcome.kind) {
        case 'removed':
          return { op, status: 'removed' };
        case 'not-present':
          return { op, status: 'not-present' };
        case 'left-foreign':
          return { op, status: 'skipped', detail: 'left a non-OK server in place' };
        case 'declined':
          return { op, status: 'skipped', detail: `declined (${outcome.reason})` };
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unhandled mcp-remove outcome: ${(_exhaustive as { kind: string }).kind}`,
          );
        }
      }
    }
    case 'launch-entry': {
      const outcome = removeOwnLaunchEntry(op.projectRoot);
      switch (outcome.kind) {
        case 'removed':
        case 'removed-file':
          return { op, status: 'removed' };
        case 'not-present':
          return { op, status: 'not-present' };
        case 'declined':
          return { op, status: 'skipped', detail: 'declined (unparseable)' };
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unhandled launch-remove outcome: ${(_exhaustive as { kind: string }).kind}`,
          );
        }
      }
    }
    case 'git-exclude': {
      const excluded = getExcludedOkPaths(op.projectRoot);
      if (excluded.length === 0) return { op, status: 'not-present' };
      const result = removeOkPathsFromGitExclude(
        op.projectRoot,
        getOkArtifactPaths(op.projectRoot),
      );
      // `removeOkPathsFromGitExclude` reports a write failure by RETURN value
      // (`{kind:'no-exclude', reason:'inaccessible'}`) — the outer try/catch
      // can't see it — so a failed write to `.git/info/exclude` (EACCES / EROFS /
      // ENOSPC) must surface here rather than be reported as removed.
      if (result.kind === 'no-exclude') {
        return result.reason === 'inaccessible'
          ? { op, status: 'failed', detail: 'could not write .git/info/exclude (inaccessible)' }
          : { op, status: 'not-present', detail: result.reason };
      }
      return { op, status: result.removed.length > 0 ? 'removed' : 'not-present' };
    }
    case 'remove-path':
      return executeRemovePath(op);
  }
}

function executeRemovePath(op: Extract<RemovalOp, { kind: 'remove-path' }>): RemovalOpResult {
  if (op.requireOurState && !stateDirIsOurs(op.path)) {
    return { op, status: 'skipped', detail: 'not verified as OpenKnowledge — left untouched' };
  }
  // For project-scoped removals, refuse to rmSync through a symlinked ANCESTOR
  // that escapes the project (a planted `.claude -> /etc`). Throws on escape →
  // caught by the per-op try/catch as `failed` (the safe direction). A symlink
  // AT the path is allowed: OK installs skill projections as symlinks, and
  // removal unlinks the link itself without touching its target.
  if (op.containWithin) {
    assertProjectRemovalSafe(op.path, op.containWithin);
  }
  // lstat, not existsSync: existsSync follows the leaf, so a DANGLING
  // projection symlink (target already swept) would read as absent and the
  // orphan link would be left behind.
  let leafStat: ReturnType<typeof lstatSync> | undefined;
  try {
    leafStat = lstatSync(op.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!leafStat) return { op, status: 'not-present' };

  if (leafStat.isSymbolicLink()) {
    unlinkSync(op.path);
    return { op, status: 'removed' };
  }

  if (op.preserve && op.preserve.length > 0) {
    // Remove every child EXCEPT the preserved names, leaving the dir itself
    // (with the preserved children) in place — the ~/.ok/skills carve-out.
    const keep = new Set(op.preserve);
    let removedAny = false;
    for (const entry of readdirSync(op.path)) {
      if (keep.has(entry)) continue;
      rmSync(join(op.path, entry), { recursive: true, force: true });
      removedAny = true;
    }
    return { op, status: removedAny ? 'removed' : 'not-present' };
  }

  rmSync(op.path, { recursive: true, force: true });
  return { op, status: 'removed' };
}
