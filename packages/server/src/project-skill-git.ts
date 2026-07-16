/**
 * Migration + reconcile for OK's built-in `open-knowledge` project-skill
 * projection (`.{host}/skills/open-knowledge/`).
 *
 * Two concerns, both driven from the on-open / project-setup paths (CLI
 * `ok init`, desktop create-new + on-open):
 *
 *   1. `ensureProjectSkillGitignore` (in `init-project.ts`) writes the committed
 *      `.gitignore` block so the projection is ALWAYS excluded for fresh clones.
 *   2. `untrackTrackedProjectSkillProjection` (here) heals repos where the
 *      projection is ALREADY tracked upstream: it removes the bundle from git's
 *      tree so it stops causing merge conflicts / "external-changes-pending"
 *      when teammates on different app builds restamp its version line.
 *
 * Why a dedicated commit rather than a bare `git rm --cached`: OK's auto-sync
 * push builds its commit from HEAD's tree in an ISOLATED index (it never reads
 * the real index) and only stages content-dir files. A `git rm --cached` left
 * in the real index is therefore invisible to auto-sync — HEAD keeps the
 * projection forever. To actually untrack it we have to advance HEAD to a tree
 * that lacks the projection; auto-sync then carries that new HEAD forward (its
 * `read-tree HEAD` no longer sees the bundle) and pushes it on the normal
 * "local ahead of origin" path.
 *
 * The untrack uses the SAME proven, side-effect-free pattern as auto-sync's push
 * (`sync-engine.ts` doPushCycle): an isolated `GIT_INDEX_FILE`, `read-tree HEAD`,
 * `rm --cached` against that isolated index, `write-tree`, `commit-tree -p HEAD`,
 * then a compare-and-swap `update-ref`. It never touches the user's real index
 * or working tree destructively, never sweeps unrelated staged changes into the
 * commit, and races safely with a concurrent auto-sync push (both take
 * `withParentLock`; the CAS `update-ref` makes the loser abort and retry). It
 * does NOT push — auto-sync (or the user) carries HEAD to origin.
 *
 * The projection working file is left on disk (it is now git-ignored and the app
 * regenerates it on the next open), so the migration self-heals. The
 * teammate-visible deletion on their next pull is the accepted trade-off.
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_SKILL_PROJECTION_IGNORE_PATHS,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { applyGitEnv, createGitInstance, type GitHandle, withParentLock } from './git-handle.ts';
import { resolveGitIdentity } from './git-identity.ts';
import { getLogger } from './logger.ts';

const log = getLogger('project-skill-git');

/** 40-hex validation for a commit SHA returned by `commit-tree`. */
const SHA_HEX_40 = /^[0-9a-f]{40}$/;

/** Projection dirs without the gitignore trailing slash — the form `git` wants. */
const PROJECTION_DIRS = PROJECT_SKILL_PROJECTION_IGNORE_PATHS.map((p) => p.replace(/\/$/, ''));

export type UntrackSkipReason =
  | 'no-git'
  | 'unborn-head'
  | 'detached-head'
  | 'operation-in-progress'
  | 'ref-race';

export type UntrackProjectSkillResult =
  | { kind: 'nothing-tracked' }
  | { kind: 'untracked'; dirs: string[]; commitSha: string }
  | { kind: 'skipped'; reason: UntrackSkipReason }
  | { kind: 'failed'; error: string };

/**
 * Untrack the built-in project-skill projection when it is tracked upstream.
 * Best-effort and idempotent: once HEAD no longer tracks the bundle a later
 * call sees `nothing-tracked` and no-ops. Never throws — failures resolve to a
 * typed `failed` / `skipped` result the caller can log.
 */
export async function untrackTrackedProjectSkillProjection(
  projectDir: string,
): Promise<UntrackProjectSkillResult> {
  const gitDir = resolveGitDir(projectDir);
  if (gitDir === null) return { kind: 'skipped', reason: 'no-git' };

  // An in-progress merge / rebase owns the index and HEAD; never inject a
  // migration commit into that state. Re-attempted on a later clean open.
  if (isOperationInProgress(gitDir)) {
    return { kind: 'skipped', reason: 'operation-in-progress' };
  }

  const handle = createGitInstance(projectDir);

  const trackedDirs = await listTrackedProjectionDirs(handle);
  if (trackedDirs.length === 0) return { kind: 'nothing-tracked' };

  try {
    return await withParentLock(async () => {
      // Re-read state INSIDE the lock so a concurrent auto-sync commit that
      // landed between detection and here is reflected in `headSha`.
      const branch = await currentBranch(handle);
      if (branch === null) return { kind: 'skipped', reason: 'detached-head' };
      const headSha = await revparseHead(handle);
      if (headSha === null) return { kind: 'skipped', reason: 'unborn-head' };

      // Re-list under the lock — the winning writer of a race may have already
      // untracked the projection.
      const dirsNow = await listTrackedProjectionDirs(handle);
      if (dirsNow.length === 0) return { kind: 'nothing-tracked' };

      const tmpIndex = join(tmpdir(), `ok-untrack-idx-${process.pid}-${Date.now()}.idx`);
      const iso = createGitInstance(projectDir, { gitIndexFile: tmpIndex });

      // Seed the isolated index from HEAD, drop the projection dirs, write the
      // reduced tree. `--ignore-unmatch` tolerates a dir that vanished from the
      // tree between the two ls-files calls.
      await iso.git.raw(['read-tree', headSha]);
      await iso.git.raw(['rm', '--cached', '-r', '--ignore-unmatch', '--', ...dirsNow]);
      const newTree = (await iso.git.raw(['write-tree'])).trim();
      const headTree = await revparseTree(handle, headSha);
      if (headTree !== null && headTree === newTree) {
        // Nothing actually changed (the projection wasn't in HEAD's tree after
        // all). Leave HEAD untouched.
        return { kind: 'nothing-tracked' };
      }

      const identity = await resolveGitIdentity(projectDir);
      const authorName = identity?.name ?? 'OpenKnowledge';
      const authorEmail = identity?.email ?? 'sync@open-knowledge.local';
      applyGitEnv(iso, {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
      });

      const message = `Stop tracking the OpenKnowledge project skill\n\nThe \`${RESERVED_PROJECT_SKILL_NAME}\` skill is regenerated per machine and version-stamped per app build, so tracking it causes recurring sync conflicts. It is now git-ignored.`;
      const newCommit = (
        await iso.git.raw(['commit-tree', newTree, '-p', headSha, '-m', message])
      ).trim();
      if (!SHA_HEX_40.test(newCommit)) {
        log.warn({ raw: newCommit }, 'commit-tree returned invalid SHA — aborting untrack');
        return { kind: 'failed', error: 'commit-tree returned invalid SHA' };
      }

      // Compare-and-swap: only advance the branch if HEAD is still `headSha`.
      // A concurrent push that moved HEAD makes this fail; we abort and let the
      // next open retry rather than clobber the other writer's commit.
      try {
        await handle.git.raw(['update-ref', `refs/heads/${branch}`, newCommit, headSha]);
      } catch (err) {
        log.info(
          { branch, err: errText(err) },
          'update-ref CAS failed — ref moved, retry next open',
        );
        return { kind: 'skipped', reason: 'ref-race' };
      }

      // Sync the real index to the new HEAD for the untracked paths so
      // `git status` doesn't report them as phantom staged additions (the real
      // index still held the old HEAD's entries). Best-effort — the working
      // files are git-ignored, so a stale index entry is cosmetic, not
      // corrupting.
      try {
        await handle.git.raw(['reset', '-q', newCommit, '--', ...dirsNow]);
      } catch (err) {
        log.info({ err: errText(err) }, 'real-index reset after untrack failed (cosmetic)');
      }

      log.info({ dirs: dirsNow, commitSha: newCommit }, 'untracked project-skill projection');
      return { kind: 'untracked', dirs: dirsNow, commitSha: newCommit };
    });
  } catch (err) {
    return { kind: 'failed', error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The subset of the projection dirs that currently have at least one tracked
 * file in the index. `git ls-files -- <dir>` lists tracked files under a
 * directory pathspec; a non-empty result means the dir is tracked.
 */
async function listTrackedProjectionDirs(handle: GitHandle): Promise<string[]> {
  const tracked: string[] = [];
  for (const dir of PROJECTION_DIRS) {
    let out = '';
    try {
      out = (await handle.git.raw(['ls-files', '--', dir])).trim();
    } catch {
      // `ls-files` fails on a non-git dir or an unborn repo with no index; treat
      // as "not tracked" — the higher-level guards handle those states.
      out = '';
    }
    if (out.length > 0) tracked.push(dir);
  }
  return tracked;
}

/** Current branch name, or `null` when HEAD is detached / unresolvable. */
async function currentBranch(handle: GitHandle): Promise<string | null> {
  try {
    const b = (await handle.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return b.length === 0 || b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

/** HEAD commit SHA, or `null` when the repo has no commits yet. */
async function revparseHead(handle: GitHandle): Promise<string | null> {
  try {
    const sha = (await handle.git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
    return SHA_HEX_40.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The tree SHA of a commit, or `null` when it can't be resolved. */
async function revparseTree(handle: GitHandle, commitSha: string): Promise<string | null> {
  try {
    const tree = (await handle.git.raw(['rev-parse', `${commitSha}^{tree}`])).trim();
    return SHA_HEX_40.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

/**
 * True when a merge or rebase is mid-flight in the resolved gitdir. Those states
 * own the index + HEAD, so the migration must stay out until the repo is clean.
 */
function isOperationInProgress(gitDir: string): boolean {
  return (
    existsSync(join(gitDir, 'MERGE_HEAD')) ||
    existsSync(join(gitDir, 'rebase-merge')) ||
    existsSync(join(gitDir, 'rebase-apply')) ||
    existsSync(join(gitDir, 'CHERRY_PICK_HEAD')) ||
    existsSync(join(gitDir, 'REVERT_HEAD'))
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
