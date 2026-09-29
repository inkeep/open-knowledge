import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitSpawnEnv } from './git-spawn-env.ts';

const execFileAsync = promisify(execFile);

export interface RecentGitInfo {
  readonly gitCommonDir: string | null;
  readonly mainRoot: string | null;
  readonly checkoutRoot: string | null;
  readonly projectSubPath: string | null;
  readonly isLinkedWorktree: boolean;
}

const EMPTY: RecentGitInfo = {
  gitCommonDir: null,
  mainRoot: null,
  checkoutRoot: null,
  projectSubPath: null,
  isLinkedWorktree: false,
};

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

export async function classifyRecentGitAsync(
  projectPath: string,
  fresh = false,
): Promise<RecentGitInfo> {
  if (!isAbsolute(projectPath)) return EMPTY;
  let key: string;
  try {
    key = realpathSync(projectPath);
  } catch {
    return EMPTY;
  }
  const cached = fresh ? undefined : cache.get(key);
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
  return parseRevParse(out, realPath);
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
  return parseRevParse(out, realPath);
}

function parseRevParse(out: string, projectPath: string): RecentGitInfo {
  const [topLevelRaw, commonDirRaw] = out.split('\n');
  const topLevel = topLevelRaw?.trim();
  const commonDir = commonDirRaw?.trim();
  if (!topLevel || !commonDir) return EMPTY;

  const checkoutRoot = safeRealpath(topLevel);
  const gitCommonDir = safeRealpath(commonDir);
  const mainRoot = safeRealpath(
    basename(gitCommonDir) === '.git' ? dirname(gitCommonDir) : topLevel,
  );
  const isLinkedWorktree = realpathEq(checkoutRoot, mainRoot) === false;
  const relativeProjectPath = relative(checkoutRoot, projectPath);
  if (
    relativeProjectPath === '..' ||
    relativeProjectPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeProjectPath)
  ) {
    return EMPTY;
  }
  const projectSubPath = relativeProjectPath === '.' ? '' : relativeProjectPath;
  return { gitCommonDir, mainRoot, checkoutRoot, projectSubPath, isLinkedWorktree };
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
