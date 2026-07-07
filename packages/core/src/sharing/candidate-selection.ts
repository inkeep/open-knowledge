/**
 * Multi-worktree candidate selection for the share-receive flow.
 *
 * Given a share's `{owner, repo, branch}` payload and a bridge surface, pick
 * the best project candidate by treating the share's branch as the primary
 * selection signal — across BOTH the Recents list AND the worktree
 * enumeration anchored at one of the matching Recents. Falls back to a main
 * checkout when no candidate's HEAD branch matches; falls back to any
 * worktree only when no main checkout is available; returns miss when no
 * usable candidate exists.
 *
 * Pure module — no IPC, no React, no I/O, no node:*. Lives in core so both
 * the renderer (the share-receive dialog) and main (Electron's url-scheme
 * router) can call it with the same algorithm. Bridge surface comes through
 * `CandidateBridgeDeps` so tests stub the IPC reads via pure DI.
 *
 * Selection rules:
 *  - Branch-match wins: the candidate whose `head.currentBranch ===
 *    payload.branch` wins regardless of recency or origin source.
 *  - Tiebreak when multiple candidates branch-match: prefer the one that
 *    appears earlier in Recents (most-recent-first); non-Recent worktrees
 *    use the deterministic `git worktree list` order.
 *  - Fallback when no candidate matches by branch: prefer a
 *    `gitDirKind: 'directory'` candidate (main checkout — safe to
 *    `git checkout`); only if none exists, fall back to a `gitDirKind:
 *    'linked'` worktree.
 *  - Locked worktrees included: the `locked` flag is recorded on
 *    Candidate but does NOT filter the candidate out.
 *  - Realpath identity: the union of Recents matches and worktree-
 *    enumeration results collapses by realpath identity. Bridge methods
 *    apply realpath upstream (listGitWorktrees returns realpath-collapsed
 *    paths; Recents paths are stored as the user opened them and may be
 *    pre-canonical).
 *  - Graceful degradation when every Recents match is missing on disk:
 *    the enumeration anchor is unavailable; return `{kind: 'miss'}`.
 *  - Observability: structured log on ambiguous-branch-match (more than
 *    one candidate with `head.currentBranch === payload.branch`).
 *  - HEAD reads are serial — file reads are sub-millisecond and typical
 *    receivers have <20 worktrees per repo.
 */

import type { BridgeWorktreeEntry } from '../git/worktree-list-parser.ts';
import {
  classifyBranchMatch,
  findRecentProjectsForRepo,
  type HeadBranchInfo,
  type RecentProjectEntry,
  type ResolvedGitDirKind,
} from './receive-flow.ts';

/**
 * Narrow bridge surface used by `selectCandidate`. Pure DI: tests pass a
 * stub that returns canned responses for each path. Production: the
 * renderer threads `window.okDesktop.project.*`; main threads the
 * equivalent main-side primitives wrapped to satisfy these Promise-returning
 * signatures.
 */
export interface CandidateBridgeDeps {
  readonly listRecent: () => Promise<readonly RecentProjectEntry[]>;
  readonly listGitWorktrees: (anchorPath: string) => Promise<readonly BridgeWorktreeEntry[]>;
  readonly readHeadBranch: (projectPath: string) => Promise<HeadBranchInfo>;
  readonly readGitDirKind: (projectPath: string) => Promise<ResolvedGitDirKind>;
  /**
   * Canonicalize a path via the OS `realpath`. Used to collapse Recents
   * paths (stored as the user opened them, possibly pre-canonical) onto the
   * same identity that `listGitWorktrees` already emits (realpath-collapsed
   * upstream), so the dedupe Map keys are consistent.
   */
  readonly realpath: (path: string) => Promise<string>;
  /**
   * Returns `true` iff `<projectPath>/.ok/config.yml` exists as a regular
   * file. Renderer derives this from
   * `bridge.fs.findEnclosingProjectRoot(path)` by checking
   * `result?.rootPath === path`; main uses the equivalent server-owned
   * project-root predicate. Passing it as a closure keeps the algorithm
   * decoupled from the bridge shape.
   */
  readonly isOkProjectRoot: (projectPath: string) => Promise<boolean>;
}

/**
 * The minimum slice of the share payload needed for selection — owner,
 * repo, and branch.
 */
export interface CandidateSelectionPayload {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/**
 * One inspected project candidate. Carries the IPC-read state (`head`,
 * `gitDirKind`, `hasOkConfig`) alongside provenance (`source`, `recent`,
 * `worktreeOrder`) so the tiebreak and fallback partitions stay
 * deterministic.
 */
export interface Candidate {
  /** Realpath identity (or best-effort raw path when realpath fails). */
  readonly path: string;
  /** Where this candidate was first seen. */
  readonly source: 'recent' | 'worktree-enum';
  /** The originating Recent entry when `source === 'recent'`, else null. */
  readonly recent: RecentProjectEntry | null;
  /** `.git/HEAD` read result. `{currentBranch:null, headSha:null, detached:false}` on graceful-fail. */
  readonly head: HeadBranchInfo;
  /** `<path>/.git` classification. `'absent'` covers absent, malformed, inaccessible. */
  readonly gitDirKind: ResolvedGitDirKind;
  /** True iff `<path>/.ok/config.yml` exists as a regular file. */
  readonly hasOkConfig: boolean;
  /** `git worktree list` `locked` flag (false for Recents-only candidates). */
  readonly locked: boolean;
  /**
   * Recents recency index (0 = most recently opened). `null` when the
   * candidate came from worktree-enum and isn't in Recents.
   */
  readonly recencyIndex: number | null;
  /**
   * `git worktree list` declaration order (0 = first emitted). `null` when
   * the candidate came from Recents and isn't in the worktree list.
   */
  readonly worktreeOrder: number | null;
}

/**
 * Selection outcome — the dispatch boundary discriminator the receive flow
 * acts on.
 *
 * - `'branch-match-ok'` — the chosen candidate's HEAD matches the share's
 *   branch AND `<path>/.ok/config.yml` exists; silent dispatch path.
 * - `'branch-match-non-ok'` — the chosen candidate's HEAD matches the
 *   share's branch but `<path>/.ok/config.yml` does NOT exist; routes to
 *   the one-shot consent dialog.
 * - `'fallback'` — no candidate's HEAD matches the share's branch; carry
 *   the anchor candidate (a main checkout if possible, else a linked
 *   worktree) and the reason discriminator for telemetry.
 * - `'miss'` — no Recents matches the repo, OR every match is missing on
 *   disk (graceful degradation), OR no candidate is usable.
 */
export type CandidateSelection =
  | {
      readonly kind: 'branch-match-ok';
      readonly candidate: Candidate;
      /**
       * `true` iff the candidate set evaluated by selection had more than
       * one entry. Used by the dispatched-window toast to suppress
       * disambiguation copy in the single-clone receiver case — one Recent
       * + zero linked worktrees → false → no toast; multiple Recents or
       * any linked worktrees → true → toast confirms which window the
       * share landed in.
       */
      readonly multiCandidate: boolean;
    }
  | {
      readonly kind: 'branch-match-non-ok';
      readonly candidate: Candidate;
      /**
       * Anchor Recents entry — the most-recent `findRecentProjectsForRepo`
       * match whose `path` rooted the `listGitWorktrees` enum that
       * surfaced this candidate. Used by the consent dialog as the
       * parent-project context line ("a worktree of <name>"). `null` when
       * the candidate was discovered without a Recents participant
       * (worktree-only path). Distinct from `candidate.recent`, which
       * refers to the candidate's OWN Recents entry (`null` if the
       * candidate is not itself in Recents).
       */
      readonly anchorRecent: RecentProjectEntry | null;
    }
  | {
      readonly kind: 'fallback';
      readonly anchor: Candidate;
      readonly reason: 'main-checkout' | 'only-worktrees';
    }
  | { readonly kind: 'miss' };

/**
 * Pick the best candidate for `payload` from Recents + worktree enumeration.
 * See module docstring for the selection rules.
 */
export async function selectCandidate(
  payload: CandidateSelectionPayload,
  bridge: CandidateBridgeDeps,
): Promise<CandidateSelection> {
  let recents: readonly RecentProjectEntry[];
  try {
    recents = await bridge.listRecent();
  } catch (err) {
    // Total degradation: can't even enumerate Recents, so there is no anchor
    // to drive selection. Log the decision point (paths/PII never emitted) so
    // a recurring listRecent failure is discoverable rather than a silent miss.
    // Carry the errno code — same diagnostic discipline as the safe* wrappers —
    // so EACCES is distinguishable from a parse/IPC failure during triage.
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

  // Graceful degradation when every Recents match is missing on disk:
  // `findRecentProjectsForRepo` already drops `missing:true` entries inline,
  // so any element of `recentMatches` is non-missing — the empty-anchor case
  // manifests as `recentMatches.length === 0` above. Keep this guard
  // nonetheless: if the inline filter is ever relaxed, this branch becomes
  // load-bearing.
  const anchor = recentMatches[0];
  if (!anchor) return { kind: 'miss' };

  let worktreeEnum: readonly BridgeWorktreeEntry[];
  try {
    worktreeEnum = await bridge.listGitWorktrees(anchor.path);
  } catch (err) {
    // Non-fatal: continue with the Recents-only candidate set. The graceful
    // failure surfaces at the bridge layer as `[]`, so this catch is a
    // defense-in-depth measure for unexpected throws. Log the errno class
    // (never the path) so a recurring failure is discoverable.
    console.warn('[receive] worktree_enum_failed; continuing recents-only', {
      code: (err as { code?: string }).code,
    });
    worktreeEnum = [];
  }

  const candidates = await buildCandidateSet(recentMatches, worktreeEnum, bridge);

  // Branch-match selection — strict equality first, with single-candidate
  // soft-match fallback for legacy URLs (no `?branch=`), unreadable HEADs,
  // and the all-null sentinel from a thrown `readHeadBranch`. With one
  // candidate the user has exactly one option so we cannot pick wrong;
  // with multiple candidates strict matching keeps the true match decisive.
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
      // Git's rules guarantee a branch is checked out in at most one worktree.
      // If this fires, something is off (race between read and dispatch,
      // fixture-induced state). User outcome is still correct (we picked
      // deterministically); the log makes the situation discoverable to triage.
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

  // No branch match — partition by gitDirKind, prefer main checkout.
  // Only OK-initialized candidates can take the branch-switch dispatch path.
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

/**
 * Union Recents matches with worktree enumeration results, collapse by
 * realpath identity, and inspect each candidate via the bridge. The
 * realpath collapse handles the macOS `/var` ↔ `/private/var` symlink so a
 * Recents entry at the user-opened path and a worktree-enum entry at the
 * realpath-collapsed path resolve to one Candidate instead of two.
 */
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
    // Skip prunable worktrees. A prunable entry whose path is still on disk
    // (stale gitdir pointer, dir not deleted) passes realpath and carries a
    // `branch` field that could strict-match the share branch — selecting it
    // would route dispatch into a worktree git considers dead, failing later.
    if (w.prunable) continue;
    if (seen.has(w.path)) {
      // Realpath collision with a Recents entry: prefer the Recents
      // candidate (it carries the recencyIndex used for tiebreak) but
      // adopt the `locked` flag from the worktree-enum row since Recents
      // doesn't surface it.
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

// The safe* wrappers degrade a per-candidate I/O failure to a sentinel rather
// than aborting the whole selection. Each logs the errno class (never the path
// — PII discipline, matching the listRecent catch) so a recurring failure that
// silently skews selection is discoverable.
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

/**
 * Deterministic tiebreak across candidates. Recents recency wins (lower
 * `recencyIndex` first); non-Recent worktrees tiebreak by their `git
 * worktree list` declaration order; a Recents candidate always wins over a
 * worktree-only candidate; ties at the same tier resolve by path lex so the
 * choice is stable across runs.
 */
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
