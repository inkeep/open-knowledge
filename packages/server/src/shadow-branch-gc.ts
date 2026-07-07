/**
 * Shadow branch garbage collection.
 *
 * Cleans up orphaned shadow branch refs when the corresponding project
 * branches are deleted, and handles branch-rename detection.
 *
 * - WIP refs (refs/wip/<branch>/*) are deleted after a 24h grace period.
 * - Checkpoint refs (refs/checkpoints/<branch>/*) have kind-aware GC:
 *   - `Save Version` (no `ok-checkpoint-v1:` body line): retained
 *     indefinitely — user-intentional permanent-history artifacts.
 *   - `bridge-merge-loss` (observer Path B auto-rescue) and
 *     `external-change-rescue` (reconcile-delete / branch-switch auto-rescue):
 *     most-recent N per branch + TTL. See `gcCheckpointRefs` in `shadow-repo.ts`.
 * - Branch rename: if old branch disappears and a new branch has the same
 *   HEAD SHA, migrate refs.
 */

import { parseWriterId } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { getLogger } from './logger.ts';
import { gcRenameLog, getOrLoadRenameLogIndex } from './rename-log.ts';
import type { CheckpointRetentionPolicy, ShadowHandle, WriterIdentity } from './shadow-repo.ts';
import {
  DEFAULT_CHECKPOINT_RETENTION,
  enumerateWipChains,
  gcCheckpointRefs,
  MAINTENANCE_GIT_TIMEOUT_MS,
  saveVersion,
  shadowGit,
} from './shadow-repo.ts';

const log = getLogger('shadow-gc');

/** Grace period before orphaned WIP refs are deleted (24 hours). */
const GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Per-writer inactivity TTL for session writers (agent-*, principal-*) on active branches. */
const SESSION_WRITER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface GcResult {
  deletedBranches: string[];
  renamedBranches: { from: string; to: string }[];
  retainedBranches: string[];
  /**
   * Per-branch tally of checkpoint refs GC'd under the kind-aware retention
   * policy. Entries with zero deletions are omitted.
   */
  checkpointGc: Record<
    string,
    {
      scanned: number;
      deletedBridgeMergeLoss: number;
      deletedExternalChangeRescue: number;
      deletedAutoConsolidation: number;
      retained: number;
    }
  >;
  /** Count of stale session writer refs deleted due to 30-day inactivity TTL. */
  deletedStaleSessionRefs: number;
}

/**
 * Extract unique branch names from shadow WIP refs.
 *
 * Refs are shaped: refs/wip/<branch>/<writer-id>
 * Branch names can contain slashes (e.g., feature/xyz).
 * Writer IDs are the last segment after the last slash that matches known patterns.
 */
function extractBranchNames(refs: string[]): Set<string> {
  const branches = new Set<string>();
  for (const ref of refs) {
    // Strip refs/wip/ prefix, then split into branch + writerId at the last slash.
    // The writer-id portion is classified via the core helper — any
    // non-matching id is ignored.
    const withoutPrefix = ref.replace(/^refs\/wip\//, '');
    const lastSlash = withoutPrefix.lastIndexOf('/');
    if (lastSlash <= 0) continue;
    const branch = withoutPrefix.slice(0, lastSlash);
    const writerId = withoutPrefix.slice(lastSlash + 1);
    if (parseWriterId(writerId).classification !== 'unknown') {
      branches.add(branch);
    }
  }
  return branches;
}

/**
 * Get HEAD SHA for a project branch.
 */
async function getProjectBranchSha(projectGitDir: string, branch: string): Promise<string | null> {
  try {
    const git = simpleGit().env({ GIT_DIR: projectGitDir });
    return (await git.raw('rev-parse', `refs/heads/${branch}`)).trim();
  } catch {
    return null;
  }
}

/**
 * List all project branch names.
 */
async function listProjectBranches(projectGitDir: string): Promise<Set<string>> {
  const branches = new Set<string>();
  try {
    const git = simpleGit().env({ GIT_DIR: projectGitDir });
    const output = (
      await git.raw('for-each-ref', 'refs/heads/', '--format=%(refname:short)')
    ).trim();
    if (output) {
      for (const line of output.split('\n')) {
        if (line) branches.add(line);
      }
    }
  } catch (err) {
    // No branches or not a git repo. A transient git failure here classifies
    // every shadow branch as orphaned, so surface it rather than swallowing —
    // the 24h WIP grace period still guards against acting on one bad read.
    log.warn({ err }, '[shadow-gc] listProjectBranches failed; treating as no project branches');
  }
  return branches;
}

/**
 * Run garbage collection on shadow branch refs.
 *
 * Compares shadow WIP branch prefixes against project repo branches.
 * Orphaned branches (no corresponding project branch) have their WIP refs
 * deleted. Checkpoint refs are always retained.
 *
 * Branch rename detection: if an orphaned shadow branch has the same HEAD SHA
 * as a new project branch (not in shadow), treat it as a rename and migrate refs.
 */
export async function gcShadowBranches(
  shadow: ShadowHandle,
  projectGitDir: string,
  checkpointRetention: CheckpointRetentionPolicy = DEFAULT_CHECKPOINT_RETENTION,
  contentRoot = '.',
): Promise<GcResult> {
  const result: GcResult = {
    deletedBranches: [],
    renamedBranches: [],
    retainedBranches: [],
    checkpointGc: {},
    deletedStaleSessionRefs: 0,
  };

  // Reap is a maintenance-class op on the same degraded repos the gc leg
  // targets (for-each-ref / orphan-deletion / TTL consolidation can each outrun
  // the 30s op watchdog on a large backlog), so it runs under the dedicated
  // maintenance timeout rather than the default block watchdog. The
  // TTL `saveVersion` below threads the same timeout into its own git instance.
  const sg = shadowGit(shadow, { timeoutMs: MAINTENANCE_GIT_TIMEOUT_MS });

  // List all shadow WIP refs
  let wipRefsRaw: string;
  try {
    wipRefsRaw = (await sg.raw('for-each-ref', 'refs/wip/', '--format=%(refname)')).trim();
  } catch {
    return result; // No refs at all
  }
  if (!wipRefsRaw) return result;

  const wipRefs = wipRefsRaw.split('\n').filter(Boolean);
  const shadowBranches = extractBranchNames(wipRefs);

  // Get project branches
  const projectBranches = await listProjectBranches(projectGitDir);

  // Find orphaned shadow branches (not in project, not detached-*)
  const orphaned: string[] = [];
  for (const branch of shadowBranches) {
    if (branch.startsWith('detached-')) continue; // Handled separately
    if (!projectBranches.has(branch)) {
      orphaned.push(branch);
    } else {
      result.retainedBranches.push(branch);
    }
  }

  if (orphaned.length === 0) {
    // No orphaned branches — skip rename/delete logic but still run per-writer TTL GC
    // and checkpoint GC on active branches.
  } else {
    // Check for renames: orphaned branch with same SHA as a new project branch
    const newProjectBranches = new Set<string>();
    for (const pb of projectBranches) {
      if (!shadowBranches.has(pb)) {
        newProjectBranches.add(pb);
      }
    }

    for (const orphanedBranch of orphaned) {
      // Try to detect rename by matching commit SHA
      let renamed = false;

      if (newProjectBranches.size > 0) {
        // Get latest SHA from the orphaned branch's WIP refs
        let orphanedSha: string | null = null;
        for (const ref of wipRefs) {
          if (ref.startsWith(`refs/wip/${orphanedBranch}/`)) {
            try {
              orphanedSha = (await sg.raw('rev-parse', ref)).trim();
              break;
            } catch {}
          }
        }

        if (orphanedSha) {
          for (const newBranch of newProjectBranches) {
            const newSha = await getProjectBranchSha(projectGitDir, newBranch);
            if (newSha === orphanedSha) {
              // Rename detected — migrate refs
              const branchRefs = wipRefs.filter((r) => r.startsWith(`refs/wip/${orphanedBranch}/`));
              for (const oldRef of branchRefs) {
                const writerId = oldRef.slice(`refs/wip/${orphanedBranch}/`.length);
                const newRef = `refs/wip/${newBranch}/${writerId}`;
                try {
                  const sha = (await sg.raw('rev-parse', oldRef)).trim();
                  await sg.raw('update-ref', newRef, sha);
                  await sg.raw('update-ref', '-d', oldRef);
                } catch (err) {
                  log.error({ err, oldRef, newRef }, '[shadow-gc] failed to migrate WIP ref');
                }
              }
              result.renamedBranches.push({ from: orphanedBranch, to: newBranch });
              newProjectBranches.delete(newBranch);
              renamed = true;
              break;
            }
          }
        }
      }

      if (!renamed) {
        // Delete orphaned WIP refs after grace period
        const branchRefs = wipRefs.filter((r) => r.startsWith(`refs/wip/${orphanedBranch}/`));
        for (const ref of branchRefs) {
          try {
            // Check commit timestamp for grace period
            const commitDate = (await sg.raw('log', '-1', '--format=%ci', ref)).trim();
            const commitTime = new Date(commitDate).getTime();
            const age = Date.now() - commitTime;

            if (age < GC_GRACE_PERIOD_MS) {
              result.retainedBranches.push(orphanedBranch);
              break; // Skip this entire branch
            }

            await sg.raw('update-ref', '-d', ref);
          } catch {
            // Ref may already be deleted
          }
        }
        if (!result.retainedBranches.includes(orphanedBranch)) {
          result.deletedBranches.push(orphanedBranch);
        }
      }
    }
  }

  // Kind-aware checkpoint GC on every live project branch + every retained
  // shadow branch (covers detached HEADs that accrued bridge-merge-loss
  // checkpoints during their lifetime). `Save Version` untyped checkpoints
  // are never eligible — see `gcCheckpointRefs` JSDoc.
  const gcBranches = new Set<string>([...projectBranches, ...result.retainedBranches]);
  for (const branch of gcBranches) {
    try {
      const ckResult = await gcCheckpointRefs(shadow, branch, checkpointRetention);
      if (
        ckResult.scanned > 0 ||
        ckResult.deletedBridgeMergeLoss > 0 ||
        ckResult.deletedExternalChangeRescue > 0 ||
        ckResult.deletedAutoConsolidation > 0
      ) {
        result.checkpointGc[branch] = {
          scanned: ckResult.scanned,
          deletedBridgeMergeLoss: ckResult.deletedBridgeMergeLoss,
          deletedExternalChangeRescue: ckResult.deletedExternalChangeRescue,
          deletedAutoConsolidation: ckResult.deletedAutoConsolidation,
          retained: ckResult.retained,
        };
      }
    } catch (err) {
      log.warn({ err, branch }, '[shadow-gc] checkpoint GC failed');
    }
  }

  // Rename-log GC piggybacks on the same cliff. One pass covers all
  // branches because the reachability check enumerates `refs/wip/` and
  // `refs/checkpoints/` globally.
  try {
    await gcRenameLog(shadow, getOrLoadRenameLogIndex(shadow.gitDir));
  } catch (err) {
    log.warn({ err }, '[shadow-gc] rename-log GC failed');
  }

  // Per-writer 30-day TTL backstop on ACTIVE project branches.
  // Stale `agent-*`/`principal-*` session writers are CONSOLIDATED
  // (a checkpoint anchors their history, then the spine compare-and-deletes
  // their refs) — never bare-deleted, which would orphan their commits. The
  // checkpoint is tagged `auto-consolidation` so it stays hidden and
  // bounded. Classified writers (file-system, git-upstream,
  // openknowledge-service) are never reaped; park-tipped refs hold branch-switch
  // state and are never folded; unknown writers are preserved with a warning.
  const now = Date.now();
  for (const branch of projectBranches) {
    const chains = await enumerateWipChains(shadow, branch);
    const aged: WriterIdentity[] = [];
    for (const c of chains) {
      if (
        c.classification === 'classified-file-system' ||
        c.classification === 'classified-git-upstream' ||
        c.classification === 'classified-openknowledge-service'
      ) {
        continue;
      }
      if (c.classification === 'unknown') {
        log.warn(
          { branch, writerId: c.writerId },
          '[shadow-gc] unknown writer id in active branch ref — preserved',
        );
        continue;
      }
      if (c.classification === 'agent' || c.classification === 'principal') {
        if (c.isPark) continue; // branch-switch state — never fold
        if (c.committedAtMs > 0 && now - c.committedAtMs >= SESSION_WRITER_TTL_MS) {
          aged.push({
            id: c.writerId,
            name: c.writerId,
            email: `${c.writerId}@openknowledge.local`,
          });
        }
      }
    }
    if (aged.length > 0) {
      try {
        await saveVersion(shadow, contentRoot, aged, branch, undefined, {
          checkpointKind: { foldedRefs: aged.length, trigger: 'ttl' },
          includeUpstream: false,
          timeoutMs: MAINTENANCE_GIT_TIMEOUT_MS,
        });
        result.deletedStaleSessionRefs += aged.length;
      } catch (err) {
        log.warn({ err, branch }, '[shadow-gc] TTL consolidation failed');
      }
    }
  }

  return result;
}
