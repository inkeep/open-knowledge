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
  stripRemotePrefix,
  WORKTREES_PARENT_DIR,
  type WorktreeCreateRequest,
  type WorktreeCreateResult,
  type WorktreeListResult,
  worktreeRelativeDir,
} from '@inkeep/open-knowledge-core';
import {
  assertRepoCheckoutSymlinksSafe,
  redactShareSubprocessStderr,
  UnsafeIncomingSymlinkError,
} from '@inkeep/open-knowledge-server';
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
  const refs = await readRefSnapshot(anchorPath);
  const behind = await computeBehindCounts(anchorPath, worktrees[0]?.path ?? anchorPath, refs);
  const resolvedCurrent = resolveAnchorToplevel(currentProjectPath, worktrees);
  const model = buildWorktreeSelectorModel({
    worktrees,
    branches: refs.branches,
    remoteBranches: refs.remoteBranches,
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
  const target = {
    anchorPath: args.anchorPath,
    branch,
    projectSubPath: args.projectSubPath,
    sourceProjectPath: args.sourceProjectPath,
  };

  const localRef = `refs/heads/${branch}`;
  if (await refExists(args.anchorPath, localRef)) {
    if (!worktrees.some((w) => !w.prunable && w.branch === branch)) {
      const refused = await refuseUnsafeSymlinks(args.anchorPath, localRef);
      if (refused !== null) return refused;
    }
    return createWorktree({ ...target, createBranch: false });
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (!(await refExists(args.anchorPath, remoteRef))) {
    const failure = await fetchShareBranch(
      args.anchorPath,
      branch,
      args.fetchTimeoutMs ?? SHARE_FETCH_TIMEOUT_MS,
    );
    if (failure !== null) return failure;
  }
  const commit = await resolveCommit(args.anchorPath, remoteRef);
  if (commit === null) return { ok: false, reason: 'branch-not-found' };
  const refused = await refuseUnsafeSymlinks(args.anchorPath, commit);
  if (refused !== null) return refused;
  const result = await createWorktree({ ...target, baseRef: commit, createBranch: true });
  if (result.ok ? result.created : result.reason === 'project-scope-unavailable') {
    await setOriginUpstream(args.anchorPath, branch);
  }
  return result;
}

async function resolveCommit(anchorPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { cwd: anchorPath, env: gitSpawnEnv(), timeout: 5_000, windowsHide: true },
    );
    const commit = String(stdout).trim();
    return /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

async function refuseUnsafeSymlinks(
  anchorPath: string,
  ref: string,
): Promise<Extract<WorktreeCreateResult, { ok: false }> | null> {
  try {
    await assertRepoCheckoutSymlinksSafe(anchorPath, ref);
    return null;
  } catch (err) {
    if (err instanceof UnsafeIncomingSymlinkError) {
      getLogger('worktree').warn(
        { refusedCount: err.unsafe.length },
        'refused a share-branch worktree whose branch carries unsafe symlinks',
      );
      return {
        ok: false,
        reason: 'unsafe-symlinks',
        refusedSymlinkPaths: err.displayPaths(),
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: redactShareSubprocessStderr(gitErrorText(err)).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

async function setOriginUpstream(anchorPath: string, branch: string): Promise<void> {
  for (const [key, value] of [
    [`branch.${branch}.remote`, 'origin'],
    [`branch.${branch}.merge`, `refs/heads/${branch}`],
  ]) {
    try {
      await execFileAsync('git', ['config', key, value], {
        cwd: anchorPath,
        env: gitSpawnEnv(),
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (err) {
      getLogger('worktree').warn(
        { key, error: gitErrorText(err).replace(/\s+/g, ' ').slice(0, 200) },
        'could not record the share branch upstream',
      );
    }
  }
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

interface RefSnapshot {
  readonly branches: readonly string[];
  readonly remoteBranches: readonly string[];
  readonly localShas: ReadonlyMap<string, string>;
  readonly originShas: ReadonlyMap<string, string>;
}

const EMPTY_REF_SNAPSHOT: RefSnapshot = {
  branches: [],
  remoteBranches: [],
  localShas: new Map(),
  originShas: new Map(),
};

const REF_LIST_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const REF_LIST_TIMEOUT_MS = 15_000;
const BEHIND_COUNT_TIMEOUT_MS = 30_000;
const LOCAL_REF_PREFIX = 'refs/heads/';
const REMOTE_REF_PREFIX = 'refs/remotes/';
const ORIGIN_PREFIX = 'origin/';

async function readRefSnapshot(anchorPath: string): Promise<RefSnapshot> {
  if (!isAbsolute(anchorPath)) return EMPTY_REF_SNAPSHOT;
  let stdout: string;
  try {
    const result = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(objectname) %(refname)', LOCAL_REF_PREFIX, REMOTE_REF_PREFIX],
      {
        cwd: anchorPath,
        env: gitSpawnEnv(),
        maxBuffer: REF_LIST_MAX_BUFFER_BYTES,
        timeout: REF_LIST_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    stdout = String(result.stdout);
  } catch {
    return EMPTY_REF_SNAPSHOT;
  }
  const branches: string[] = [];
  const remoteBranches: string[] = [];
  const localShas = new Map<string, string>();
  const originShas = new Map<string, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const sha = line.slice(0, space);
    const refname = line.slice(space + 1);
    if (refname.startsWith(LOCAL_REF_PREFIX)) {
      const branch = refname.slice(LOCAL_REF_PREFIX.length);
      if (branch.length === 0) continue;
      branches.push(branch);
      localShas.set(branch, sha);
    } else if (refname.startsWith(REMOTE_REF_PREFIX)) {
      const ref = refname.slice(REMOTE_REF_PREFIX.length);
      if (!ref.includes('/') || stripRemotePrefix(ref) === 'HEAD') continue;
      remoteBranches.push(ref);
      if (ref.startsWith(ORIGIN_PREFIX)) originShas.set(ref.slice(ORIGIN_PREFIX.length), sha);
    }
  }
  return { branches, remoteBranches, localShas, originShas };
}

const BEHIND_COUNT_CONCURRENCY = 8;
let activeBehindCounts = 0;
const behindCountWaiters: (() => void)[] = [];
const behindCountCache = new Map<string, Map<string, Promise<number | null>>>();

async function withBehindCountSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeBehindCounts < BEHIND_COUNT_CONCURRENCY) {
    activeBehindCounts += 1;
  } else {
    await new Promise<void>((resolve) => behindCountWaiters.push(resolve));
  }
  try {
    return await run();
  } finally {
    const next = behindCountWaiters.shift();
    if (next) next();
    else activeBehindCounts -= 1;
  }
}

async function countCommitsInRange(anchorPath: string, range: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', range], {
      cwd: anchorPath,
      env: gitSpawnEnv(),
      timeout: BEHIND_COUNT_TIMEOUT_MS,
      windowsHide: true,
    });
    const n = Number.parseInt(String(stdout).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function computeBehindCounts(
  anchorPath: string,
  repositoryRoot: string,
  refs: RefSnapshot,
): Promise<Record<string, number>> {
  if (!isAbsolute(anchorPath)) return {};
  const previous = behindCountCache.get(repositoryRoot);
  const current = new Map<string, Promise<number | null>>();
  behindCountCache.set(repositoryRoot, current);
  const out: Record<string, number> = {};
  const settled: Promise<void>[] = [];
  for (const branch of refs.branches) {
    const localSha = refs.localShas.get(branch);
    const originSha = refs.originShas.get(branch);
    if (localSha === undefined || originSha === undefined) continue;
    const range = `${localSha}..${originSha}`;
    const count =
      current.get(range) ??
      previous?.get(range) ??
      withBehindCountSlot(() => countCommitsInRange(anchorPath, range));
    current.set(range, count);
    settled.push(
      count.then((n) => {
        if (n !== null) {
          out[branch] = n;
          return;
        }
        const cache = behindCountCache.get(repositoryRoot);
        if (cache?.get(range) === count) cache.delete(range);
      }),
    );
  }
  await Promise.all(settled);
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
