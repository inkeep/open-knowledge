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

const SHA_HEX_40 = /^[0-9a-f]{40}$/;

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

export async function untrackTrackedProjectSkillProjection(
  projectDir: string,
): Promise<UntrackProjectSkillResult> {
  const gitDir = resolveGitDir(projectDir);
  if (gitDir === null) return { kind: 'skipped', reason: 'no-git' };

  if (isOperationInProgress(gitDir)) {
    return { kind: 'skipped', reason: 'operation-in-progress' };
  }

  const handle = createGitInstance(projectDir, { credentialConfig: [] });

  const trackedDirs = await listTrackedProjectionDirs(handle);
  if (trackedDirs.length === 0) return { kind: 'nothing-tracked' };

  try {
    return await withParentLock(async () => {
      const branch = await currentBranch(handle);
      if (branch === null) return { kind: 'skipped', reason: 'detached-head' };
      const headSha = await revparseHead(handle);
      if (headSha === null) return { kind: 'skipped', reason: 'unborn-head' };

      const dirsNow = await listTrackedProjectionDirs(handle);
      if (dirsNow.length === 0) return { kind: 'nothing-tracked' };

      const tmpIndex = join(tmpdir(), `ok-untrack-idx-${process.pid}-${Date.now()}.idx`);
      const iso = createGitInstance(projectDir, { gitIndexFile: tmpIndex, credentialConfig: [] });

      await iso.git.raw(['read-tree', headSha]);
      await iso.git.raw(['rm', '--cached', '-r', '--ignore-unmatch', '--', ...dirsNow]);
      const newTree = (await iso.git.raw(['write-tree'])).trim();
      const headTree = await revparseTree(handle, headSha);
      if (headTree !== null && headTree === newTree) {
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

      try {
        await handle.git.raw(['update-ref', `refs/heads/${branch}`, newCommit, headSha]);
      } catch (err) {
        log.info(
          { branch, err: errText(err) },
          'update-ref CAS failed — ref moved, retry next open',
        );
        return { kind: 'skipped', reason: 'ref-race' };
      }

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

async function listTrackedProjectionDirs(handle: GitHandle): Promise<string[]> {
  const tracked: string[] = [];
  for (const dir of PROJECTION_DIRS) {
    let out = '';
    try {
      out = (await handle.git.raw(['ls-files', '--', dir])).trim();
    } catch {
      out = '';
    }
    if (out.length > 0) tracked.push(dir);
  }
  return tracked;
}

async function currentBranch(handle: GitHandle): Promise<string | null> {
  try {
    const b = (await handle.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return b.length === 0 || b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

async function revparseHead(handle: GitHandle): Promise<string | null> {
  try {
    const sha = (await handle.git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
    return SHA_HEX_40.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function revparseTree(handle: GitHandle, commitSha: string): Promise<string | null> {
  try {
    const tree = (await handle.git.raw(['rev-parse', `${commitSha}^{tree}`])).trim();
    return SHA_HEX_40.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

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
