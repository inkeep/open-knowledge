import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  buildWorktreeSelectorModel,
  classifyGitAuthError,
  detectMissingGitHelper,
  isBranchNotFoundGitError,
  isLoginFixableGitAuthError,
  isValidBranchName,
  parseBranchList,
  stripRemotePrefix,
  WORKTREES_PARENT_DIR,
  type WorktreeCreateRequest,
  type WorktreeCreateResult,
  type WorktreeListResult,
  worktreeRelativeDir,
} from '@inkeep/open-knowledge-core';
import { redactShareSubprocessStderr } from '@inkeep/open-knowledge-server';
import { isPathWithinProject } from '../shared/path-containment.ts';
import { getLogger } from './desktop-logger.ts';
import { gitSpawnEnv } from './git-spawn-env.ts';
import { listGitWorktrees } from './list-git-worktrees.ts';
import { seedWorktreeAutoSync } from './worktree-autosync-inherit.ts';
import { clearRecentGitCache } from './worktree-recents.ts';
import {
  assertWorktreeProjectSetupSafe,
  seedWorktreeProjectSetup,
  WorktreeSetupPathSafetyError,
} from './worktree-setup-inherit.ts';

const execFileAsync = promisify(execFile);

function fetchGitEnv(): Record<string, string | undefined> {
  return { ...gitSpawnEnv(), GIT_TERMINAL_PROMPT: '0' };
}

export function buildShareFetchArgs(branch: string): string[] {
  return ['-c', 'credential.interactive=false', 'fetch', 'origin', branch];
}

const SHARE_FETCH_TIMEOUT_MS = 15_000;

export type { WorktreeCreateResult, WorktreeListResult };

export interface CreateWorktreeArgs extends WorktreeCreateRequest {
  readonly anchorPath: string;
  readonly projectSubPath?: string;
  readonly sourceProjectPath?: string;
}

export async function listWorktreeSelector(
  anchorPath: string,
  currentProjectPath: string,
): Promise<WorktreeListResult> {
  const worktrees = await listGitWorktrees(anchorPath);
  if (worktrees.length === 0) return { ok: false, reason: 'no-git' };
  const branches = await listLocalBranches(anchorPath);
  const remoteBranches = await listRemoteBranches(anchorPath);
  const behind = await computeBehindCounts(anchorPath, branches, remoteBranches);
  const resolvedCurrent = resolveAnchorToplevel(currentProjectPath, worktrees);
  const model = buildWorktreeSelectorModel({
    worktrees,
    branches,
    remoteBranches,
    behind,
    currentProjectPath: resolvedCurrent,
  });
  return { ok: true, model };
}

function resolveAnchorToplevel(
  anchorPath: string,
  worktrees: readonly { readonly path: string; readonly prunable: boolean }[],
): string {
  let anchor = anchorPath;
  try {
    anchor = realpathSync(anchorPath);
  } catch {}
  let best: string | null = null;
  for (const w of worktrees) {
    if (w.prunable) continue;
    const isSelfOrAncestor = anchor === w.path || anchor.startsWith(w.path + sep);
    if (isSelfOrAncestor && (best === null || w.path.length > best.length)) {
      best = w.path;
    }
  }
  return best ?? anchorPath;
}

export async function createWorktree(args: CreateWorktreeArgs): Promise<WorktreeCreateResult> {
  const rel = worktreeRelativeDir(args.branch);
  const projectSubPath = args.projectSubPath ?? '';
  if (rel === null || !isAbsolute(args.anchorPath)) {
    return { ok: false, reason: 'invalid-branch' };
  }
  if (
    (args.sourceProjectPath !== undefined && !isAbsolute(args.sourceProjectPath)) ||
    !isValidProjectSubPath(projectSubPath)
  ) {
    return { ok: false, reason: 'error', message: 'Invalid project scope' };
  }

  const worktrees = await listGitWorktrees(args.anchorPath);
  if (worktrees.length === 0) return { ok: false, reason: 'no-git' };
  const mainRoot = worktrees[0]?.path;
  if (mainRoot === undefined) return { ok: false, reason: 'no-git' };

  const existing = worktrees.find((w) => !w.prunable && w.branch === args.branch.trim());
  if (existing) return { ok: true, path: existing.path, created: false };

  const worktreePath = join(mainRoot, rel);

  ensureWorktreesExcluded(args.anchorPath);

  const addArgs = buildAddArgs(args, worktreePath);

  try {
    await execFileAsync('git', addArgs, {
      cwd: args.anchorPath,
      env: gitSpawnEnv(),
      windowsHide: true,
    });
  } catch (err) {
    const classified = classifyAddError(err);
    if (classified.reason === 'error' && !(await repoHasAnyRef(args.anchorPath))) {
      return { ok: false, reason: 'empty-repo', message: classified.message };
    }
    return { ok: false, ...classified };
  }

  clearRecentGitCache();
  const projectScope = resolveContainedProjectPath(worktreePath, projectSubPath);
  if (!projectScope.ok) {
    getLogger('worktree').warn(
      { worktreePath, projectSubPath, issue: projectScope.issue },
      'skipped project setup outside the created worktree',
    );
    return {
      ok: false,
      reason: 'project-scope-unavailable',
      issue: projectScope.issue,
      path: worktreePath,
      created: true,
    };
  }
  const sourceProjectPath = args.sourceProjectPath ?? args.anchorPath;
  try {
    seedWorktreeProjectSetup(projectScope.path, sourceProjectPath);
  } catch (error) {
    return projectSetupFailure(error, worktreePath, projectSubPath);
  }
  try {
    assertWorktreeProjectSetupSafe(projectScope.path, sourceProjectPath);
  } catch (error) {
    return projectSetupFailure(error, worktreePath, projectSubPath);
  }
  try {
    await seedWorktreeAutoSync(projectScope.path, sourceProjectPath);
  } catch (error) {
    return projectSetupFailure(error, worktreePath, projectSubPath);
  }
  return { ok: true, path: worktreePath, created: true };
}

function projectSetupFailure(
  error: unknown,
  worktreePath: string,
  projectSubPath: string,
): WorktreeCreateResult {
  const issue =
    error instanceof WorktreeSetupPathSafetyError ? 'unsafe-setup-path' : 'setup-failed';
  getLogger('worktree').warn(
    { worktreePath, projectSubPath, issue, error },
    'project setup failed in the created worktree',
  );
  return {
    ok: false,
    reason: 'project-scope-unavailable',
    issue,
    path: worktreePath,
    created: true,
  };
}

function isValidProjectSubPath(projectSubPath: string): boolean {
  if (projectSubPath.includes('\0') || isAbsolute(projectSubPath)) return false;
  return !projectSubPath.split(/[\\/]/).some((segment) => segment === '..');
}

type ProjectScopeResolution =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly issue: 'missing' | 'unreadable' | 'outside-worktree';
    };

function resolveContainedProjectPath(
  worktreePath: string,
  projectSubPath: string,
): ProjectScopeResolution {
  try {
    const worktreeRoot = realpathSync(worktreePath);
    const candidate =
      projectSubPath.length === 0 ? worktreePath : join(worktreePath, projectSubPath);
    if (!statSync(candidate).isDirectory()) return { ok: false, issue: 'missing' };
    const canonicalCandidate = realpathSync(candidate);
    return isPathWithinProject(canonicalCandidate, worktreeRoot, process.platform)
      ? { ok: true, path: canonicalCandidate }
      : { ok: false, issue: 'outside-worktree' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      issue: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
    };
  }
}

export interface ShareBranchCheckoutArgs {
  readonly anchorPath: string;
  readonly branch: string;
  readonly fetchTimeoutMs?: number;
  readonly projectSubPath?: string;
  readonly sourceProjectPath?: string;
}

export async function checkoutShareBranchWorktree(
  args: ShareBranchCheckoutArgs,
): Promise<WorktreeCreateResult> {
  const branch = args.branch.trim();
  if (
    !isValidBranchName(branch) ||
    worktreeRelativeDir(branch) === null ||
    !isAbsolute(args.anchorPath)
  ) {
    return { ok: false, reason: 'invalid-branch' };
  }
  const worktrees = await listGitWorktrees(args.anchorPath);
  if (worktrees.length === 0) return { ok: false, reason: 'no-git' };

  if (await refExists(args.anchorPath, `refs/heads/${branch}`)) {
    return createWorktree({
      anchorPath: args.anchorPath,
      branch,
      createBranch: false,
      projectSubPath: args.projectSubPath,
      sourceProjectPath: args.sourceProjectPath,
    });
  }
  const remoteRef = `origin/${branch}`;
  if (!(await refExists(args.anchorPath, `refs/remotes/${remoteRef}`))) {
    const failure = await fetchShareBranch(
      args.anchorPath,
      branch,
      args.fetchTimeoutMs ?? SHARE_FETCH_TIMEOUT_MS,
    );
    if (failure !== null) return failure;
  }
  return createWorktree({
    anchorPath: args.anchorPath,
    branch,
    remoteRef,
    createBranch: true,
    projectSubPath: args.projectSubPath,
    sourceProjectPath: args.sourceProjectPath,
  });
}

async function refExists(anchorPath: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd: anchorPath,
      env: gitSpawnEnv(),
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code !== 1) {
      console.warn(
        `[worktree-service] refExists unexpected failure ref=${ref} error=${gitErrorText(err).replace(/\s+/g, ' ').slice(0, 200)}`,
      );
    }
    return false;
  }
}

async function fetchShareBranch(
  anchorPath: string,
  branch: string,
  timeoutMs: number,
): Promise<Extract<WorktreeCreateResult, { ok: false }> | null> {
  try {
    await execFileAsync('git', buildShareFetchArgs(branch), {
      cwd: anchorPath,
      env: fetchGitEnv(),
      timeout: timeoutMs,
      windowsHide: true,
    });
    return null;
  } catch (err) {
    if (isBranchNotFoundGitError(err)) return { ok: false, reason: 'branch-not-found' };
    const killed = (err as { killed?: boolean }).killed === true;
    const signal = (err as { signal?: string }).signal;
    const raw = redactShareSubprocessStderr(gitErrorText(err)).replace(/\s+/g, ' ').slice(0, 280);
    const classified = classifyGitAuthError(err);
    const authFailed = isLoginFixableGitAuthError(classified);
    const notFoundAsIdentity =
      classified.kind === 'auth' && classified.subclass === 'not-found-as-identity';
    return {
      ok: false,
      reason: 'fetch-failed',
      message: killed ? `[timeout signal=${signal ?? 'SIGTERM'}] ${raw}` : raw,
      ...(authFailed ? { authFailed: true as const } : {}),
      ...(notFoundAsIdentity ? { notFoundAsIdentity: true as const } : {}),
    };
  }
}

function buildAddArgs(args: CreateWorktreeArgs, worktreePath: string): string[] {
  const branch = args.branch.trim();
  const remoteRef = args.remoteRef?.trim();
  if (remoteRef) {
    return ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef];
  }
  if (args.createBranch) {
    const baseRef = args.baseRef?.trim();
    if (baseRef) {
      return ['worktree', 'add', '-b', branch, worktreePath, baseRef, '--no-track'];
    }
    return [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      ...(args.baseBranch ? ['--', args.baseBranch] : []),
    ];
  }
  return ['worktree', 'add', worktreePath, '--', branch];
}

async function listLocalBranches(anchorPath: string): Promise<string[]> {
  if (!isAbsolute(anchorPath)) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { cwd: anchorPath, env: gitSpawnEnv(), windowsHide: true },
    );
    return parseBranchList(String(stdout));
  } catch {
    return [];
  }
}

async function listRemoteBranches(anchorPath: string): Promise<string[]> {
  if (!isAbsolute(anchorPath)) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'],
      { cwd: anchorPath, env: gitSpawnEnv(), windowsHide: true },
    );
    return parseBranchList(String(stdout)).filter(
      (ref) => ref.includes('/') && stripRemotePrefix(ref) !== 'HEAD',
    );
  } catch {
    return [];
  }
}

async function computeBehindCounts(
  anchorPath: string,
  branches: readonly string[],
  remoteBranches: readonly string[],
): Promise<Record<string, number>> {
  if (!isAbsolute(anchorPath)) return {};
  const remoteRefSet = new Set(remoteBranches);
  const out: Record<string, number> = {};
  await Promise.all(
    branches.map(async (branch) => {
      const upstream = `origin/${branch}`;
      if (!remoteRefSet.has(upstream)) return;
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${branch}..${upstream}`],
          { cwd: anchorPath, env: gitSpawnEnv(), windowsHide: true },
        );
        const n = Number.parseInt(String(stdout).trim(), 10);
        if (Number.isFinite(n) && n >= 0) out[branch] = n;
      } catch {}
    }),
  );
  return out;
}

function ensureWorktreesExcluded(anchorPath: string): void {
  try {
    const commonDir = execFileSyncTrim(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      anchorPath,
    );
    if (commonDir === null) return;
    const excludePath = join(commonDir, 'info', 'exclude');
    const line = `/${WORKTREES_PARENT_DIR}/`;
    let current = '';
    try {
      current = readFileSync(excludePath, 'utf-8');
    } catch {}
    if (current.split('\n').some((l) => l.trim() === line)) return;
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(excludePath, `${prefix}${line}\n`);
  } catch {}
}

async function repoHasAnyRef(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['for-each-ref', '--count=1', 'refs/'], {
      cwd,
      env: gitSpawnEnv(),
      windowsHide: true,
    });
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

function execFileSyncTrim(cmd: string, cmdArgs: string[], cwd: string): string | null {
  try {
    return String(
      execFileSync(cmd, cmdArgs, { cwd, env: gitSpawnEnv(), windowsHide: true }),
    ).trim();
  } catch {
    return null;
  }
}

interface ExecErr {
  stderr?: string | Buffer;
  message?: string;
}

type AddErrorClassification =
  | {
      readonly reason: 'helper-not-found';
      readonly helper: string;
      readonly message?: string;
    }
  | {
      readonly reason: 'branch-exists' | 'already-checked-out' | 'path-exists' | 'error';
      readonly message?: string;
      readonly helper?: never;
    };

function gitErrorText(err: unknown): string {
  const e = typeof err === 'object' && err !== null ? (err as ExecErr) : null;
  const stderrRaw = e?.stderr;
  return stderrRaw !== undefined && stderrRaw !== null
    ? Buffer.isBuffer(stderrRaw)
      ? stderrRaw.toString('utf-8')
      : String(stderrRaw)
    : String(e?.message ?? err);
}

function classifyAddError(err: unknown): AddErrorClassification {
  const raw = gitErrorText(err);
  const stderr = raw.toLowerCase();
  if (stderr.includes('already checked out')) return { reason: 'already-checked-out' };
  if (stderr.includes('already exists') && stderr.includes('branch')) {
    return { reason: 'branch-exists' };
  }
  if (stderr.includes('already exists')) return { reason: 'path-exists' };
  const helper = detectMissingGitHelper(raw);
  if (helper !== null) {
    return { reason: 'helper-not-found', helper, message: raw.replace(/\s+/g, ' ').slice(0, 300) };
  }
  return { reason: 'error', message: raw.replace(/\s+/g, ' ').slice(0, 300) };
}
