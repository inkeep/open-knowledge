import type { BridgeWorktreeEntry } from './worktree-list-parser.ts';

export interface WorktreeSelectorEntry {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly isCurrent: boolean;
  readonly isMain: boolean;
  readonly locked: boolean;
  readonly behind?: number;
}

export interface WorktreeSelectorModel {
  readonly mainRoot: string;
  readonly currentBranch: string | null;
  readonly entries: readonly WorktreeSelectorEntry[];
  readonly remoteBranches: readonly string[];
}

export type WorktreeListResult =
  | { readonly ok: true; readonly model: WorktreeSelectorModel }
  | { readonly ok: false; readonly reason: 'no-git' };

export interface WorktreeCreateRequest {
  readonly branch: string;
  readonly baseBranch?: string | null;
  readonly baseRef?: string | null;
  readonly remoteRef?: string | null;
  readonly createBranch: boolean;
}

export type WorktreeCreateResult =
  | { readonly ok: true; readonly path: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason: 'helper-not-found';
      readonly helper: string;
      readonly message?: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'fetch-failed';
      readonly message?: string;
      readonly helper?: never;
      readonly authFailed?: true;
      readonly notFoundAsIdentity?: true;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-branch'
        | 'branch-exists'
        | 'already-checked-out'
        | 'path-exists'
        | 'no-git'
        | 'branch-not-found'
        | 'empty-repo'
        | 'error';
      readonly message?: string;
      readonly helper?: never;
    };

export interface BuildWorktreeSelectorModelInput {
  readonly worktrees: readonly BridgeWorktreeEntry[];
  readonly branches: readonly string[];
  readonly currentProjectPath: string;
  readonly remoteBranches?: readonly string[];
  readonly behind?: Readonly<Record<string, number>>;
}

export function buildWorktreeSelectorModel(
  input: BuildWorktreeSelectorModelInput,
): WorktreeSelectorModel {
  const liveWorktrees = input.worktrees.filter((w) => !w.prunable);
  const mainRoot = liveWorktrees[0]?.path ?? input.currentProjectPath;

  const behind = input.behind ?? {};
  const remoteBranches: string[] = [];
  const seenRemote = new Set<string>();
  for (const ref of input.remoteBranches ?? []) {
    if (ref.length === 0 || seenRemote.has(ref)) continue;
    seenRemote.add(ref);
    remoteBranches.push(ref);
  }

  const worktreeByBranch = new Map<string, BridgeWorktreeEntry>();
  for (const w of liveWorktrees) {
    if (w.branch !== null && !worktreeByBranch.has(w.branch)) {
      worktreeByBranch.set(w.branch, w);
    }
  }

  const isCurrentPath = (p: string): boolean => p === input.currentProjectPath;

  const entries: WorktreeSelectorEntry[] = [];

  for (const branch of input.branches) {
    const wt = worktreeByBranch.get(branch) ?? null;
    const behindCount = behind[branch];
    entries.push({
      branch,
      worktreePath: wt?.path ?? null,
      isCurrent: wt !== null && isCurrentPath(wt.path),
      isMain: wt !== null && wt.path === mainRoot,
      locked: wt?.locked ?? false,
      ...(behindCount !== undefined ? { behind: behindCount } : {}),
    });
  }

  const branchPaths = new Set(
    entries.map((e) => e.worktreePath).filter((p): p is string => p !== null),
  );
  for (const w of liveWorktrees) {
    if (w.branch === null && !branchPaths.has(w.path)) {
      entries.push({
        branch: null,
        worktreePath: w.path,
        isCurrent: isCurrentPath(w.path),
        isMain: w.path === mainRoot,
        locked: w.locked,
      });
    }
  }

  const currentBranch = entries.find((e) => e.isCurrent)?.branch ?? null;

  entries.sort(compareEntries);

  return { mainRoot, currentBranch, entries, remoteBranches };
}

export function stripRemotePrefix(ref: string): string {
  const slash = ref.indexOf('/');
  return slash === -1 ? ref : ref.slice(slash + 1);
}

function compareEntries(a: WorktreeSelectorEntry, b: WorktreeSelectorEntry): number {
  const rank = (e: WorktreeSelectorEntry): number => {
    if (e.isCurrent) return 0;
    if (e.isMain) return 1;
    if (e.worktreePath !== null) return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return (a.branch ?? '').localeCompare(b.branch ?? '');
}
