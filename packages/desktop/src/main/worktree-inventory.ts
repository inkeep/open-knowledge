import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  BridgeWorktreeEntry,
  WorktreeInventoryAvailability,
  WorktreeInventoryEntry,
  WorktreeInventoryLocation,
  WorktreeInventoryModel,
  WorktreeInventoryOpenRequest,
  WorktreeInventoryOpenResult,
  WorktreeInventoryResult,
} from '@inkeep/open-knowledge-core';
import { WORKTREES_PARENT_DIR } from '@inkeep/open-knowledge-core';
import { isProjectRoot } from '@inkeep/open-knowledge-server';
import { isPathWithinProject } from '../shared/path-containment.ts';
import { type GitWorktreeSnapshotResult, readGitWorktreeSnapshot } from './list-git-worktrees.ts';
import { classifyRecentGitAsync, type RecentGitInfo } from './worktree-recents.ts';

const SNAPSHOT_TTL_MS = 5_000;
const SNAPSHOT_CACHE_CAP = 12;

interface CachedSnapshot {
  readonly loadedAt: number;
  readonly entries: readonly BridgeWorktreeEntry[];
}

export interface WorktreeInventoryServiceDeps {
  readonly classifyProject: (projectPath: string, fresh?: boolean) => Promise<RecentGitInfo>;
  readonly readSnapshot: (anchorPath: string) => Promise<GitWorktreeSnapshotResult>;
  readonly availability: (path: string) => WorktreeInventoryAvailability;
  readonly checkoutAvailability: (path: string) => WorktreeInventoryAvailability;
  readonly canonicalize: (path: string) => string;
  readonly now: () => number;
}

export interface ValidatedWorktreeInventoryTarget {
  readonly ok: true;
  readonly projectPath: string;
}

export function isAllowedInventoryAnchor(
  requestedPath: string,
  currentProjectPath: string,
  recentProjectPaths: readonly string[],
): boolean {
  if (!isAbsolute(requestedPath) || requestedPath.includes('\0')) return false;
  const canonicalRequested = canonicalPath(requestedPath);
  return [currentProjectPath, ...recentProjectPaths].some(
    (candidate) => canonicalPath(candidate) === canonicalRequested,
  );
}

type WorktreeInventoryOpenFailure = Extract<WorktreeInventoryOpenResult, { readonly ok: false }>;

export class WorktreeInventoryService {
  readonly #deps: WorktreeInventoryServiceDeps;
  readonly #cache = new Map<string, CachedSnapshot>();
  readonly #inFlight = new Map<string, Promise<GitWorktreeSnapshotResult>>();
  readonly #requestSequence = new Map<string, number>();

  constructor(deps: WorktreeInventoryServiceDeps = defaultDeps()) {
    this.#deps = deps;
  }

  invalidate(gitCommonDir?: string): void {
    if (gitCommonDir === undefined) {
      this.#cache.clear();
      this.#inFlight.clear();
      for (const key of this.#requestSequence.keys()) this.#advanceSequence(key);
      return;
    }
    this.#cache.delete(gitCommonDir);
    this.#inFlight.delete(gitCommonDir);
    this.#advanceSequence(gitCommonDir);
  }

  async inventory(projectPath: string, fresh = false): Promise<WorktreeInventoryResult> {
    if (!isAbsolute(projectPath) || projectPath.includes('\0')) {
      return { ok: false, reason: 'invalid-request' };
    }
    const git = await this.#deps.classifyProject(projectPath, fresh);
    if (!hasInventoryIdentity(git)) return { ok: false, reason: 'no-git' };

    const snapshot = await this.#loadSnapshot(git.gitCommonDir, projectPath, fresh);
    if (!snapshot.ok) return { ok: false, reason: 'enumeration-failed' };
    if (snapshot.entries.length === 0) return { ok: false, reason: 'no-git' };

    return {
      ok: true,
      inventory: projectSnapshot(git, snapshot.entries, this.#deps),
    };
  }

  async validateOpen(
    request: WorktreeInventoryOpenRequest,
  ): Promise<ValidatedWorktreeInventoryTarget | WorktreeInventoryOpenFailure> {
    if (!validOpenRequest(request)) return { ok: false, reason: 'invalid-request' };
    const result = await this.inventory(request.anchorProjectPath, true);
    if (!result.ok) return result;
    const inventory = result.inventory;
    if (
      inventory.gitCommonDir !== request.gitCommonDir ||
      inventory.projectSubPath !== request.projectSubPath
    ) {
      return { ok: false, reason: 'repository-changed' };
    }
    const entry = inventory.entries.find(
      (candidate) =>
        candidate.checkoutRoot === request.checkoutRoot &&
        candidate.projectPath === request.projectPath,
    );
    if (entry === undefined) return { ok: false, reason: 'not-registered' };
    if (entry.prunable) return { ok: false, reason: 'prunable' };
    if (entry.availability !== 'available') {
      return { ok: false, reason: 'project-unavailable' };
    }
    const selectedGit = await this.#deps.classifyProject(entry.projectPath, true);
    if (!hasInventoryIdentity(selectedGit)) {
      return { ok: false, reason: 'project-unavailable' };
    }
    if (
      selectedGit.gitCommonDir !== inventory.gitCommonDir ||
      selectedGit.checkoutRoot !== entry.checkoutRoot ||
      selectedGit.projectSubPath !== inventory.projectSubPath
    ) {
      return { ok: false, reason: 'repository-changed' };
    }
    return { ok: true, projectPath: entry.projectPath };
  }

  async #loadSnapshot(
    gitCommonDir: string,
    anchorPath: string,
    fresh: boolean,
  ): Promise<GitWorktreeSnapshotResult> {
    const cached = this.#cache.get(gitCommonDir);
    if (!fresh && cached !== undefined && this.#deps.now() - cached.loadedAt < SNAPSHOT_TTL_MS) {
      this.#cache.delete(gitCommonDir);
      this.#cache.set(gitCommonDir, cached);
      return { ok: true, entries: cached.entries };
    }
    if (!fresh) {
      const pending = this.#inFlight.get(gitCommonDir);
      if (pending !== undefined) return pending;
    }
    const sequence = this.#advanceSequence(gitCommonDir);
    const pending = this.#deps.readSnapshot(anchorPath).then((result) => {
      if (result.ok && this.#requestSequence.get(gitCommonDir) === sequence) {
        this.#remember(gitCommonDir, result.entries);
      }
      return result;
    });
    if (fresh) return pending;
    this.#inFlight.set(gitCommonDir, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(gitCommonDir) === pending) this.#inFlight.delete(gitCommonDir);
    }
  }

  #remember(gitCommonDir: string, entries: readonly BridgeWorktreeEntry[]): void {
    this.#cache.delete(gitCommonDir);
    this.#cache.set(gitCommonDir, { loadedAt: this.#deps.now(), entries });
    while (this.#cache.size > SNAPSHOT_CACHE_CAP) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #advanceSequence(gitCommonDir: string): number {
    const next = (this.#requestSequence.get(gitCommonDir) ?? 0) + 1;
    this.#requestSequence.set(gitCommonDir, next);
    return next;
  }
}

function projectSnapshot(
  git: RecentGitInfo & {
    gitCommonDir: string;
    mainRoot: string;
    checkoutRoot: string;
    projectSubPath: string;
  },
  rawEntries: readonly BridgeWorktreeEntry[],
  deps: Pick<
    WorktreeInventoryServiceDeps,
    'availability' | 'canonicalize' | 'checkoutAvailability'
  >,
): WorktreeInventoryModel {
  const primaryCheckoutRoot = deps.canonicalize(rawEntries[0]?.path ?? git.mainRoot);
  const entries = rawEntries.map((raw): WorktreeInventoryEntry => {
    const checkoutRoot = deps.canonicalize(raw.path);
    const checkoutAvailability = deps.checkoutAvailability(checkoutRoot);
    const projected =
      git.projectSubPath.length === 0 ? checkoutRoot : join(checkoutRoot, git.projectSubPath);
    let availability = deps.availability(projected);
    const projectPath =
      availability === 'available' ? deps.canonicalize(projected) : resolve(projected);
    if (
      availability === 'available' &&
      !isPathWithinProject(projectPath, checkoutRoot, process.platform)
    ) {
      availability = 'unreadable';
    }
    const location =
      checkoutAvailability === 'available' || checkoutRoot === primaryCheckoutRoot
        ? classifyLocation(primaryCheckoutRoot, checkoutRoot)
        : 'unknown';
    return {
      checkoutRoot,
      projectPath,
      branch: raw.branch,
      headSha: raw.headSha,
      location,
      availability,
      locked: raw.locked,
      prunable: raw.prunable,
    };
  });
  return {
    gitCommonDir: git.gitCommonDir,
    primaryCheckoutRoot,
    projectSubPath: git.projectSubPath,
    entries,
  };
}

export function classifyLocation(
  primaryCheckoutRoot: string,
  checkoutRoot: string,
): WorktreeInventoryLocation {
  if (checkoutRoot === primaryCheckoutRoot) return 'primary';
  const internalRoot = join(primaryCheckoutRoot, WORKTREES_PARENT_DIR);
  return isPathWithinProject(checkoutRoot, internalRoot, process.platform) &&
    internalRoot !== checkoutRoot
    ? 'internal'
    : 'external';
}

function hasInventoryIdentity(git: RecentGitInfo): git is RecentGitInfo & {
  gitCommonDir: string;
  mainRoot: string;
  checkoutRoot: string;
  projectSubPath: string;
} {
  return (
    git.gitCommonDir !== null &&
    git.mainRoot !== null &&
    git.checkoutRoot !== null &&
    git.projectSubPath !== null
  );
}

function validOpenRequest(request: WorktreeInventoryOpenRequest): boolean {
  if (
    request.anchorProjectPath.includes('\0') ||
    request.gitCommonDir.includes('\0') ||
    request.projectSubPath.includes('\0') ||
    request.checkoutRoot.includes('\0') ||
    request.projectPath.includes('\0')
  ) {
    return false;
  }
  if (
    !isAbsolute(request.anchorProjectPath) ||
    !isAbsolute(request.gitCommonDir) ||
    !isAbsolute(request.checkoutRoot) ||
    !isAbsolute(request.projectPath) ||
    isAbsolute(request.projectSubPath)
  ) {
    return false;
  }
  const segments = request.projectSubPath.split(/[\\/]/);
  return !segments.some((segment) => segment === '..');
}

function defaultDeps(): WorktreeInventoryServiceDeps {
  return {
    classifyProject: classifyRecentGitAsync,
    readSnapshot: readGitWorktreeSnapshot,
    availability: filesystemAvailability,
    checkoutAvailability: filesystemDirectoryAvailability,
    canonicalize: canonicalPath,
    now: Date.now,
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function filesystemAvailability(path: string): WorktreeInventoryAvailability {
  try {
    if (!statSync(path).isDirectory()) return 'missing';
    return isProjectRoot(path) ? 'available' : 'missing';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

function filesystemDirectoryAvailability(path: string): WorktreeInventoryAvailability {
  try {
    return statSync(path).isDirectory() ? 'available' : 'missing';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}
