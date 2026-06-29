
import type { BridgeWorktreeEntry } from '../git/worktree-list-parser.ts';
import {
  classifyBranchMatch,
  findRecentProjectsForRepo,
  type HeadBranchInfo,
  type RecentProjectEntry,
  type ResolvedGitDirKind,
} from './receive-flow.ts';

export interface CandidateBridgeDeps {
  readonly listRecent: () => Promise<readonly RecentProjectEntry[]>;
  readonly listGitWorktrees: (anchorPath: string) => Promise<readonly BridgeWorktreeEntry[]>;
  readonly readHeadBranch: (projectPath: string) => Promise<HeadBranchInfo>;
  readonly readGitDirKind: (projectPath: string) => Promise<ResolvedGitDirKind>;
  readonly realpath: (path: string) => Promise<string>;
  readonly isOkProjectRoot: (projectPath: string) => Promise<boolean>;
}

export interface CandidateSelectionPayload {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

export interface Candidate {
  readonly path: string;
  readonly source: 'recent' | 'worktree-enum';
  readonly recent: RecentProjectEntry | null;
  readonly head: HeadBranchInfo;
  readonly gitDirKind: ResolvedGitDirKind;
  readonly hasOkConfig: boolean;
  readonly locked: boolean;
  readonly recencyIndex: number | null;
  readonly worktreeOrder: number | null;
}

export type CandidateSelection =
  | {
      readonly kind: 'branch-match-ok';
      readonly candidate: Candidate;
      readonly multiCandidate: boolean;
    }
  | {
      readonly kind: 'branch-match-non-ok';
      readonly candidate: Candidate;
      readonly anchorRecent: RecentProjectEntry | null;
    }
  | {
      readonly kind: 'fallback';
      readonly anchor: Candidate;
      readonly reason: 'main-checkout' | 'only-worktrees';
    }
  | { readonly kind: 'miss' };

export async function selectCandidate(
  payload: CandidateSelectionPayload,
  bridge: CandidateBridgeDeps,
): Promise<CandidateSelection> {
  let recents: readonly RecentProjectEntry[];
  try {
    recents = await bridge.listRecent();
  } catch (err) {
    console.warn('[receive] selection=miss reason=list_recent_failed', {
      code: (err as { code?: string }).code,
    });
    return { kind: 'miss' };
  }

  const recentMatches = findRecentProjectsForRepo(recents, {
    owner: payload.owner,
    repo: payload.repo,
  });
  if (recentMatches.length === 0) return { kind: 'miss' };

  const anchor = recentMatches[0];
  if (!anchor) return { kind: 'miss' };

  let worktreeEnum: readonly BridgeWorktreeEntry[];
  try {
    worktreeEnum = await bridge.listGitWorktrees(anchor.path);
  } catch (err) {
    console.warn('[receive] worktree_enum_failed; continuing recents-only', {
      code: (err as { code?: string }).code,
    });
    worktreeEnum = [];
  }

  const candidates = await buildCandidateSet(recentMatches, worktreeEnum, bridge);

  const strictMatches = candidates.filter(
    (c) => c.head.currentBranch !== null && c.head.currentBranch === payload.branch,
  );
  const branchMatches =
    strictMatches.length > 0
      ? strictMatches
      : candidates.length === 1
        ? candidates.filter((c) => classifyBranchMatch(payload.branch, c.head) === 'true')
        : [];
  if (branchMatches.length > 0) {
    const chosen = pickByRecency(branchMatches);
    if (branchMatches.length > 1) {
      const candidatesList = branchMatches.map((c) => c.path).join('|');
      console.warn(
        `[receive] q1_ambiguous_branch_match=true candidates=${candidatesList} chosen=${chosen.path}`,
      );
    }
    console.warn(
      `[receive] selection=branch_match worktrees_enumerated=${worktreeEnum.length} recents_matching=${recentMatches.length} chosen_source=${chosen.source}`,
    );
    const multiCandidate = candidates.length > 1;
    return chosen.hasOkConfig
      ? { kind: 'branch-match-ok', candidate: chosen, multiCandidate }
      : { kind: 'branch-match-non-ok', candidate: chosen, anchorRecent: anchor };
  }

  const mains = candidates.filter((c) => c.gitDirKind === 'directory' && c.hasOkConfig);
  if (mains.length > 0) {
    return { kind: 'fallback', anchor: pickByRecency(mains), reason: 'main-checkout' };
  }
  const linkedOk = candidates.filter((c) => c.gitDirKind === 'linked' && c.hasOkConfig);
  if (linkedOk.length > 0) {
    return { kind: 'fallback', anchor: pickByRecency(linkedOk), reason: 'only-worktrees' };
  }
  return { kind: 'miss' };
}

async function buildCandidateSet(
  recentMatches: readonly RecentProjectEntry[],
  worktreeEnum: readonly BridgeWorktreeEntry[],
  bridge: CandidateBridgeDeps,
): Promise<readonly Candidate[]> {
  const seen = new Map<string, Candidate>();

  for (let i = 0; i < recentMatches.length; i++) {
    const r = recentMatches[i];
    if (!r) continue;
    const canonicalPath = await safeRealpath(bridge, r.path);
    const candidate = await inspectCandidate({
      path: canonicalPath,
      source: 'recent',
      recent: r,
      locked: false,
      recencyIndex: i,
      worktreeOrder: null,
      bridge,
    });
    seen.set(candidate.path, candidate);
  }

  for (let i = 0; i < worktreeEnum.length; i++) {
    const w = worktreeEnum[i];
    if (!w) continue;
    if (w.prunable) continue;
    if (seen.has(w.path)) {
      const existing = seen.get(w.path);
      if (existing && w.locked) {
        seen.set(w.path, { ...existing, locked: true });
      }
      continue;
    }
    const candidate = await inspectCandidate({
      path: w.path,
      source: 'worktree-enum',
      recent: null,
      locked: w.locked,
      recencyIndex: null,
      worktreeOrder: i,
      bridge,
      prepopulatedHead: bridgeWorktreeToHead(w),
    });
    seen.set(candidate.path, candidate);
  }

  return Array.from(seen.values());
}

interface InspectCandidateArgs {
  readonly path: string;
  readonly source: Candidate['source'];
  readonly recent: RecentProjectEntry | null;
  readonly locked: boolean;
  readonly recencyIndex: number | null;
  readonly worktreeOrder: number | null;
  readonly bridge: CandidateBridgeDeps;
  readonly prepopulatedHead?: HeadBranchInfo;
}

async function inspectCandidate(args: InspectCandidateArgs): Promise<Candidate> {
  const head = args.prepopulatedHead ?? (await safeReadHead(args.bridge, args.path));
  const gitDirKind = await safeReadGitDirKind(args.bridge, args.path);
  const hasOkConfig = await safeIsOkProjectRoot(args.bridge, args.path);
  return {
    path: args.path,
    source: args.source,
    recent: args.recent,
    head,
    gitDirKind,
    hasOkConfig,
    locked: args.locked,
    recencyIndex: args.recencyIndex,
    worktreeOrder: args.worktreeOrder,
  };
}

const HEAD_FAILURE_SENTINEL: HeadBranchInfo = {
  currentBranch: null,
  headSha: null,
  detached: false,
};

async function safeRealpath(bridge: CandidateBridgeDeps, path: string): Promise<string> {
  try {
    return await bridge.realpath(path);
  } catch (err) {
    console.warn('[receive] realpath_failed; using raw path', {
      code: (err as { code?: string }).code,
    });
    return path;
  }
}

async function safeReadHead(bridge: CandidateBridgeDeps, path: string): Promise<HeadBranchInfo> {
  try {
    return await bridge.readHeadBranch(path);
  } catch (err) {
    console.warn('[receive] read_head_failed; using head-unknown sentinel', {
      code: (err as { code?: string }).code,
    });
    return HEAD_FAILURE_SENTINEL;
  }
}

async function safeReadGitDirKind(
  bridge: CandidateBridgeDeps,
  path: string,
): Promise<ResolvedGitDirKind> {
  try {
    return await bridge.readGitDirKind(path);
  } catch (err) {
    console.warn('[receive] read_gitdir_kind_failed; treating as absent', {
      code: (err as { code?: string }).code,
    });
    return 'absent';
  }
}

async function safeIsOkProjectRoot(bridge: CandidateBridgeDeps, path: string): Promise<boolean> {
  try {
    return await bridge.isOkProjectRoot(path);
  } catch (err) {
    console.warn('[receive] is_ok_project_root_failed; treating as non-OK', {
      code: (err as { code?: string }).code,
    });
    return false;
  }
}

function bridgeWorktreeToHead(w: BridgeWorktreeEntry): HeadBranchInfo {
  return {
    currentBranch: w.branch,
    headSha: w.headSha,
    detached: w.branch === null && w.headSha !== null,
  };
}

function pickByRecency(candidates: readonly Candidate[]): Candidate {
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) return only;
  }

  let best = candidates[0];
  if (!best) {
    throw new Error('pickByRecency invariant violated: empty candidate list');
  }
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    if (compareCandidatesForTiebreak(c, best) < 0) best = c;
  }
  return best;
}

function compareCandidatesForTiebreak(a: Candidate, b: Candidate): number {
  if (a.recencyIndex !== null && b.recencyIndex === null) return -1;
  if (a.recencyIndex === null && b.recencyIndex !== null) return 1;
  if (a.recencyIndex !== null && b.recencyIndex !== null) {
    if (a.recencyIndex !== b.recencyIndex) return a.recencyIndex - b.recencyIndex;
  } else {
    const ao = a.worktreeOrder ?? Number.POSITIVE_INFINITY;
    const bo = b.worktreeOrder ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
