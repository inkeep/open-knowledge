/**
 * Main-side adapter that constructs a `CandidateBridgeDeps` from the existing
 * main-process git primitives (plus a caller-supplied recents lister) and runs
 * `selectCandidate` natively — no IPC round-trip, no renderer required.
 *
 * Same algorithm the renderer's `ShareReceiveDialog` runs (the algorithm
 * itself lives in `@inkeep/open-knowledge-core` so both sides share one
 * implementation). This module is the bridge wiring main needs so the share
 * target can be resolved BEFORE any window opens — eliminating the
 * "launcher flash" and replacing the focused-window dispatch in `routeShare`
 * with a routed-by-outcome decision.
 *
 * Two main-process primitives (`readHeadBranch`, `readGitDirKind`) are
 * synchronous; the bridge contract returns Promises. They're wrapped in
 * async closures rather than the synchronous-fast-path pattern so the bridge
 * surface stays uniform across all callers.
 *
 * The `isOkProjectRoot` predicate uses the same single-directory `.ok/config.yml`
 * regular-file check `findEnclosingProjectRoot` uses at each ancestor step
 * (it lives in `packages/server/src/fs/find-project-root.ts` and is already
 * consumed elsewhere in main). The renderer derives the same answer via the
 * existing `findEnclosingProjectRoot` IPC by checking `result.rootPath ===
 * path` — main goes direct to the primitive.
 *
 * Graceful failure parity: each bridge method is wrapped to never throw — the
 * shared selection algorithm already has its own try/catch around every
 * bridge call (`safeReadHead` etc.) but we keep the local catch because
 * `isProjectRoot` from server can throw on EACCES/EPERM/ELOOP and we'd
 * rather collapse those to `false` than let them surface as graceful-fail
 * sentinels far from the source.
 */

import { realpath as fsRealpath } from 'node:fs/promises';
import {
  type CandidateBridgeDeps,
  type CandidateSelection,
  type CandidateSelectionPayload,
  type RecentProjectEntry,
  selectCandidate,
} from '@inkeep/open-knowledge-core';
import { isProjectRoot } from '@inkeep/open-knowledge-server';
import { listGitWorktrees } from './list-git-worktrees.ts';
import { readGitDirKind } from './read-git-dir-kind.ts';
import { readHeadBranch } from './read-head-branch.ts';

export interface MainShareTargetDeps {
  /**
   * Returns the current recent-projects list. Main owns this via
   * `appState.recentProjects` (or the `annotateMissing` projection); the
   * adapter takes a closure so the caller controls whether `missing` is
   * pre-annotated. The shared selector inline-filters `missing:true` entries,
   * so passing the annotated projection is the production wiring.
   */
  readonly listRecent: () => readonly RecentProjectEntry[];
}

/**
 * Build the `CandidateBridgeDeps` the shared `selectCandidate` algorithm
 * expects, backed by real main-side git I/O. The returned object is stateless
 * — recreate it per share-resolution call (or reuse, no difference; nothing
 * caches between invocations).
 */
function createMainCandidateBridge(deps: MainShareTargetDeps): CandidateBridgeDeps {
  return {
    listRecent: async () => deps.listRecent(),
    listGitWorktrees: (anchorPath) => listGitWorktrees(anchorPath),
    readHeadBranch: async (projectPath) => readHeadBranch(projectPath),
    readGitDirKind: async (projectPath) => readGitDirKind(projectPath),
    realpath: (path) => fsRealpath(path),
    isOkProjectRoot: async (projectPath) => {
      try {
        return isProjectRoot(projectPath);
      } catch (err) {
        console.warn('[receive] is_ok_project_root_failed; treating as non-OK', {
          code: (err as { code?: string }).code,
        });
        return false;
      }
    },
  };
}

/**
 * Resolve where an incoming share should land. The result discriminator
 * carries the routing decision (`branch-match-ok` / `branch-match-non-ok` /
 * `fallback` / `miss`); callers route project-scoped vs launcher-scoped
 * outcomes from there.
 */
export async function resolveShareTarget(
  payload: CandidateSelectionPayload,
  deps: MainShareTargetDeps,
): Promise<CandidateSelection> {
  return selectCandidate(payload, createMainCandidateBridge(deps));
}
