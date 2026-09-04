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
import { resolveCheckpointChainAnchors } from '../checkpoint-chain.ts';
import { getLogger } from '../logger.ts';

export interface ShadowCommit {
  hash: string;
  date: string;
  writerId: string;
  writerName: string;
  isAgent: boolean | null;
  writerClassification: WriterClassification;
  message: string;
  branch: string;
  contributors: ShadowContributor[];
}

const GIT_TIMEOUT_MS = 5000;

export type HistorySource = 'shadow-repo' | 'shadow-repo-absent';

interface ReadShadowLogResult {
  commits: ShadowCommit[];
  source: HistorySource;
}

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

async function checkpointAncestryFallback(
  sg: SimpleGit,
  branch: string,
  relPath: string,
  need: number,
  seen: Set<string>,
): Promise<ShadowCommit[]> {
  let anchors: string[];
  try {
    anchors = await resolveCheckpointChainAnchors(sg, branch);
  } catch (err) {
    getLogger('shadow-log').warn(
      { branch, relPath, err },
      '[shadow-log] chain anchors unresolved; per-path history degraded to empty',
    );
    return [];
  }
  if (anchors.length === 0) return [];

  let out = '';
  try {
    out = await sg.raw(
      'log',
      ...anchors,
      `-${Math.max(need * 3, 20)}`,
      '--format=%H%x00%aI%x00%an%x00%s%x00%B%x1e',
      '--',
      relPath,
    );
  } catch (err) {
    getLogger('shadow-log').warn(
      { branch, relPath, anchorCount: anchors.length, err },
      '[shadow-log] ancestry walk failed; per-path history degraded to empty',
    );
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
    if (
      subject.startsWith('checkpoint:') ||
      subject.startsWith('park:') ||
      subject.startsWith('import:') ||
      subject.startsWith('upstream:')
    ) {
      continue;
    }
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
