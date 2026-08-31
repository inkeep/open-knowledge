/**
 * The git family — `git/branch-info` and `git/worktree-status` (reads) plus
 * `git/checkout` (mutating) — natively routed as one group. Handler bodies
 * move byte-identically from the legacy dispatch; what they closed over in
 * the extension arrives as {@link GitRouteDeps}. `toOpenTarget` moves with
 * its sole consumer, the worktree-status handler.
 *
 * `git/checkout` keeps its legacy `MUTATING_ROUTES` membership, declared on
 * the table and pinned in the co-located table-tier test; the two reads stay
 * on the read posture.
 */

import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import {
  BranchInfoResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  EmptyRequestSchema,
  type GitWorktreeOpenTarget,
  GitWorktreeStatusSuccessSchema,
  type Principal,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from '../content-filter.ts';
import { stripDocExtension } from '../doc-extensions.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import type { FileIndexEntry } from '../file-watcher.ts';
import {
  BRANCH_INFO_HANDLER_TAG,
  computeBranchInfo,
  isValidBranchInfoPath,
  isValidBranchName,
} from '../git-branch-info.ts';
import { CHECKOUT_HANDLER_TAG, runCheckoutFlow } from '../git-checkout.ts';
import { buildSyncCredentialConfig, withParentLock } from '../git-handle.ts';
import { readWorktreeStatus } from '../git-worktree-status.ts';
import { toPosix } from '../path-utils.ts';
import { shouldResetAmbientCredentials } from '../share/git-context.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { parseQuery } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface GitRouteDeps {
  projectDir: string | undefined;
  contentDir: string;
  contentFilter: ContentFilter | undefined;
  /** The extension's live doc-name index accessor. */
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  getPrincipal: (() => Principal | null) | undefined;
  /** The resolved CLI argv checkout's credential config is built from. */
  localOpCliArgs: string[];
}

export function createGitRoutes(deps: GitRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    contentDir,
    contentFilter,
    getFileIndex,
    checkLocalOpSecurity,
    getSyncEngine,
    getPrincipal,
    localOpCliArgs,
  } = deps;

  /**
   * Where a project-relative working-tree path opens, or undefined when it
   * opens nowhere. Resolves to the same two routes the Files sidebar uses, so
   * a row in the sync popover behaves like the same file in the tree.
   *
   * Order is the whole design. File-index membership decides `doc` — the index
   * holds exactly what the editor owns, so a gitignored `.md` falls through to
   * the asset viewer rather than opening an editable surface it is not indexed
   * for. Everything else that survives the filter's FLOORS is an `asset`: the
   * text-view endpoint has no extension gate, so `.gitignore`, `opencode.json`
   * and `.ok/config.yml` all render, and the viewer's own fallback pane covers
   * whatever it cannot draw. `bypassFilters` + `showOk` reduce the filter to
   * exactly those floors — secret-bearing files, `.git`, `node_modules`,
   * `.ok/local`, reserved synthetic names — which is the same set the sidebar
   * refuses to show under Show All Files. Without a content filter there is no
   * floor to enforce, so nothing is offered.
   */
  function toOpenTarget(projectRelPath: string): GitWorktreeOpenTarget | undefined {
    const absPath = join(projectDir ?? contentDir, projectRelPath);
    const contentRelPath = toPosix(relative(contentDir, absPath));
    if (!contentRelPath || contentRelPath.startsWith('..')) return undefined;
    const docName = stripDocExtension(contentRelPath);
    if (getFileIndex().has(docName)) return { kind: 'doc', docName };
    if (!contentFilter) return undefined;
    if (contentFilter.isExcluded(contentRelPath, { bypassFilters: true, showOk: true })) {
      return undefined;
    }
    // A deletion, or an incoming file that has not landed yet: the viewer would
    // open on nothing. Docs skip this check — index membership implies the file.
    if (!existsSync(absPath)) return undefined;
    return { kind: 'asset', path: contentRelPath };
  }

  /**
   * `GET /api/git/worktree-status` — the `git status` view the sync popover
   * renders under its action buttons.
   *
   * Kept off the `sync-status` payload deliberately: that one is pushed over
   * CC1 on every engine transition, and a working-tree listing does not belong
   * on a hot broadcast channel. This is polled by the popover while it is open.
   */
  async function handleGitWorktreeStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'git-worktree-status' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'git-worktree-status',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      // Without an engine there is no admission predicate to mark scope with.
      // Report every path as out-of-scope rather than guessing in-scope: an
      // unmarked path the user then watches Push ignore is the worse failure.
      const isSyncScoped = engine
        ? (relPath: string) => engine.isSyncScopedPath(relPath)
        : () => false;
      const status = await readWorktreeStatus(projectDir ?? contentDir, isSyncScoped, toOpenTarget);
      successResponse(res, 200, GitWorktreeStatusSuccessSchema, status, {
        handler: 'git-worktree-status',
      });
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'git-worktree-status',
        cause: e,
      });
    }
  }

  /**
   * `GET /api/git/branch-info?branch=<targetBranch>&path=<path>` — batched
   * view of git state for the share-receive branch-switch dialog:
   *   - `currentBranch` / `currentHeadSha` / `detached` — HEAD identity
   *   - `shareTargetExists` — `git cat-file -e <ref>:<path>` against the
   *     current ref (HEAD when detached)
   *   - `dirtyConflicts` — `dirtyFilesOverlapWith(projectDir, targetBranch)`
   *   - `branchIsLocal` — `git rev-parse --verify refs/heads/<targetBranch>`
   *
   * All four probes run in parallel via `Promise.all` to stay under the
   * P99 < 500ms NFR. Read-only — does NOT acquire `withParentLock` so
   * concurrent sync-engine writes don't serialize behind the dialog
   * probe.
   */
  const handleBranchInfo = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'projectDir is not configured for this server.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        const params = parseQuery(req);
        const branch = params.get('branch');
        const path = params.get('path');
        // `kind` defaults to 'doc' when absent — keeps the existing
        // branch-info callers (which omit it) green until later stories
        // thread it through the share-receive dialog.
        const kindParam = params.get('kind');
        const kind: 'doc' | 'folder' = kindParam === 'folder' ? 'folder' : 'doc';
        if (!isValidBranchName(branch)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'branch query param missing or malformed.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        if (!isValidBranchInfoPath(path, kind)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path query param missing or malformed.',
            { handler: BRANCH_INFO_HANDLER_TAG },
          );
          return;
        }
        // The desktop sends the URL-derived repository coordinate explicitly.
        // V1 has no mount metadata and must never be re-rooted from receiver
        // config; v2 already projected its separate content target at decode.
        const info = await computeBranchInfo(projectDir, branch, path, kind);
        successResponse(res, 200, BranchInfoResponseSchema, info, {
          handler: BRANCH_INFO_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: BRANCH_INFO_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: BRANCH_INFO_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
    },
  );

  /**
   * `POST /api/git/checkout` — share-receive branch-switch executor.
   *
   * Wrapped in `withParentLock` so checkout serializes against the
   * sync-engine's parent-git writes (precedent: every other parent-git
   * write goes through this primitive). The branch-info endpoint is
   * read-only and lock-free; checkout is the matching writer.
   *
   * Identity is threaded through `extractActorIdentity` for observability
   * only — checkout is a git-level operation with no CRDT mutation. The
   * attribution-sweep meta-test exempts this handler explicitly.
   *
   * HEAD watcher is NOT coupled to this endpoint. The 200 response means
   * `git checkout` completed; the CRDT transition (Y.Docs reset + CC1
   * `branch-switched` broadcast) runs independently when the HEAD
   * watcher's `onBatchBegin`/`onBatchEnd` cycle fires.
   */
  const handleCheckout = withValidation(
    CheckoutRequestSchema,
    async (_req, res, body) => {
      const bodyObj = body as unknown as Record<string, unknown>;
      const actor = extractActorIdentity(bodyObj, getPrincipal);
      if (actor.kind === 'invalid-summary') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
          handler: CHECKOUT_HANDLER_TAG,
        });
        return;
      }

      if (!projectDir) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'projectDir is not configured for this server.',
          { handler: CHECKOUT_HANDLER_TAG },
        );
        return;
      }

      try {
        const outcome = await withParentLock(() =>
          runCheckoutFlow(projectDir, body.branch, {
            fastForward: body.fastForward === true,
            credentialConfig: buildSyncCredentialConfig(localOpCliArgs, {
              resetAmbient: shouldResetAmbientCredentials(projectDir),
            }),
          }),
        );
        successResponse(res, 200, CheckoutResponseSchema, outcome, {
          handler: CHECKOUT_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: CHECKOUT_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: CHECKOUT_HANDLER_TAG,
      method: 'POST',
    },
  );

  const routes = {
    '/api/git/branch-info': handleBranchInfo,
    '/api/git/worktree-status': handleGitWorktreeStatus,
    '/api/git/checkout': handleCheckout,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, {
    mutating: ['/api/git/checkout'],
  });
}
