import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitSpawnEnv } from './git-spawn-env.ts';

const execFileAsync = promisify(execFile);

export interface RecentGitInfo {
  readonly gitCommonDir: string | null;
  readonly mainRoot: string | null;
  readonly isLinkedWorktree: boolean;
}

const EMPTY: RecentGitInfo = { gitCommonDir: null, mainRoot: null, isLinkedWorktree: false };

const cache = new Map<string, RecentGitInfo>();

export function clearRecentGitCache(): void {
  cache.clear();
}

export function readWorktreeBranch(projectPath: string): string | null {
  if (!isAbsolute(projectPath)) return null;
  try {
    const out = String(
      execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: projectPath,
        env: gitSpawnEnv(),
        windowsHide: true,
      }),
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function readWorktreeBranchAsync(projectPath: string): Promise<string | null> {
  if (!isAbsolute(projectPath)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: projectPath,
      env: gitSpawnEnv(),
      windowsHide: true,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function classifyRecentGit(projectPath: string): RecentGitInfo {
  if (!isAbsolute(projectPath)) return EMPTY;
  let key: string;
  try {
    key = realpathSync(projectPath);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const info = computeRecentGit(key);
  cache.set(key, info);
  return info;
}

export async function classifyRecentGitAsync(projectPath: string): Promise<RecentGitInfo> {
  if (!isAbsolute(projectPath)) return EMPTY;
  let key: string;
  try {
    key = realpathSync(projectPath);
  } catch {
    return EMPTY;
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const info = await computeRecentGitAsync(key);
  cache.set(key, info);
  return info;
}

const REV_PARSE_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-common-dir',
] as const;

function computeRecentGit(realPath: string): RecentGitInfo {
  let out: string;
  try {
    out = String(
      execFileSync('git', [...REV_PARSE_ARGS], {
        cwd: realPath,
        env: gitSpawnEnv(),
        windowsHide: true,
      }),
    );
  } catch {
    return EMPTY;
  }
  return parseRevParse(out);
}

async function computeRecentGitAsync(realPath: string): Promise<RecentGitInfo> {
  let out: string;
  try {
    const { stdout } = await execFileAsync('git', [...REV_PARSE_ARGS], {
      cwd: realPath,
      env: gitSpawnEnv(),
      windowsHide: true,
    });
    out = stdout;
  } catch {
    return EMPTY;
  }
  return parseRevParse(out);
}

function parseRevParse(out: string): RecentGitInfo {
  const [topLevelRaw, commonDirRaw] = out.split('\n');
  const topLevel = topLevelRaw?.trim();
  const commonDir = commonDirRaw?.trim();
  if (!topLevel || !commonDir) return EMPTY;

  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : topLevel;
  const isLinkedWorktree = realpathEq(topLevel, mainRoot) === false;
  return { gitCommonDir: commonDir, mainRoot, isLinkedWorktree };
}

function realpathEq(a: string, b: string): boolean {
  const ra = safeRealpath(a);
  const rb = safeRealpath(b);
  return resolve(ra) === resolve(rb);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
