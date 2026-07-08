/**
 * Shadow repo — attribution journal at `<gitdir>/ok/`.
 *
 * A bare repo (core.bare unset, core.worktree → project root) that stores
 * per-writer WIP refs and upstream-import commits. Isolated from the project
 * repo so user staging area and history are never touched.
 *
 * Path layout (worktree-aware; resolved via `resolveShadowDir`):
 *   - Main worktree: `<projectRoot>/.git/ok/` (`.git` is a directory).
 *   - Linked worktree: `<repo>/.git/worktrees/<name>/ok/` (`.git` is a pointer
 *     file; per-worktree shadow lives inside Git's per-worktree admin dir and
 *     is cleaned up automatically by `git worktree remove`).
 *   - Subfolder of an existing repo (no `<projectRoot>/.git`): walks up to the
 *     enclosing repo's gitdir and hosts the shadow at
 *     `<ancestorGitDir>/ok-<slug>/`, where `<slug>` is derived from the path
 *     from the ancestor down to `projectRoot`. The `ok-<slug>` namespace
 *     prevents two `.ok/` projects sharing one parent gitdir from colliding
 *     on refs / tree paths. The walk avoids materialising a shell `.git/`
 *     inside the subfolder, which would otherwise trick `ensureProjectGit`'s
 *     shell-repair branch on the next boot.
 *   - Projects without `.git/` get auto-init'd by `ensureProjectGit` before
 *     `initShadowRepo` runs (fail-fast).
 *   - Pre-spec integrated shadows at `.git/openknowledge/` (legacy path) are
 *     silently rename-migrated in-place once per repo (legacy-rename shim below).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AutoConsolidationTrigger,
  formatCheckpointBodyLine,
  formatCheckpointSubject,
  formatImportSubject,
  formatOkActor,
  formatParkSubject,
  type OkActorEntry,
  type ParsedCheckpoint,
  parseCheckpoint,
  parseWriterId,
  resolveShadowDir,
  type WriterClassification,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { listTreeLongEntries } from './git-paths.ts';
import { incrementShadowMigrationLegacyRefsDeleted } from './metrics.ts';
import { acquireLock, releaseLock } from './shadow-lock.ts';
import { withSpan } from './telemetry.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShadowHandle {
  gitDir: string;
  workTree: string;
}

/** Mutable ref to a ShadowHandle — allows deferred initialization after construction. */
export interface ShadowRef {
  current: ShadowHandle | undefined;
}

export interface WriterIdentity {
  id: string;
  name: string;
  email: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Per-op timeout for shadow-repo git invocations. Default 30s. Override via
 * `OK_GIT_TIMEOUT_MS` for slow storage (NFS, heavily-used filesystems) or
 * intentionally-low values in tests that exercise timeout failure paths.
 * Invalid / non-positive values fall back to the 30s default.
 */
const GIT_TIMEOUT_MS = (() => {
  const raw = process.env.OK_GIT_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

/**
 * Dedicated long timeout for shadow-repo MAINTENANCE git ops (gc/repack/prune).
 * Default 10 min. A quiet `git gc` on a large backlog routinely runs longer than
 * the 30s block watchdog (`GIT_TIMEOUT_MS`); reusing that watchdog would kill the
 * pack mid-run and thrash kill-retry. Override via
 * `OK_SHADOW_MAINTENANCE_GC_TIMEOUT_MS`. Maintenance ops run off the write path
 * (coordinator-gated), so a long block here never stalls a user edit.
 */
export const MAINTENANCE_GIT_TIMEOUT_MS = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_GC_TIMEOUT_MS;
  if (!raw) return 600_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

/**
 * `gc.auto` threshold for the shadow repo. git only packs once
 * loose objects exceed this on an explicit `git gc --auto`. Shadow writes use
 * plumbing (commit-tree/update-ref), which never triggers git's built-in
 * auto-gc, so this threshold only governs the coordinator's explicit runs.
 */
const SHADOW_GC_AUTO = 512;

/**
 * Create a simple-git instance pointed at the shadow bare repo. Pass
 * `{ timeoutMs }` to use the dedicated maintenance timeout for gc/repack
 * (`MAINTENANCE_GIT_TIMEOUT_MS`); omit it for the default 30s op watchdog.
 */
export function shadowGit(shadow: ShadowHandle, opts?: { timeoutMs?: number }) {
  return simpleGit({
    baseDir: shadow.workTree,
    timeout: { block: opts?.timeoutMs ?? GIT_TIMEOUT_MS },
  }).env({
    GIT_DIR: shadow.gitDir,
    GIT_WORK_TREE: shadow.workTree,
  });
}

/**
 * Write the shadow repo's gc config. Idempotent — runs on EVERY
 * boot (not just first init) so existing degraded repos pick up the config
 * post-upgrade. `gc.autoDetach=false` keeps the coordinator's gc in the
 * foreground so its `gc.log` latch is observable; `writeCommitGraph` +
 * `changedPaths` Bloom filters bound path-filtered history walks (the sparse-
 * file read cost that otherwise grows linearly with total commit count).
 */
export async function configureShadowGc(shadow: ShadowHandle): Promise<void> {
  const sg = shadowGit(shadow);
  await sg.raw('config', 'gc.auto', String(SHADOW_GC_AUTO));
  await sg.raw('config', 'gc.autoDetach', 'false');
  await sg.raw('config', 'gc.writeCommitGraph', 'true');
  await sg.raw('config', 'commitGraph.changedPaths', 'true');
}

/** One WIP chain on a branch — its writer id, tip, classification, whether the
 *  tip is a park commit (branch-switch state that must never be folded), and the
 *  tip's committer time (for the TTL backstop's age check). */
export interface WipChainInfo {
  writerId: string;
  tipSha: string;
  classification: WriterClassification;
  isPark: boolean;
  /** Tip commit's committer time in ms since epoch (0 if unparseable). */
  committedAtMs: number;
}

/**
 * Enumerate every WIP chain on `branch` in ONE `for-each-ref`. The
 * tip subject comes straight from `%(contents:subject)`, so park detection costs
 * no extra git process per ref. Shared by the auto-consolidation path (filters to
 * dead agents) and the Save Version button (folds all non-park chains).
 */
export async function enumerateWipChains(
  shadow: ShadowHandle,
  branch: string,
): Promise<WipChainInfo[]> {
  const sg = shadowGit(shadow);
  let lines: string[];
  try {
    lines = (
      await sg.raw(
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)',
        `refs/wip/${branch}/`,
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  const out: WipChainInfo[] = [];
  for (const line of lines) {
    const [refname = '', tipSha = '', committerUnix = '', subject = ''] = line.split('\x00');
    // refs/wip/<branch>/<writerId> — writerId may itself contain slashes.
    const writerId = refname.split('/').slice(3).join('/');
    if (!writerId) continue;
    const unix = Number.parseInt(committerUnix, 10);
    out.push({
      writerId,
      tipSha,
      classification: parseWriterId(writerId).classification,
      isPark: subject.startsWith('park:'),
      committedAtMs: Number.isFinite(unix) ? unix * 1000 : 0,
    });
  }
  return out;
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize the shadow bare repo at `<gitdir>/ok/` — worktree-aware. The
 * exact path resolves to `<projectRoot>/.git/ok/` for a main checkout and to
 * `<repo>/.git/worktrees/<name>/ok/` for a linked worktree. Path resolution
 * lives in `@inkeep/open-knowledge-core/shadow-repo-layout` so the CLI read
 * path and this server write path follow the same rule.
 *
 * Assumes the project already has a `.git/` (file or directory) —
 * `ensureProjectGit` is responsible for that guarantee upstream.
 *
 * Legacy migration: if a pre-rename `<projectRoot>/.git/openknowledge/` dir
 * exists from a pre-spec integrated-mode install, silently `renameSync` it to
 * the canonical `<gitdir>/ok/` path. One-shot, lossless — preserves all refs
 * and commits. Defensive: if BOTH directories are present (shouldn't happen),
 * log and no-op. The shim runs against the resolved shadow path, so a linked
 * worktree on its first boot post-upgrade will not see the legacy dir at the
 * common-dir location until the user next boots OK in the main worktree.
 */
export async function initShadowRepo(projectRoot: string): Promise<ShadowHandle> {
  // Path resolution lives in @inkeep/open-knowledge-core so the CLI read path
  // and this server write path use exactly the same rule.
  const shadowDir = resolveShadowDir(projectRoot);

  // legacy-rename shim — runs before any other shadow op.
  const legacyDir = resolve(projectRoot, '.git/openknowledge');
  const legacyExists = existsSync(legacyDir);
  const newExists = existsSync(shadowDir);
  if (legacyExists && !newExists) {
    tracedRenameSync(legacyDir, shadowDir);
  } else if (legacyExists && newExists) {
    console.warn('[shadow-repo] unexpected legacy + new shadow both present — no rename performed');
  }

  // Skip init if already valid
  const alreadyInit = existsSync(resolve(shadowDir, 'HEAD'));
  if (!alreadyInit) {
    tracedMkdirSync(shadowDir, { recursive: true });

    const git = simpleGit({ baseDir: projectRoot, timeout: { block: GIT_TIMEOUT_MS } });
    await git.raw('init', '--bare', shadowDir);

    const sg = simpleGit({ timeout: { block: GIT_TIMEOUT_MS } }).env({ GIT_DIR: shadowDir });
    await sg.raw('config', '--unset', 'core.bare');
    await sg.raw('config', 'core.worktree', projectRoot);
    await sg.raw('config', 'user.name', 'openknowledge');
    await sg.raw('config', 'user.email', 'noreply@openknowledge.local');
  }

  const handle: ShadowHandle = { gitDir: shadowDir, workTree: projectRoot };

  // Write gc config on every boot (idempotent) so an existing degraded repo
  // picks it up post-upgrade, not only freshly-initialized ones.
  // Best-effort: a config failure must never block boot or the writer lock.
  try {
    await configureShadowGc(handle);
  } catch (e) {
    console.warn('[shadow-repo] failed to write gc config (non-fatal):', e);
  }

  // Allowlist-based sweep of legacy WIP refs on every start.
  // Idempotent — no-op once all legacy refs are gone.
  await sweepLegacyShadowRefs(handle);

  // Sweep orphaned temp-index files left behind by crashed `buildWipTree`
  // calls from a prior process. Idempotent — no-op on a clean shutdown.
  sweepOrphanedTmpIndexFiles(handle);

  // Acquire exclusive writer lock
  acquireLock(shadowDir, projectRoot);

  return handle;
}

/**
 * Release the exclusive writer lock on a shadow repo.
 * Called during graceful shutdown.
 */
export function destroyShadowRepo(shadow: ShadowHandle): void {
  releaseLock(shadow.gitDir);
}

/**
 * Allowlist-based sweep of legacy WIP refs.
 *
 * Enumerates refs/wip/*\/\* and deletes ONLY refs whose writer-ID segment
 * matches the known-legacy patterns: exact `server`, prefix `human-`, exact
 * `upstream`. New-taxonomy refs (agent-*, principal-*, file-system,
 * git-upstream, openknowledge-service) are preserved unchanged.
 *
 * Idempotent: running twice is a no-op once legacy refs are gone.
 */
export async function sweepLegacyShadowRefs(shadow: ShadowHandle): Promise<number> {
  const sg = shadowGit(shadow);
  let allRefs: string[];
  try {
    const raw = await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip');
    allRefs = raw
      .trim()
      .split('\n')
      .filter((r) => r.length > 0);
  } catch {
    // No refs yet (fresh repo) — nothing to sweep
    return 0;
  }

  const toDelete: string[] = [];
  const breakdown: Record<string, number> = { server: 0, 'human-': 0, upstream: 0 };

  for (const refname of allRefs) {
    // refs/wip/<branch>/<writerId>
    const parts = refname.split('/');
    if (parts.length < 4) continue;
    const writerId = parts.slice(3).join('/');

    // Only delete refs that parseWriterId classifies as 'unknown' AND match
    // the known-legacy allowlist. This is deliberately narrow — we never
    // delete a ref we can't positively identify as legacy.
    const classification = parseWriterId(writerId).classification;
    if (classification !== 'unknown') continue;

    if (writerId === 'server') {
      toDelete.push(refname);
      breakdown.server++;
    } else if (writerId.startsWith('human-')) {
      toDelete.push(refname);
      breakdown['human-']++;
    } else if (writerId === 'upstream') {
      toDelete.push(refname);
      breakdown.upstream++;
    }
    // All other 'unknown' refs are preserved (defensive)
  }

  if (toDelete.length === 0) return 0;

  for (const ref of toDelete) {
    try {
      await sg.raw('update-ref', '-d', ref);
    } catch (e) {
      console.warn(`[shadow-migration] failed to delete legacy ref ${ref}:`, e);
    }
  }

  const deleted = toDelete.length;
  incrementShadowMigrationLegacyRefsDeleted(deleted);
  console.warn(
    `[shadow-migration] deleted ${deleted} legacy refs: server=${breakdown.server} human-=${breakdown['human-']} upstream=${breakdown.upstream}`,
  );

  return deleted;
}

// ─── WIP commits ─────────────────────────────────────────────────────────────

/**
 * Commit content changes to a per-writer, per-branch WIP ref in the shadow.
 *
 * Uses commit-tree plumbing with GIT_INDEX_FILE isolation so we never
 * touch any user-visible staging area.
 *
 * @param branch - Project branch name (e.g. 'main', 'feature/xyz'). When omitted, defaults to 'main'.
 */
export interface CommitWipOptions {
  /**
   * Explicit commit timestamp (any git-parseable date, e.g. ISO 8601), applied
   * to both author and committer date. Production leaves this unset so git
   * stamps the current time; tests pass distinct increasing values to make
   * commit ordering deterministic without real-time sleeps — git's committer
   * date has 1-second granularity, so two commits in the same second sort
   * ambiguously and would otherwise need a >1s wall-clock wait between them.
   */
  date?: string;
}

export async function commitWip(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  contentRoot: string,
  message: string,
  branch = 'main',
  opts?: CommitWipOptions,
): Promise<string> {
  return withSpan(
    'shadow.commitWip',
    {
      attributes: {
        'shadow.writer': writer.id,
        'shadow.branch': branch,
      },
    },
    async () => commitWipInner(shadow, writer, contentRoot, message, branch, opts?.date),
  );
}

async function commitWipInner(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  contentRoot: string,
  message: string,
  branch = 'main',
  date?: string,
): Promise<string> {
  const tmpIndex = resolve(shadow.gitDir, `index-wip-${writer.id}`);
  const ref = `refs/wip/${branch}/${writer.id}`;
  const sg = shadowGit(shadow);
  const gitPathspec = contentRoot || '.';

  try {
    // Seed index from current ref state (if exists)
    try {
      const refTree = (await sg.raw('rev-parse', `${ref}^{tree}`)).trim();
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('read-tree', refTree);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unknown revision') || msg.includes('bad revision')) {
        // Expected: first commit on this ref — start fresh
      } else {
        console.error(`[shadow-repo] Unexpected error seeding index for ${ref}:`, e);
        throw e;
      }
    }

    // Stage content files
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: tmpIndex,
      })
      .raw('add', gitPathspec);
    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    // Find parent
    let parentSha: string | null = null;
    try {
      parentSha = (await sg.raw('rev-parse', ref)).trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
        console.error(`[shadow-repo] Unexpected error resolving ${ref}:`, e);
        throw e;
      }
      // Expected: no parent — first commit on this ref
    }

    // Create commit with writer identity
    const args = ['commit-tree', treeSha, '-m', message];
    if (parentSha) args.push('-p', parentSha);

    const commitEnv: Record<string, string> = {
      GIT_DIR: shadow.gitDir,
      GIT_AUTHOR_NAME: writer.name,
      GIT_AUTHOR_EMAIL: writer.email,
      GIT_COMMITTER_NAME: 'openknowledge',
      GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
    };
    if (date) {
      commitEnv.GIT_AUTHOR_DATE = date;
      commitEnv.GIT_COMMITTER_DATE = date;
    }
    const commitSha = (await sg.env(commitEnv).raw(...args)).trim();

    await sg.raw('update-ref', ref, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {
      // ignore cleanup failure
    }
  }
}

// ─── Per-writer fan-out helpers ────────────────────────────────────────────

/**
 * Stage the content directory and return a git tree SHA.
 * Used by the per-writer L2 fan-out so all writers share the same tree.
 * Uses a fresh index (no seeding from any ref) so the tree reflects
 * current filesystem state of contentRoot.
 */
/**
 * Sweep orphaned `index-wip-fanout-*` files left in the shadow gitDir by a
 * crashed `buildWipTree` call from a prior process. Each entry is a transient
 * index scratch file; the owning process is always gone by the time we run
 * (initShadowRepo acquires an exclusive writer lock immediately after), so
 * unconditional deletion is safe.
 */
function sweepOrphanedTmpIndexFiles(shadow: ShadowHandle): number {
  let deleted = 0;
  try {
    for (const name of readdirSync(shadow.gitDir)) {
      if (!name.startsWith('index-wip-fanout-')) continue;
      try {
        rmSync(resolve(shadow.gitDir, name));
        deleted++;
      } catch {
        // best effort — next startup will retry
      }
    }
  } catch {
    // gitDir missing or unreadable — initShadowRepo will catch the real error
  }
  return deleted;
}

export async function buildWipTree(shadow: ShadowHandle, contentRoot: string): Promise<string> {
  const tmpIndex = resolve(shadow.gitDir, `index-wip-fanout-${randomUUID()}`);
  const sg = shadowGit(shadow);
  const gitPathspec = contentRoot || '.';

  try {
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: tmpIndex,
      })
      .raw('add', gitPathspec);
    return (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Create a commit from a pre-built tree SHA and advance the per-writer WIP ref.
 * All per-writer commits in one fan-out cycle share the same treeSha.
 */
export async function commitWipFromTree(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  treeSha: string,
  message: string,
  branch = 'main',
): Promise<string> {
  return withSpan(
    'shadow.commitWipFromTree',
    {
      attributes: {
        'shadow.writer': writer.id,
        'shadow.branch': branch,
        'shadow.tree': treeSha.slice(0, 8),
      },
    },
    async () => commitWipFromTreeInner(shadow, writer, treeSha, message, branch),
  );
}

async function commitWipFromTreeInner(
  shadow: ShadowHandle,
  writer: WriterIdentity,
  treeSha: string,
  message: string,
  branch = 'main',
): Promise<string> {
  const ref = `refs/wip/${branch}/${writer.id}`;
  const sg = shadowGit(shadow);

  let parentSha: string | null = null;
  try {
    parentSha = (await sg.raw('rev-parse', ref)).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('unknown revision') && !msg.includes('bad revision')) {
      console.error(`[shadow-repo] Unexpected error resolving ${ref}:`, e);
      throw e;
    }
  }

  const args = ['commit-tree', treeSha, '-m', message];
  if (parentSha) args.push('-p', parentSha);

  const commitSha = (
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_AUTHOR_NAME: writer.name,
        GIT_AUTHOR_EMAIL: writer.email,
        GIT_COMMITTER_NAME: 'openknowledge',
        GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
      })
      .raw(...args)
  ).trim();

  await sg.raw('update-ref', ref, commitSha);
  return commitSha;
}

// ─── Classified writer-identity constants ─────────────────────────────────

/** Non-attributable file-system writes (disk changes, reconciliation). */
export const FILE_SYSTEM_WRITER: WriterIdentity = {
  id: 'file-system',
  name: 'File System',
  email: 'file-system@openknowledge.local',
};

/** Non-attributable upstream git-pull imports. */
export const GIT_UPSTREAM_WRITER: WriterIdentity = {
  id: 'git-upstream',
  name: 'Git (upstream)',
  email: 'git@openknowledge.local',
};

/** Non-attributable internal service bookkeeping. */
export const SERVICE_WRITER: WriterIdentity = {
  id: 'openknowledge-service',
  name: 'OpenKnowledge (service)',
  email: 'service@openknowledge.local',
};

// ─── Upstream import ─────────────────────────────────────────────────────────

const UPSTREAM_WRITER: WriterIdentity = GIT_UPSTREAM_WRITER;

/**
 * Record an upstream-import commit in the shadow.
 *
 * Called when HEAD moves (e.g., git pull) to attribute the incoming changes
 * to "upstream" in the attribution journal.
 *
 * @param branch - Project branch name for ref scoping. Defaults to 'main'.
 */
export async function commitUpstreamImport(
  shadow: ShadowHandle,
  contentRoot: string,
  oldHead: string | null,
  newHead: string,
  branch = 'main',
): Promise<string> {
  return withSpan(
    'shadow.commitUpstreamImport',
    { attributes: { 'shadow.branch': branch, 'shadow.new_head': newHead.slice(0, 8) } },
    async () => commitUpstreamImportInner(shadow, contentRoot, oldHead, newHead, branch),
  );
}

async function commitUpstreamImportInner(
  shadow: ShadowHandle,
  contentRoot: string,
  oldHead: string | null,
  newHead: string,
  branch = 'main',
): Promise<string> {
  const subject = formatImportSubject(oldHead, newHead);
  const actorEntry: OkActorEntry = {
    v: 1,
    writer_id: UPSTREAM_WRITER.id,
    principal: null,
    agent_session: null,
    agent_type: null,
    client_name: null,
    client_version: null,
    label: null,
    display_name: UPSTREAM_WRITER.name,
    color_seed: UPSTREAM_WRITER.id,
    docs: [],
  };
  const message = `${subject}\n\n${formatOkActor(actorEntry)}`;
  return commitWip(shadow, UPSTREAM_WRITER, contentRoot, message, branch);
}

// ─── Safety checkpoint ──────────────────────────────────────────────────────

/**
 * Generic safety-checkpoint primitive.
 *
 * Snapshots the current working tree to the shadow repo's WIP ref *before*
 * a destructive action so the user can recover pre-action state from the
 * timeline. Rollback is the first caller; future coarse actions (apply-draft,
 * etc.) reuse the same primitive.
 *
 * Inspired by Figma's "two checkpoints around restore" pattern — one before,
 * one after the destructive operation. The "after" checkpoint is handled by
 * the normal L2 persistence pipeline (commitWip on debounce).
 */
export interface SafetyCheckpointParams {
  action: string;
  context: Record<string, unknown>;
}

const SAFETY_WRITER: WriterIdentity = SERVICE_WRITER;

export async function safetyCheckpoint(
  shadow: ShadowHandle,
  contentRoot: string,
  params: SafetyCheckpointParams,
  branch = 'main',
): Promise<string> {
  const subject = formatCheckpointSubject(`pre-${params.action}`);
  const actorEntry: OkActorEntry = {
    v: 1,
    writer_id: SAFETY_WRITER.id,
    principal: null,
    agent_session: null,
    agent_type: null,
    client_name: null,
    client_version: null,
    label: null,
    display_name: SAFETY_WRITER.name,
    color_seed: SAFETY_WRITER.id,
    docs: [],
  };
  const message = `${subject}\n\n${formatOkActor(actorEntry)}`;
  return commitWip(shadow, SAFETY_WRITER, contentRoot, message, branch);
}

// ─── In-memory checkpoint ──────────────────

/**
 * Kind-discriminated parameters for {@link saveInMemoryCheckpoint}. Each
 * kind carries typed metadata that `parseCheckpoint` in
 * `@inkeep/open-knowledge-core/shadow-repo-layout` can round-trip.
 *
 * - `bridge-merge-loss` — Observer A Path B fired `mergeThreeWay`, the
 *   content-preservation post-condition flagged the result, and we want a
 *   silent Notion-style restore artifact on the timeline. `contents` is the
 *   pre-merge baseline (the state the user saw before the conflict merge).
 * - `producer-guard-loss` — Observer A's producer guard detected serialize
 *   output that fails structural legality (a fresh parse loses authored
 *   content) at the serialize boundary. `contents` is the pre-loss source (the
 *   last-good Y.Text); `construct` is a bounded, content-free locator of the
 *   danger-space node types present.
 * - `external-change-rescue` — an external disk write (reconcile-delete or
 *   branch-switch path) would otherwise have discarded dirty Y.Doc content.
 *   `contents` is the rescued in-memory markdown; `incomingDiskSha` names
 *   the disk SHA we chose over it.
 */
export type InMemoryCheckpointParams =
  | {
      kind: 'bridge-merge-loss';
      docName: string;
      contents: string;
      label: string;
      branch?: string;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'producer-guard-loss';
      docName: string;
      contents: string;
      label: string;
      branch?: string;
      metadata: { construct: string };
    }
  | {
      kind: 'external-change-rescue';
      docName: string;
      contents: string;
      label: string;
      branch?: string;
      metadata: { incomingDiskSha: string };
    };

/**
 * Silent in-memory checkpoint — writes `contents` as a blob at
 * `<docName>.md` in an isolated git tree, commits with body
 * `checkpoint: ${label}\n\nok-checkpoint-v1: ${JSON}`, and updates the ref
 * `refs/checkpoints/<branch>/<sha>`. Never touches `refs/wip/*` — this is a
 * one-shot recovery artifact, not part of the per-writer WIP chain
 * (contrast `saveVersion` which resets WIP).
 *
 * **Concurrent safety.** Each call uses a unique tmp-index file
 * name derived from a random UUID so two in-flight calls on the same shadow
 * do not contend at the index level. The ref-update is atomic at the git
 * layer. Callers fire-and-forget via `queueMicrotask(() =>
 * saveInMemoryCheckpoint(...).catch(...))` — the hot bridge-merge path
 * never awaits the commit.
 *
 * @returns the commit sha (which also appears in the ref name).
 */
export async function saveInMemoryCheckpoint(
  shadow: ShadowHandle,
  contentRoot: string,
  params: InMemoryCheckpointParams,
): Promise<string> {
  const branch = params.branch ?? 'main';
  const sg = shadowGit(shadow);
  const token = randomUUID();
  const tmpIndex = resolve(shadow.gitDir, `index-checkpoint-${token}`);
  const tmpBlobFile = resolve(shadow.gitDir, `tmp-checkpoint-blob-${token}`);

  // Path inside the tree mirrors the real content layout so TimelinePanel's
  // existing per-doc view logic (walks the tree at the commit's docName)
  // resolves identically for silent-checkpoint artifacts.
  const treePath = contentRoot
    ? `${contentRoot.replace(/\/$/, '')}/${params.docName}`
    : params.docName;
  // Byte-size of the rescued content; encoded in metadata so the rescue
  // read path can render the listing without spawning a per-ref `git ls-tree`
  // subprocess.
  const size = Buffer.byteLength(params.contents, 'utf-8');
  // Reconstruct the parsed shape per kind so each metadata type stays bound to
  // its own discriminant (the switch is exhaustive over InMemoryCheckpointParams).
  let parsed: ParsedCheckpoint;
  switch (params.kind) {
    case 'bridge-merge-loss':
      parsed = {
        kind: 'bridge-merge-loss',
        docName: params.docName,
        size,
        metadata: params.metadata,
      };
      break;
    case 'producer-guard-loss':
      parsed = {
        kind: 'producer-guard-loss',
        docName: params.docName,
        size,
        metadata: params.metadata,
      };
      break;
    case 'external-change-rescue':
      parsed = {
        kind: 'external-change-rescue',
        docName: params.docName,
        size,
        metadata: params.metadata,
      };
      break;
  }
  const bodyLine = formatCheckpointBodyLine(parsed);
  const message = `checkpoint: ${params.label}\n\n${bodyLine}`;

  try {
    tracedWriteFileSync(tmpBlobFile, params.contents, 'utf-8');
    const blobSha = (
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('hash-object', '-w', tmpBlobFile)
    ).trim();
    await sg
      .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
      .raw('update-index', '--add', '--cacheinfo', `100644,${blobSha},${treePath}`);
    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    const commitSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'openknowledge',
          GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
        })
        .raw('commit-tree', treeSha, '-m', message)
    ).trim();

    await sg.raw('update-ref', `refs/checkpoints/${branch}/${commitSha}`, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {
      // ignore cleanup failure
    }
    try {
      rmSync(tmpBlobFile);
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * A single `kind: 'external-change-rescue'` rescue entry reconstructed from
 * the shadow repo's `refs/checkpoints/<branch>/*` namespace. Shape mirrors
 * the flat-file rescue listing at `/api/rescue` so the two sources can be
 * merged into one unified response.
 */
export interface TimelineRescueEntry {
  docName: string;
  timestamp: string;
  size: number;
  /** Commit SHA of the checkpoint, so the caller can request the raw content. */
  sha: string;
  /** Commit message (first line); surfaces the human-readable label. */
  label: string;
  /** SHA of the incoming disk content that overrode the in-memory state. */
  incomingDiskSha: string;
}

/**
 * List every `external-change-rescue` checkpoint on `refs/checkpoints/<branch>/*`
 * by walking the refs, reading each commit's body via `parseCheckpoint`,
 * and filtering by kind. Does not walk ancestry — each ref is resolved
 * directly via `git log --no-walk`. Returns an empty array on any git error
 * to match the graceful-degradation posture of `getDocumentHistory`.
 *
 * `docName` + `size` are now read
 * from the parsed `ok-checkpoint-v1:` metadata body line. The per-ref
 * `git ls-tree` fan-out the prior implementation performed is retained
 * only as a backward-compat fallback for checkpoints written before the
 * metadata was enriched (none in a fresh install; included for robustness
 * on worktrees carrying earlier-iteration artifacts).
 */
export async function listRescueCheckpoints(
  shadow: ShadowHandle,
  branch = 'main',
): Promise<TimelineRescueEntry[]> {
  const sg = shadowGit(shadow);
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch {
    return [];
  }
  const shas = refOutput
    .trim()
    .split('\n')
    .filter((s) => s.length === 40);
  if (shas.length === 0) return [];

  let logRaw: string;
  try {
    logRaw = await sg.raw(
      'log',
      '--no-walk',
      '--author-date-order',
      '--format=%H%x00%aI%x00%s%x00%B%x1e',
      ...shas,
    );
  } catch {
    return [];
  }

  const out: TimelineRescueEntry[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', timestamp = '', subject = '', body = ''] = trimmed.split('\x00');
    const parsed = parseCheckpoint(body);
    if (parsed?.kind !== 'external-change-rescue') continue;

    // Fast path: metadata carries docName + size directly
    // Per-commit subprocess skipped in this path.
    let docName = parsed.docName ?? '';
    let size = parsed.size ?? 0;

    // Backward-compat fallback for any pre-enrichment checkpoints on this
    // branch. Safe no-op for fresh commits since the fast-path already
    // populated both fields.
    if (!docName) {
      try {
        const entry = (await listTreeLongEntries(sg, ['ls-tree', '-r', '--long', sha]))[0];
        if (entry) {
          if (size === 0) size = entry.size;
          docName =
            entry.path
              .replace(/\.mdx?$/, '')
              .split('/')
              .slice(-1)[0] ?? '';
        }
      } catch {
        // ignore — docName stays empty; caller treats as unparseable
      }
    }
    if (!docName) continue;
    out.push({
      docName,
      timestamp,
      size,
      sha,
      label: subject.replace(/^checkpoint:\s*/, ''),
      incomingDiskSha: parsed.metadata.incomingDiskSha,
    });
  }
  return out;
}

// ─── Checkpoint GC ────

/** Per-kind retention policy for `refs/checkpoints/<branch>/*`. */
export interface CheckpointRetentionPolicy {
  /**
   * Maximum `bridge-merge-loss` checkpoints to keep per branch. These are
   * written on every Observer A Path B post-condition violation. Default 50.
   */
  maxBridgeMergeLoss: number;
  /**
   * Maximum `producer-guard-loss` checkpoints to keep per branch. Written when
   * Observer A's producer guard detects illegal serialize output. Its own
   * budget so a stuck serializer cannot evict merge-drop recovery anchors (and
   * vice versa). Default 50.
   */
  maxProducerGuardLoss: number;
  /**
   * Maximum `external-change-rescue` checkpoints to keep per branch. These
   * are written on reconcile-delete / branch-switch disk-overrode-memory
   * paths. Default 50.
   */
  maxExternalChangeRescue: number;
  /**
   * Maximum `auto-consolidation` checkpoints to keep per branch.
   * These are service-authored when dead WIP chains are folded; left unbounded
   * they reintroduce the unbounded-hidden-ref growth this feature exists to
   * cure. Retention is COUNT-ONLY (TTL deliberately does NOT apply, see
   * `gcCheckpointRefs`): every checkpoint adopts the prior checkpoint as a
   * parent (chained), so the newest retained auto-checkpoint's ancestry
   * still reaches all older consolidated history — but only while at least one
   * survives, so TTL must never be able to reap them all. Default 2.
   */
  maxAutoConsolidation: number;
  /**
   * `ok-checkpoint-v1`-tagged checkpoints older than this TTL (ms) are
   * GC-eligible regardless of count. Default 30 days. `Save Version`
   * checkpoints (no `ok-checkpoint-v1:` body line) are NOT affected —
   * their retention was set at PR inception as permanent. Does NOT apply to
   * `auto-consolidation` (count-only — see `maxAutoConsolidation`).
   */
  ttlMs: number;
}

export const DEFAULT_CHECKPOINT_RETENTION: CheckpointRetentionPolicy = {
  maxBridgeMergeLoss: 50,
  maxProducerGuardLoss: 50,
  maxExternalChangeRescue: 50,
  maxAutoConsolidation: 2,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

export interface CheckpointGcResult {
  scanned: number;
  deletedBridgeMergeLoss: number;
  deletedProducerGuardLoss: number;
  deletedExternalChangeRescue: number;
  deletedAutoConsolidation: number;
  retained: number;
}

/**
 * GC `refs/checkpoints/<branch>/*` kind-aware: keep the most-recent N per
 * kind (per policy), delete older entries, apply TTL as a lower bound.
 * Untyped checkpoints (no `ok-checkpoint-v1:` body line — i.e. user-
 * triggered `Save Version` artifacts) are always retained to preserve the
 * permanent-history contract.
 *
 * Batched: single `for-each-ref` + single `git log --no-walk` regardless of
 * ref count. Deletion is one `update-ref -d` per eligible ref.
 */
export async function gcCheckpointRefs(
  shadow: ShadowHandle,
  branch = 'main',
  policy: CheckpointRetentionPolicy = DEFAULT_CHECKPOINT_RETENTION,
): Promise<CheckpointGcResult> {
  const result: CheckpointGcResult = {
    scanned: 0,
    deletedBridgeMergeLoss: 0,
    deletedProducerGuardLoss: 0,
    deletedExternalChangeRescue: 0,
    deletedAutoConsolidation: 0,
    retained: 0,
  };
  const sg = shadowGit(shadow);
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch {
    return result;
  }
  const refLines = refOutput
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (refLines.length === 0) return result;

  // Maintain the ref → sha mapping so we can delete by refname (stable even
  // if a future rewrite changes the sha-under-ref naming convention).
  const shaToRef = new Map<string, string>();
  const shas: string[] = [];
  for (const line of refLines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx < 0) continue;
    const sha = line.slice(0, spaceIdx);
    const ref = line.slice(spaceIdx + 1);
    if (sha.length !== 40) continue;
    shaToRef.set(sha, ref);
    shas.push(sha);
  }
  result.scanned = shas.length;
  if (shas.length === 0) return result;

  let logRaw: string;
  try {
    logRaw = await sg.raw(
      'log',
      '--no-walk',
      '--author-date-order',
      '--format=%H%x00%aI%x00%B%x1e',
      ...shas,
    );
  } catch {
    return result;
  }

  type TypedKind =
    | 'bridge-merge-loss'
    | 'producer-guard-loss'
    | 'external-change-rescue'
    | 'auto-consolidation';
  interface Entry {
    sha: string;
    timestamp: number; // ms since epoch
    kind: TypedKind | null;
  }
  const entries: Entry[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', timestamp = '', body = ''] = trimmed.split('\x00');
    if (!sha) continue;
    const parsed = parseCheckpoint(body);
    const kind = parsed?.kind ?? null;
    const ts = Date.parse(timestamp);
    entries.push({ sha, timestamp: Number.isFinite(ts) ? ts : 0, kind });
  }

  // Partition by kind. Save-Version (kind=null) entries are always retained.
  // This record MUST list every kind parseCheckpoint can return, or
  // `byKind[e.kind].push` throws on the unmapped kind: adding a new checkpoint
  // kind to the parser without adding it here is the bug this guards against.
  const byKind: Record<TypedKind, Entry[]> = {
    'bridge-merge-loss': [],
    'producer-guard-loss': [],
    'external-change-rescue': [],
    'auto-consolidation': [],
  };
  let retainedUntyped = 0;
  for (const e of entries) {
    if (e.kind === null) {
      retainedUntyped++;
      continue;
    }
    byKind[e.kind].push(e);
  }

  const now = Date.now();
  const deleteRefs: string[] = [];
  const planDeletions = (
    list: Entry[],
    limit: number,
    counter:
      | 'deletedBridgeMergeLoss'
      | 'deletedProducerGuardLoss'
      | 'deletedExternalChangeRescue'
      | 'deletedAutoConsolidation',
    // auto-consolidation is count-only: TTL must never be able to reap every
    // surviving auto-checkpoint, or the chained consolidated history it anchors
    // becomes unreachable. Pass false to disable the TTL lower bound.
    applyTtl = true,
  ): void => {
    // Newest first so the count-based keep-N is trivial.
    list.sort((a, b) => b.timestamp - a.timestamp);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry) continue;
      const overCount = i >= limit;
      const overTtl =
        applyTtl && policy.ttlMs > 0 && entry.timestamp > 0 && now - entry.timestamp > policy.ttlMs;
      if (overCount || overTtl) {
        const ref = shaToRef.get(entry.sha);
        if (ref) {
          deleteRefs.push(ref);
          result[counter]++;
        }
      }
    }
  };
  planDeletions(byKind['bridge-merge-loss'], policy.maxBridgeMergeLoss, 'deletedBridgeMergeLoss');
  planDeletions(
    byKind['producer-guard-loss'],
    policy.maxProducerGuardLoss,
    'deletedProducerGuardLoss',
  );
  planDeletions(
    byKind['external-change-rescue'],
    policy.maxExternalChangeRescue,
    'deletedExternalChangeRescue',
  );
  planDeletions(
    byKind['auto-consolidation'],
    policy.maxAutoConsolidation,
    'deletedAutoConsolidation',
    false,
  );

  for (const ref of deleteRefs) {
    try {
      await sg.raw('update-ref', '-d', ref);
    } catch (err) {
      console.warn('[checkpoint-gc] failed to delete', ref, err);
    }
  }

  result.retained = retainedUntyped + (result.scanned - deleteRefs.length - retainedUntyped);
  return result;
}

// ─── Park / Load / Restore ──────────────────────────────────────────────────

/** A document's serialized state for parking. */
export interface ParkableDoc {
  docName: string;
  /** Current Y.Doc serialized to markdown (from memory). */
  markdown: string;
  /** Last known disk content (reconciledBase) — used as merge base for restore. */
  diskSnapshot: string;
}

/**
 * Park the current branch context by committing Y.Doc in-memory state
 * to the shadow repo. Each document's state and its disk snapshot are
 * stored so that `restoreBranchWIP` can three-way merge later.
 *
 * Park commits use message prefix "park:" for identification.
 */
export async function parkBranch(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  documents: ParkableDoc[],
  newBranch?: string,
): Promise<string | null> {
  if (documents.length === 0) return null;
  return withSpan(
    'shadow.parkBranch',
    {
      attributes: {
        'shadow.branch': branch,
        'shadow.new_branch': newBranch ?? '',
        'shadow.doc_count': documents.length,
      },
    },
    async () => parkBranchInner(shadow, branch, writerId, documents, newBranch),
  );
}

async function parkBranchInner(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  documents: ParkableDoc[],
  newBranch?: string,
): Promise<string | null> {
  const sg = shadowGit(shadow);
  const tmpIndex = resolve(shadow.gitDir, `index-park-${branch.replace(/\//g, '-')}`);
  const ref = `refs/wip/${branch}/${writerId}`;

  const tmpBlobFile = resolve(shadow.gitDir, 'tmp-park-blob');
  try {
    // Build a tree with both Y.Doc state and disk snapshots
    for (const doc of documents) {
      // Store Y.Doc state at the doc's path
      tracedWriteFileSync(tmpBlobFile, doc.markdown, 'utf-8');
      const blobSha = (
        await sg
          .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
          .raw('hash-object', '-w', tmpBlobFile)
      ).trim();
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('update-index', '--add', '--cacheinfo', `100644,${blobSha},${doc.docName}`);

      // Store disk snapshot at .park-base/<docName>
      tracedWriteFileSync(tmpBlobFile, doc.diskSnapshot, 'utf-8');
      const baseSha = (
        await sg
          .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
          .raw('hash-object', '-w', tmpBlobFile)
      ).trim();
      await sg
        .env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex })
        .raw('update-index', '--add', '--cacheinfo', `100644,${baseSha},.park-base/${doc.docName}`);
    }

    const treeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: tmpIndex }).raw('write-tree')
    ).trim();

    // Find parent
    let parentSha: string | null = null;
    try {
      parentSha = (await sg.raw('rev-parse', ref)).trim();
    } catch {
      // No prior WIP on this branch for this session
    }

    const parkActorEntry: OkActorEntry = {
      v: 1,
      writer_id: SERVICE_WRITER.id,
      principal: null,
      agent_session: null,
      agent_type: null,
      client_name: null,
      client_version: null,
      label: null,
      display_name: SERVICE_WRITER.name,
      color_seed: SERVICE_WRITER.id,
      docs: documents.map((d) => d.docName),
    };
    const parkMessage = `${formatParkSubject(branch, newBranch ?? branch)}\n\n${formatOkActor(parkActorEntry)}`;
    const args = ['commit-tree', treeSha, '-m', parkMessage];
    if (parentSha) args.push('-p', parentSha);

    const commitSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'openknowledge',
          GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
          GIT_COMMITTER_NAME: 'openknowledge',
          GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
        })
        .raw(...args)
    ).trim();

    await sg.raw('update-ref', ref, commitSha);
    return commitSha;
  } finally {
    try {
      rmSync(tmpIndex);
    } catch {
      // ignore cleanup failure
    }
    try {
      rmSync(tmpBlobFile);
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Read parked Y.Doc state and disk snapshot from a park commit.
 * Returns null if the ref doesn't exist or the latest commit isn't a park.
 */
export async function readParkedState(
  shadow: ShadowHandle,
  branch: string,
  writerId: string,
  docName: string,
): Promise<{ markdown: string; diskSnapshot: string } | null> {
  const sg = shadowGit(shadow);
  const ref = `refs/wip/${branch}/${writerId}`;

  // Check if ref exists — expected to be missing on first visit to a branch
  let refSha: string;
  try {
    refSha = (await sg.raw('rev-parse', ref)).trim();
  } catch {
    return null; // ref doesn't exist — no parked state
  }

  // Ref exists — read park commit data. Errors here are unexpected and should propagate.
  try {
    const msg = (await sg.raw('log', '-1', '--format=%s', refSha)).trim();
    if (!msg.startsWith('park:')) return null;

    const markdown = (await sg.raw('show', `${refSha}:${docName}`)).trim();
    const diskSnapshot = (await sg.raw('show', `${refSha}:.park-base/${docName}`)).trim();
    return { markdown, diskSnapshot };
  } catch (e) {
    console.error(`[shadow] Failed to read parked state for ${docName} from ${ref}:`, e);
    throw e;
  }
}

// ─── Save Version ────────────────────────────────────────────────────────────

export interface SaveVersionResult {
  checkpointRef: string;
}

export interface SaveVersionOptions {
  /**
   * When set, tags the checkpoint commit with a typed `auto-consolidation`
   * `ok-checkpoint-v1:` body line so `GET /api/history` can exclude it
   * and `gcCheckpointRefs` can bound its retention. Used by the
   * service-authored auto-consolidation path; user `Save Version`
   * checkpoints leave this unset and stay untyped (permanent).
   */
  checkpointKind?: { foldedRefs: number; trigger: AutoConsolidationTrigger };
  /**
   * Whether to also fold (parent on + reset) the branch's `git-upstream` WIP ref.
   * Default true — Save Version and dead-chain consolidation fold everything.
   * The TTL backstop sets this false so it consolidates ONLY the aged session
   * writers it targeted, leaving the upstream-import chain untouched.
   */
  includeUpstream?: boolean;
  /**
   * Block timeout for the underlying git ops. Maintenance callers (auto-
   * consolidation, TTL backstop) pass `MAINTENANCE_GIT_TIMEOUT_MS` so a fold on
   * a degraded repo isn't killed mid-run by the 30s op watchdog, matching the gc
   * leg. Omitted by the interactive Save Version button, which keeps
   * the default 30s watchdog so a stuck git command surfaces to the user.
   */
  timeoutMs?: number;
  /**
   * Explicit checkpoint commit timestamp (any git-parseable date), applied to
   * both author and committer date. Production leaves this unset so git stamps
   * the current time; tests pass distinct increasing values so a checkpoint
   * orders deterministically against the WIP commits around it without a >1s
   * wall-clock sleep (git committer dates have 1-second granularity). See
   * {@link CommitWipOptions.date}.
   */
  date?: string;
}

/**
 * Save Version — checkpoint in shadow repo only:
 * 1. Write a checkpoint ref in the shadow with full tree snapshot
 * 2. Reset per-writer WIP refs so subsequent WIP tracks only post-checkpoint deltas
 *
 * Ref reset is compare-and-delete: a WIP ref is deleted only if it
 * still points at the SHA captured as a checkpoint parent. A ref a concurrent
 * writer advanced between snapshot and delete is skipped — its new commit
 * survives as ongoing WIP instead of being orphaned. This makes every
 * consolidation path (auto + button) race-safe by construction.
 *
 * @param branch - Project branch name for ref scoping. Defaults to 'main'.
 */
export async function saveVersion(
  shadow: ShadowHandle,
  contentRoot: string,
  writers: WriterIdentity[],
  branch = 'main',
  summary?: string,
  options?: SaveVersionOptions,
): Promise<SaveVersionResult> {
  return withSpan(
    'shadow.saveVersion',
    {
      attributes: {
        'shadow.branch': branch,
        'shadow.writer_count': writers.length,
        'shadow.checkpoint_kind': options?.checkpointKind ? 'auto-consolidation' : 'user',
      },
    },
    async () => saveVersionInner(shadow, contentRoot, writers, branch, summary, options),
  );
}

async function saveVersionInner(
  shadow: ShadowHandle,
  contentRoot: string,
  writers: WriterIdentity[],
  branch = 'main',
  summary?: string,
  options?: SaveVersionOptions,
): Promise<SaveVersionResult> {
  // Maintenance callers thread `MAINTENANCE_GIT_TIMEOUT_MS` so the fold's git
  // ops (add/write-tree/commit-tree/reset) aren't killed mid-run on a degraded
  // repo; the interactive button leaves it unset for the default 30s watchdog.
  const sg = shadowGit(shadow, options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
  // git rejects an empty string pathspec — use '.' (repo root) when
  // contentRoot is '' (content dir === project root).
  const gitPathspec = contentRoot || '.';

  // ── Step 1: Checkpoint ref in shadow with full tree snapshot ──

  // Per-invocation scratch index: two concurrent saveVersion
  // calls on the same shadow must not share `index-checkpoint` or they corrupt
  // each other's staging. Mirrors saveInMemoryCheckpoint's token pattern.
  const shadowTmpIndex = resolve(shadow.gitDir, `index-checkpoint-${randomUUID()}`);
  try {
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.workTree,
        GIT_INDEX_FILE: shadowTmpIndex,
      })
      .raw('add', gitPathspec);
    const shadowTreeSha = (
      await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: shadowTmpIndex }).raw('write-tree')
    ).trim();

    // Collect ALL writer WIP refs (+ upstream unless opted out) as checkpoint
    // parents (preserves all per-writer chains across the checkpoint boundary).
    // Keep the per-writer snapshot SHA so the reset below can compare-and-delete.
    const foldWriters =
      options?.includeUpstream === false ? writers : [...writers, GIT_UPSTREAM_WRITER];
    const shadowParentShas: string[] = [];
    const wipSnapshotShas = new Map<string, string>(); // writerId -> sha at snapshot
    for (const w of foldWriters) {
      try {
        const sha = (await sg.raw('rev-parse', `refs/wip/${branch}/${w.id}`)).trim();
        shadowParentShas.push(sha);
        wipSnapshotShas.set(w.id, sha);
      } catch {
        // ref doesn't exist for this writer — skip
      }
    }
    // Deduplicate (upstream may alias a writer ref in edge cases)
    const uniqueParents = [...new Set(shadowParentShas)];

    // Checkpoint chaining: EVERY checkpoint — even one with WIP activity — adopts the
    // latest prior checkpoint as an additional parent, so history forms one
    // connected chain. The timeline walk then reaches all prior entries through
    // the newest checkpoint's ancestry, and kind-aware GC can reap older
    // auto-consolidation refs (their commits stay reachable via newer
    // checkpoints). The prior checkpoint goes LAST so WIP tips remain
    // first-parents.
    try {
      const priorCheckpoint = (
        await sg.raw(
          'for-each-ref',
          '--sort=-creatordate',
          '--count=1',
          '--format=%(objectname)',
          `refs/checkpoints/${branch}/`,
        )
      ).trim();
      if (priorCheckpoint && !uniqueParents.includes(priorCheckpoint)) {
        uniqueParents.push(priorCheckpoint);
      }
    } catch {
      // no prior checkpoints — this is the first one, parentless is fine
    }

    const checkpointActorEntry: OkActorEntry = {
      v: 1,
      writer_id: SERVICE_WRITER.id,
      principal: null,
      agent_session: null,
      agent_type: null,
      client_name: null,
      client_version: null,
      label: null,
      display_name: SERVICE_WRITER.name,
      color_seed: SERVICE_WRITER.id,
      docs: [],
    };
    const checkpointSubject = summary?.trim() ? summary.trim() : 'Checkpoint version';
    let checkpointMessage = `${formatCheckpointSubject(checkpointSubject)}\n\n${formatOkActor(checkpointActorEntry)}`;
    if (options?.checkpointKind) {
      // Tag service-authored consolidation checkpoints so the read path can
      // exclude them and kind-aware GC can bound them. Old readers
      // that predate this kind get null from parseCheckpoint and render it as a
      // plain Save Version — data-safe, cosmetic only.
      checkpointMessage += `\n${formatCheckpointBodyLine({
        kind: 'auto-consolidation',
        docName: null,
        size: null,
        metadata: {
          foldedRefs: options.checkpointKind.foldedRefs,
          trigger: options.checkpointKind.trigger,
        },
      })}`;
    }
    const checkpointArgs = ['commit-tree', shadowTreeSha, '-m', checkpointMessage];
    for (const p of uniqueParents) {
      checkpointArgs.push('-p', p);
    }

    const checkpointEnv: Record<string, string> = {
      GIT_DIR: shadow.gitDir,
      GIT_AUTHOR_NAME: 'openknowledge',
      GIT_AUTHOR_EMAIL: 'noreply@openknowledge.local',
      GIT_COMMITTER_NAME: 'openknowledge',
      GIT_COMMITTER_EMAIL: 'noreply@openknowledge.local',
    };
    if (options?.date) {
      checkpointEnv.GIT_AUTHOR_DATE = options.date;
      checkpointEnv.GIT_COMMITTER_DATE = options.date;
    }
    const checkpointSha = (await sg.env(checkpointEnv).raw(...checkpointArgs)).trim();

    const checkpointRef = `refs/checkpoints/${branch}/${checkpointSha}`;
    await sg.raw('update-ref', checkpointRef, checkpointSha);

    // ── Step 2: Reset WIP refs (branch-scoped), compare-and-delete ──
    await resetFoldedWipRefs(sg, branch, foldWriters, wipSnapshotShas);

    return { checkpointRef };
  } finally {
    try {
      rmSync(shadowTmpIndex);
    } catch {
      // ignore
    }
  }
}

/**
 * Reset (delete) the folded WIP refs after a checkpoint — compare-and-delete.
 * Each ref is deleted only if it STILL points at the SHA captured as a
 * checkpoint parent (`wipSnapshotShas`). A ref a concurrent writer advanced
 * between snapshot and now fails the 3-arg `update-ref -d <ref> <expected>` and
 * is skipped, so its new commit survives as ongoing WIP instead of being
 * orphaned. Exported so the skip-on-advance guard is unit-testable
 * deterministically, without racing a real concurrent writer.
 */
export async function resetFoldedWipRefs(
  sg: ReturnType<typeof shadowGit>,
  branch: string,
  writers: readonly { id: string }[],
  wipSnapshotShas: ReadonlyMap<string, string>,
): Promise<void> {
  for (const w of writers) {
    const ref = `refs/wip/${branch}/${w.id}`;
    const expected = wipSnapshotShas.get(w.id);
    if (expected === undefined) continue; // had no WIP ref at snapshot — nothing to reset
    try {
      await sg.raw('update-ref', '-d', ref, expected);
    } catch {
      // ref already gone, or advanced by a concurrent writer — skip on move
    }
  }
}
