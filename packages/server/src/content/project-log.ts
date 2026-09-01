import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';

export interface GitCommit {
  hash: string;
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
