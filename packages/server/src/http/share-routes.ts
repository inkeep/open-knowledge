import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EmptyRequestSchema,
  encodeShareUrl,
  InvalidShareUrlError,
  parseCanonicalGitHubShareUrl,
  ShareConstructUrlRequestSchema,
  ShareConstructUrlResponseSchema,
  SharePublishNameCheckResponseSchema,
  SharePublishOwnersResponseSchema,
  SharePublishRequestSchema,
  SharePublishResponseSchema,
  ShareTargetStatusRequestSchema,
  ShareTargetStatusResponseSchema,
} from '@inkeep/open-knowledge-core';
import {
  LOCAL_OP_PIPE_STDIO_OPTIONS,
  withHiddenWindowsConsole,
} from '../child-process-windows-hide.ts';
import { isValidBranchInfoPath } from '../git-branch-info.ts';
import { buildSyncCredentialConfig } from '../git-handle.ts';
import type { ConcurrencyGuard } from '../local-op-security.ts';
import type { PinoLogger } from '../logger.ts';
import {
  buildGitHubBlobUrl,
  buildGitHubTreeUrl,
  emitShareConstructUrlLog,
  isValidSharePath,
  SHARE_BASE_URL,
  SHARE_CONSTRUCT_URL_HANDLER_TAG,
} from '../share/construct-url.ts';
import { computeShareFreshness } from '../share/freshness.ts';
import {
  branchExistsOnOrigin,
  readGitHeadBranch,
  readOriginGitHubRepo,
  shouldResetAmbientCredentials,
} from '../share/git-context.ts';
import {
  emitSharePublishLog,
  isValidShareOwnerName,
  isValidShareRepoName,
  parseNameCheckEvent,
  parseOwnersEvent,
  parsePublishEvent,
  pickTerminalJsonLine,
  redactShareSubprocessStderr,
  SHARE_PUBLISH_HANDLER_TAG,
  SHARE_PUBLISH_KEY,
  SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
  SHARE_PUBLISH_NAME_CHECK_KEY,
  SHARE_PUBLISH_OWNERS_HANDLER_TAG,
  SHARE_PUBLISH_OWNERS_KEY,
  SHARE_PUBLISH_TIMEOUT_MS,
} from '../share/publish.ts';
import {
  computeShareTargetStatus,
  SHARE_TARGET_STATUS_HANDLER_TAG,
} from '../share/target-status.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { parseQuery } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface ShareRouteDeps {
  projectDir: string | undefined;
  contentDir: string;
  log: PinoLogger;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  localOpCliArgs: string[];
  localOpGuard: ConcurrencyGuard;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  toGitRelativePath: (projectDir: string, absolutePath: string) => string | null;
}

export function createShareRoutes(deps: ShareRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    contentDir,
    log,
    checkLocalOpSecurity,
    localOpCliArgs,
    localOpGuard,
    getSyncEngine,
    toGitRelativePath,
  } = deps;

  const handleShareConstructUrl = withValidation(
    ShareConstructUrlRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const sharePath = body.kind === 'doc' ? body.docPath : body.folderPath;
        if (!isValidSharePath(sharePath, body.kind)) {
          emitShareConstructUrlLog('invalid-path', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'invalid-path' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branch = readGitHeadBranch(projectDir);
        if (branch === null) {
          const originPeek = readOriginGitHubRepo(projectDir);
          if (originPeek.kind === 'no-remote') {
            emitShareConstructUrlLog('no-remote', { kind: body.kind });
            successResponse(
              res,
              200,
              ShareConstructUrlResponseSchema,
              { ok: false, error: 'no-remote' },
              { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
            );
            return;
          }
          emitShareConstructUrlLog('detached-head', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'detached-head' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const origin = readOriginGitHubRepo(projectDir);
        if (origin.kind === 'no-remote') {
          emitShareConstructUrlLog('no-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'no-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        if (origin.kind === 'non-github') {
          emitShareConstructUrlLog('non-github-remote', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'non-github-remote' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const branchExists = branchExistsOnOrigin(projectDir, branch);
        if (!branchExists) {
          emitShareConstructUrlLog('branch-not-on-origin', {
            branchExists: false,
            kind: body.kind,
          });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'branch-not-on-origin', branch },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const contentRel = toGitRelativePath(projectDir, contentDir);
        if (contentRel === null) {
          throw new Error('content dir is not contained within the project dir');
        }
        const repositorySharePath =
          contentRel === ''
            ? sharePath
            : sharePath === ''
              ? contentRel
              : `${contentRel}/${sharePath}`;
        let sharedUrl: string;
        if (body.kind === 'doc') {
          sharedUrl = buildGitHubBlobUrl(
            origin.host,
            origin.owner,
            origin.repo,
            branch,
            repositorySharePath,
          );
        } else {
          sharedUrl = buildGitHubTreeUrl(
            origin.host,
            origin.owner,
            origin.repo,
            branch,
            repositorySharePath,
          );
        }
        let shareUrl: string;
        try {
          const contentRootDepth =
            contentRel === ''
              ? 0
              : parseCanonicalGitHubShareUrl(
                  buildGitHubTreeUrl(origin.host, origin.owner, origin.repo, branch, contentRel),
                ).targetSegments.length;
          shareUrl = `${SHARE_BASE_URL}${encodeShareUrl(sharedUrl, contentRootDepth)}`;
        } catch (err) {
          if (!(err instanceof InvalidShareUrlError)) throw err;
          emitShareConstructUrlLog('unsupported-share-url', { kind: body.kind });
          successResponse(
            res,
            200,
            ShareConstructUrlResponseSchema,
            { ok: false, error: 'unsupported-share-url' },
            { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
          );
          return;
        }
        const freshness = await computeShareFreshness(
          projectDir,
          branch,
          repositorySharePath,
          body.kind,
        );
        emitShareConstructUrlLog('ok', { branchExists: true, kind: body.kind, freshness });
        successResponse(
          res,
          200,
          ShareConstructUrlResponseSchema,
          { ok: true, shareUrl, sharedUrl, branch, freshness },
          { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_CONSTRUCT_URL_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_CONSTRUCT_URL_HANDLER_TAG }),
    },
  );

  function projectRenamedShareTarget(
    repositoryPath: string,
    renamedRepositoryPath: string,
    contentRootDepth: number,
  ): { verdict: 'renamed'; renamedTo: string } | { verdict: 'unknown' } {
    const originalSegments = repositoryPath.split('/');
    const renamedSegments = renamedRepositoryPath.split('/');
    if (contentRootDepth >= originalSegments.length || contentRootDepth >= renamedSegments.length) {
      return { verdict: 'unknown' };
    }
    for (let index = 0; index < contentRootDepth; index += 1) {
      if (originalSegments[index] !== renamedSegments[index]) return { verdict: 'unknown' };
    }
    return { verdict: 'renamed', renamedTo: renamedSegments.slice(contentRootDepth).join('/') };
  }

  const handleShareTargetStatus = withValidation(
    ShareTargetStatusRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'projectDir is not configured for this server.',
            { handler: SHARE_TARGET_STATUS_HANDLER_TAG },
          );
          return;
        }
        // precedent #55 content-scope predicate symmetry. Kind-aware: an empty
        if (!isValidBranchInfoPath(body.path, body.kind)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'path is missing or malformed.', {
            handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          });
          return;
        }
        const status = await computeShareTargetStatus(
          projectDir,
          body.branch,
          body.path,
          body.kind,
          {
            credentialConfig: buildSyncCredentialConfig(localOpCliArgs, {
              resetAmbient: shouldResetAmbientCredentials(projectDir),
            }),
          },
        );
        const contentStatus =
          status.verdict !== 'renamed' || body.contentRootDepth === undefined
            ? status
            : projectRenamedShareTarget(body.path, status.renamedTo, body.contentRootDepth);
        successResponse(res, 200, ShareTargetStatusResponseSchema, contentStatus, {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_TARGET_STATUS_HANDLER_TAG,
          cause: err,
        });
      }
    },
    {
      handler: SHARE_TARGET_STATUS_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_TARGET_STATUS_HANDLER_TAG }),
    },
  );

  async function spawnShareSubprocess(
    args: readonly string[],
  ): Promise<{ stdout: string; code: number | null }> {
    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, ...args];
    return await new Promise<{ stdout: string; code: number | null }>((resolveSpawn, reject) => {
      const child = spawn(
        cmd,
        spawnArgs,
        withHiddenWindowsConsole({
          ...LOCAL_OP_PIPE_STDIO_OPTIONS,
          env: { ...process.env },
        }),
      );
      let settled = false;
      const killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`share subprocess timed out after ${SHARE_PUBLISH_TIMEOUT_MS}ms`));
      }, SHARE_PUBLISH_TIMEOUT_MS);
      killTimer.unref?.();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          const redacted = redactShareSubprocessStderr(stderr).slice(0, 500);
          log.warn(
            { code, stderr: redacted },
            `[share] subprocess exited code=${code} stderr=${redacted}`,
          );
        }
        resolveSpawn({ stdout, code });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  const handleSharePublishOwners = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_OWNERS_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share owners operation is already in progress.',
          { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess(['share', 'owners', '--json']);
        const event = pickTerminalJsonLine(stdout);
        const body = parseOwnersEvent(event);
        emitSharePublishLog(
          'owners-list',
          body.ok ? 'ok' : body.error,
          body.ok ? { count: body.owners.length } : undefined,
        );
        successResponse(res, 200, SharePublishOwnersResponseSchema, body, {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_OWNERS_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_OWNERS_HANDLER_TAG }),
    },
  );

  const handleSharePublishNameCheck = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const params = parseQuery(req);
      const owner = params.get('owner') ?? '';
      const name = params.get('name') ?? '';
      if (!isValidShareOwnerName(owner) || !isValidShareRepoName(name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name query params must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_NAME_CHECK_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share name-check operation is already in progress.',
          { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { stdout } = await spawnShareSubprocess([
          'share',
          'name-check',
          '--owner',
          owner,
          '--name',
          name,
          '--json',
        ]);
        const event = pickTerminalJsonLine(stdout);
        const body = parseNameCheckEvent(event);
        emitSharePublishLog(
          'name-check',
          body.ok ? 'ok' : body.error,
          body.ok ? { available: body.available } : undefined,
        );
        successResponse(res, 200, SharePublishNameCheckResponseSchema, body, {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_NAME_CHECK_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG,
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG }),
    },
  );

  const handleSharePublish = withValidation(
    SharePublishRequestSchema,
    async (_req, res, body) => {
      if (!projectDir) {
        emitSharePublishLog('publish-create', 'no-project');
        successResponse(
          res,
          200,
          SharePublishResponseSchema,
          { ok: false, error: 'no-project' },
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!isValidShareOwnerName(body.owner) || !isValidShareRepoName(body.name)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'owner and name must be valid GitHub identifiers.',
          { handler: SHARE_PUBLISH_HANDLER_TAG },
        );
        return;
      }
      if (!localOpGuard.tryAcquire(SHARE_PUBLISH_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A share publish operation is already in progress.',
          { handler: SHARE_PUBLISH_HANDLER_TAG, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const args = [
          'share',
          'publish',
          '--owner',
          body.owner,
          '--name',
          body.name,
          '--visibility',
          body.visibility,
          '--project-dir',
          projectDir,
          '--json',
        ];
        if (body.description !== undefined && body.description.length > 0) {
          args.push('--description', body.description);
        }
        const { stdout } = await spawnShareSubprocess(args);
        const event = pickTerminalJsonLine(stdout);
        const responseBody = parsePublishEvent(event);
        emitSharePublishLog('publish-create', responseBody.ok ? 'ok' : responseBody.error);
        if (responseBody.ok) {
          void getSyncEngine?.()
            ?.refreshRemote()
            .catch((err) => {
              log.warn({ err }, '[share] post-publish refreshRemote failed');
            });
        }
        successResponse(res, 200, SharePublishResponseSchema, responseBody, {
          handler: SHARE_PUBLISH_HANDLER_TAG,
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: SHARE_PUBLISH_HANDLER_TAG,
          cause: err,
        });
      } finally {
        localOpGuard.release(SHARE_PUBLISH_KEY);
      }
    },
    {
      handler: SHARE_PUBLISH_HANDLER_TAG,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: SHARE_PUBLISH_HANDLER_TAG }),
    },
  );

  const routes = {
    '/api/share/construct-url': handleShareConstructUrl,
    '/api/share/target-status': handleShareTargetStatus,
    '/api/share/publish/owners': handleSharePublishOwners,
    '/api/share/publish/name-check': handleSharePublishNameCheck,
    '/api/share/publish': handleSharePublish,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes);
}
