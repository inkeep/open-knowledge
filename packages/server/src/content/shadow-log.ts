/**
 * CLI-side reader for shadow-repo per-path activity history.
 *
 * Reads the bare shadow repo at `.git/ok/` via simple-git — NO
 * HTTP endpoint. The on-disk layout
 * (`refs/wip/<project-branch>/<writer-id>`) is shared with the server writer
 * through `@inkeep/open-knowledge-core`'s `shadow-repo-layout` helpers,
 * so a CLI reader never hand-rolls the regex or path rules.
 */
import { resolve } from 'node:path';
import type { ShadowContributor } from '@inkeep/open-knowledge-core';
import {
  getShadowRepoPath,
  getWipRefPattern,
  parseOkActor,
  parseWriterId,
  readContributors,
  type WriterClassification,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit, { type SimpleGit } from 'simple-git';

export interface ShadowCommit {
  hash: string;
  /** ISO-8601 committer date. */
  date: string;
  /** Full writer id from the ref (e.g., `agent-abc123`). */
  writerId: string;
  /** Author name as recorded in the shadow commit. */
  writerName: string;
  /**
   * Convenience boolean derived from `writerClassification`:
   *   - `true`  when classification === 'agent'
   *   - `false` when classification === 'human'
   *   - `null`  when 'upstream' | 'server' | 'unknown' (indeterminate)
   *
   * Prefer `writerClassification` when reasoning about attribution —
   * `isAgent: null` is ambiguous between "not an agent" and "unknown."
   */
  isAgent: boolean | null;
  /** Unambiguous discriminator; preferred over `isAgent` for reasoning. */
  writerClassification: WriterClassification;
  message: string;
  /** Project branch this commit was recorded against. */
  branch: string;
  /** Agent contributors parsed from the commit message body. Empty for pre-attribution commits. */
  contributors: ShadowContributor[];
}

const GIT_TIMEOUT_MS = 5000;

/** The two distinct historySource states. */
export type HistorySource = 'shadow-repo' | 'shadow-repo-absent';

interface ReadShadowLogResult {
  commits: ShadowCommit[];
  source: HistorySource;
}

/** Read the project's currently checked-out branch name. Returns null when the project isn't a git repo or is detached. */
async function currentProjectBranch(projectDir: string): Promise<string | null> {
  try {
    const git = simpleGit({ baseDir: projectDir, timeout: { block: GIT_TIMEOUT_MS } });
    const raw = await git.revparse(['--abbrev-ref', 'HEAD']);
    const branch = raw.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

function openShadowGit(shadowDir: string, workTree: string): SimpleGit {
  return simpleGit({ baseDir: workTree, timeout: { block: GIT_TIMEOUT_MS } }).env({
    GIT_DIR: shadowDir,
    GIT_WORK_TREE: workTree,
  });
}

function writerIdFromRef(ref: string, branch: string): string {
  const prefix = getWipRefPattern(branch);
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

async function logOnRef(
  sg: SimpleGit,
  ref: string,
  relPath: string,
  branch: string,
  limit: number,
): Promise<ShadowCommit[]> {
  let out = '';
  try {
    out = await sg.raw(
      'log',
      ref,
      `-${Math.max(1, limit * 2)}`,
      '--format=%H%x00%aI%x00%an%x00%s%x00%B%x1e',
      '--',
      relPath,
    );
  } catch {
    return [];
  }

  const writerId = writerIdFromRef(ref, branch);
  const parsed = parseWriterId(writerId);
  const commits: ShadowCommit[] = [];
  for (const record of out.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const parts = trimmed.split('\x00');
    const [hash = '', date = '', writerName = '', message = '', rawBody = ''] = parts;
    const sha = hash.trim();
    if (sha.length !== 40) continue;
    commits.push({
      hash: sha,
      date,
      writerName,
      message,
      contributors: readContributors(rawBody),
      writerId,
      isAgent: parsed.isAgent,
      writerClassification: parsed.classification,
      branch,
    });
  }
  return commits;
}

/**
 * Checkpoint-ancestry fallback. When the per-writer WIP
 * refs are shallow — e.g. immediately after an auto-consolidation folded the
 * dead chains and deleted their refs — the WIP commits are now reachable ONLY
 * through the latest checkpoint's ancestry. Walk it (bounded `-n`) for `relPath`,
 * skipping the checkpoint/park/import commits themselves and already-seen hashes,
 * and attribute each surviving WIP commit via its `ok-actor:` body line (the
 * source of truth — the ref name is gone). Keeps the enriched read populated
 * across a consolidation.
 */
async function checkpointAncestryFallback(
  sg: SimpleGit,
  branch: string,
  relPath: string,
  need: number,
  seen: Set<string>,
): Promise<ShadowCommit[]> {
  let latestCheckpoint = '';
  try {
    latestCheckpoint = (
      await sg.raw(
        'for-each-ref',
        '--sort=-creatordate',
        '--count=1',
        '--format=%(objectname)',
        `refs/checkpoints/${branch}/`,
      )
    ).trim();
  } catch {
    return [];
  }
  if (!latestCheckpoint) return [];

  let out = '';
  try {
    // Bounded walk with slack for skipped checkpoint/seen rows.
    out = await sg.raw(
      'log',
      latestCheckpoint,
      `-${Math.max(need * 3, 20)}`,
      '--format=%H%x00%aI%x00%an%x00%s%x00%B%x1e',
      '--',
      relPath,
    );
  } catch {
    return [];
  }

  const commits: ShadowCommit[] = [];
  for (const record of out.split('\x1e')) {
    if (commits.length >= need) break;
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [hash = '', date = '', authorName = '', subject = '', rawBody = ''] =
      trimmed.split('\x00');
    const sha = hash.trim();
    if (sha.length !== 40 || seen.has(sha)) continue;
    // Skip the consolidation/park/import markers themselves — only real WIP
    // activity counts as "recent activity" (matches the WIP-ref read).
    if (
      subject.startsWith('checkpoint:') ||
      subject.startsWith('park:') ||
      subject.startsWith('import:') ||
      subject.startsWith('upstream:')
    ) {
      continue;
    }
    // Attribute via the ok-actor body line — the ref name no longer exists.
    const actor = parseOkActor(rawBody);
    const writerId = actor?.writer_id ?? '';
    const parsed = parseWriterId(writerId);
    seen.add(sha);
    commits.push({
      hash: sha,
      date,
      writerName: actor?.display_name ?? authorName,
      message: subject,
      contributors: readContributors(rawBody),
      writerId,
      isAgent: parsed.isAgent,
      writerClassification: parsed.classification,
      branch,
    });
  }
  return commits;
}

/**
 * Read the last N shadow-repo commits touching `relPath`, merged across
 * per-writer refs on the project's current branch, sorted by committer
 * date descending.
 *
 * Returns `{ commits: [], source: 'shadow-repo-absent' }` when the shadow
 * repo doesn't exist (project never initialized with OK) so agents can
 * distinguish "no repo" from "no edits on this path."
 */
export async function readShadowLog(
  projectDir: string,
  relPath: string,
  limit = 5,
): Promise<ReadShadowLogResult> {
  const shadowDir = getShadowRepoPath(projectDir);
  if (!shadowDir) return { commits: [], source: 'shadow-repo-absent' };

  const branch = await currentProjectBranch(projectDir);
  if (!branch) return { commits: [], source: 'shadow-repo' };

  const sg = openShadowGit(shadowDir, resolve(projectDir));

  let refsRaw = '';
  try {
    refsRaw = await sg.raw('for-each-ref', getWipRefPattern(branch), '--format=%(refname)');
  } catch {
    return { commits: [], source: 'shadow-repo' };
  }
  const refs = refsRaw
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);

  const perRef =
    refs.length === 0
      ? []
      : await Promise.all(refs.map((ref) => logOnRef(sg, ref, relPath, branch, limit)));
  let commits = perRef
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);

  // If the WIP refs are too shallow to fill the window (e.g. a
  // consolidation just folded + deleted the dead chains), continue into the
  // latest checkpoint's ancestry so a read right after a consolidation still
  // returns the same recent activity as the read right before it.
  if (commits.length < limit) {
    const seen = new Set(commits.map((c) => c.hash));
    const fallback = await checkpointAncestryFallback(
      sg,
      branch,
      relPath,
      limit - commits.length,
      seen,
    );
    if (fallback.length > 0) {
      commits = [...commits, ...fallback]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
    }
  }

  return { commits, source: 'shadow-repo' };
}
