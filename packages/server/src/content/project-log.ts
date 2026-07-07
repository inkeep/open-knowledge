/**
 * CLI-side reader for the **project repo's** git log — complements
 * `shadow-log.ts`. Both sources are surfaced in rich enrichment:
 *   - shadow-repo → live agent/human edit bursts
 *   - project git → durable authored commits (this file)
 *
 * Shadow-repo captures external project-git commits as `upstream` imports,
 * but lossily (message becomes `upstream: import from <o>..<n>`, author
 * becomes "openknowledge"). Reading the project's own `git log` preserves
 * the original human-authored commit messages and author names.
 *
 * Uses simple-git against the project's `.git/`, not the shadow repo.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';

export interface GitCommit {
  hash: string;
  /** ISO-8601 committer date. */
  date: string;
  authorName: string;
  subject: string;
}

export type ProjectHistorySource = 'git' | 'git-absent';

interface ReadProjectGitLogResult {
  commits: GitCommit[];
  source: ProjectHistorySource;
}

const GIT_TIMEOUT_MS = 5000;

function projectHasGitDir(projectDir: string): boolean {
  try {
    return statSync(resolve(projectDir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function openProjectGit(projectDir: string): SimpleGit {
  return simpleGit({ baseDir: resolve(projectDir), timeout: { block: GIT_TIMEOUT_MS } });
}

/**
 * Read the last N project-git commits touching `relPath`. Returns
 * `{ commits: [], source: 'git-absent' }` when the project isn't a git
 * repo; returns `{ commits: [], source: 'git' }` when it is but the file
 * has no commits (new, untracked, or recently created).
 */
export async function readProjectGitLog(
  projectDir: string,
  relPath: string,
  limit = 5,
): Promise<ReadProjectGitLogResult> {
  if (!projectHasGitDir(projectDir)) return { commits: [], source: 'git-absent' };

  const git = openProjectGit(projectDir);
  let out = '';
  try {
    out = await git.raw(
      'log',
      `-${Math.max(1, limit)}`,
      '--format=%H|%aI|%an|%s',
      '--follow',
      '--',
      relPath,
    );
  } catch {
    // Non-fatal: no history, ambiguous revision, etc.
    return { commits: [], source: 'git' };
  }

  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const firstPipe = line.indexOf('|');
    if (firstPipe < 0) continue;
    const secondPipe = line.indexOf('|', firstPipe + 1);
    if (secondPipe < 0) continue;
    const thirdPipe = line.indexOf('|', secondPipe + 1);
    if (thirdPipe < 0) continue;
    commits.push({
      hash: line.slice(0, firstPipe),
      date: line.slice(firstPipe + 1, secondPipe),
      authorName: line.slice(secondPipe + 1, thirdPipe),
      subject: line.slice(thirdPipe + 1),
    });
  }
  return { commits, source: 'git' };
}
