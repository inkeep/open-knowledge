/**
 * Main-process scaffolder for the share-receive consent flow.
 *
 * Why main (not HTTP):
 *   The consent dialog runs in the Navigator window before any project
 *   utility process exists for the candidate path. The Navigator's
 *   `OkDesktopConfig.apiOrigin === ''` — there is no server to POST to.
 *   `installClientFetchWrapper` performs no rewrite on empty apiOrigin, so a
 *   bare `fetch('/api/local-op/ok-init')` stays relative and resolves against
 *   the Navigator's own origin (file://), never reaching a server.
 *
 *   Spawning a utility process for the candidate just to call its
 *   ok-init endpoint would require the candidate to already be a valid
 *   OK project (folder-admission rejects bare git worktrees) — the
 *   chicken-and-egg the flow exists to break.
 *
 *   Conclusion: main runs `initContent` directly. The server-side
 *   `/api/local-op/ok-init` endpoint remains the source of truth for the
 *   Editor-App-window code path (where a server already exists and
 *   `installClientFetchWrapper` routes the fetch correctly); the main
 *   path here is the Navigator-window twin.
 *
 * Gates (in order, mirroring the server-side handler):
 *   1. Absolute-path discipline (`isAbsolute`) — refuse relative paths.
 *   2. `realpathSync` collapse — every comparison from here uses the
 *      canonical realpath so symlinked anchors collapse to the same
 *      identity that `listGitWorktrees` emits.
 *   3. `resolveGitDirDetailed` — refuse with `not-a-git-worktree` if `.git`
 *      is absent / inaccessible / malformed. Both `'directory'` (main
 *      checkout) and `'linked'` (worktree) are accepted.
 *   4. Idempotency: if `isProjectRoot(realpath)` already true, return
 *      `{ok: true}` without rewriting `config.yml`.
 *   5. Per-path async mutex — serialize against a user's own
 *      double-click. The `localOpGuard` semantics of the server-side
 *      handler don't extend across processes; this is the closest
 *      equivalent main can offer.
 *   6. `initContent` — `writeIfMissing` semantics never clobber an
 *      existing file. `assertNotSymlink` is the load-bearing guard.
 *
 * Returns the same `LocalOpOkInitResponse` shape the HTTP route returns
 * so renderer code can treat the two surfaces interchangeably. Never
 * throws — every failure mode maps to a discriminated result.
 */

import { realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { LocalOpOkInitResponse } from '@inkeep/open-knowledge-core';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { initContent, isProjectRoot } from '@inkeep/open-knowledge-server';

/**
 * Per-path mutex. The user can't realistically race a Navigator-window
 * consent dialog with anything else, but a double-click during the
 * `initializing` phase could otherwise queue a second `initContent`. The
 * Map key is the realpath-collapsed candidate path so symlinked
 * worktrees serialize on the same lock.
 *
 * Process-local only — main is the single source of truth for the
 * Navigator's consent flow. Server-side races are out of scope here
 * (the candidate has no `.ok/config.yml`, therefore no server is
 * running for it).
 */
const inFlight = new Map<string, Promise<LocalOpOkInitResponse>>();

/**
 * Run the scaffold for `projectPath`. The result shape mirrors the
 * HTTP route's `LocalOpOkInitResponseSchema` discriminated union exactly
 * so the consent dialog has one happy-path branch and one
 * failure-classification branch regardless of transport.
 */
export async function runOkInit(projectPath: string): Promise<LocalOpOkInitResponse> {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: 'projectPath must be a non-empty string.',
    };
  }

  if (!isAbsolute(projectPath)) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath must be an absolute path: ${projectPath}`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(projectPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath does not exist or is not accessible: ${(err as Error).message}`,
    };
  }

  const gitDirKind = resolveGitDirDetailed(canonicalPath).kind;
  if (gitDirKind !== 'directory' && gitDirKind !== 'linked') {
    console.warn(
      `[ok-init] action=init project=${basename(canonicalPath)} result=not-a-git-worktree kind=${gitDirKind}`,
    );
    return {
      ok: false,
      reason: 'not-a-git-worktree',
      message: `projectPath is not a git working tree (.git is ${gitDirKind}).`,
    };
  }

  if (isProjectRoot(canonicalPath)) {
    console.warn(
      `[ok-init] action=init project=${basename(canonicalPath)} result=already-initialized`,
    );
    return { ok: true, projectPath: canonicalPath };
  }

  const existing = inFlight.get(canonicalPath);
  if (existing) {
    // Coalesce concurrent callers onto the same scaffold. Their result is
    // identical (idempotent), and serializing prevents two parallel
    // tracedWriteFileSync calls on the same path.
    return existing;
  }

  const task = (async (): Promise<LocalOpOkInitResponse> => {
    try {
      initContent(canonicalPath);
      console.warn(`[ok-init] action=init project=${basename(canonicalPath)} result=success`);
      return { ok: true, projectPath: canonicalPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ok-init] action=init project=${basename(canonicalPath)} result=failed reason=${message}`,
      );
      return { ok: false, reason: 'init-failed', message };
    }
  })();

  inFlight.set(canonicalPath, task);
  try {
    return await task;
  } finally {
    inFlight.delete(canonicalPath);
  }
}
