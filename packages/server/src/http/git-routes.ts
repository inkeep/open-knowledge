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
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  getPrincipal: (() => Principal | null) | undefined;
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
    if (!existsSync(absPath)) return undefined;
    return { kind: 'asset', path: contentRelPath };
  }

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
