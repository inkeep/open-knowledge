import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EmptyRequestSchema,
  HistorySuccessSchema,
  HistoryVersionSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { getLogger, type PinoLogger } from '../logger.ts';
import {
  createAncestorShaSetCache,
  getOrLoadRenameLogIndex,
  resolveDocPathAtCommit,
} from '../rename-log.ts';
import { type ShadowRef, shadowGit } from '../shadow-repo.ts';
import { createSingleFlight } from '../single-flight.ts';
import { getDocumentHistory, getFolderTimeline } from '../timeline-query.ts';
import { recordTimelineCoalesced } from '../timeline-telemetry.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface HistoryRouteDeps {
  contentRoot: string | undefined;
  log: PinoLogger;
  shadowRef: ShadowRef | undefined;
  flushGitCommit: (() => Promise<void>) | undefined;
  commitOkArtifactWrite: (context: string) => Promise<void>;
  getCurrentBranch: (() => string | null) | undefined;
  validateFolderRel: (
    raw: string,
    res: ServerResponse,
    label?: 'path' | 'folder',
    handler?: string,
  ) => { folderRel: string; resolvedContentDir: string } | null;
  safeDocPath: (docName: string, contentRoot: string) => { path: string } | { error: string };
  docTreePathCandidates: (docName: string, contentRoot: string) => readonly string[];
}

export interface HistoryRoutes {
  paths: readonly string[];
  table: ApiRouteTable;
}

export function createHistoryRoutes(deps: HistoryRouteDeps): HistoryRoutes {
  const {
    contentRoot,
    log,
    shadowRef,
    flushGitCommit,
    commitOkArtifactWrite,
    getCurrentBranch,
    validateFolderRel,
    safeDocPath,
    docTreePathCandidates,
  } = deps;

  const historyInflight = createSingleFlight<Awaited<ReturnType<typeof getDocumentHistory>>>();

  const handleHistory = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const shadow = shadowRef?.current;
      if (!shadow) {
        errorResponse(
          res,
          503,
          'urn:ok:error:shadow-not-configured',
          'Shadow repo not configured.',
          { handler: 'history' },
        );
        return;
      }

      try {
        const flushStart = performance.now();
        await flushGitCommit?.();
        await commitOkArtifactWrite('history-read');
        const flushMs = performance.now() - flushStart;
        if (flushMs > 1000) {
          log.warn({ durationMs: Math.round(flushMs) }, '[history] pre-read commit flush slow');
        }
      } catch (err) {
        log.warn({ err }, '[history] pre-read commit flush failed');
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const docName = url.searchParams.get('docName') ?? '';
      const folderParam = url.searchParams.get('folder');
      const branch = url.searchParams.get('branch') ?? getCurrentBranch?.() ?? 'main';
      if (!docName && folderParam === null) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'A docName or folder query parameter is required.',
          { handler: 'history' },
        );
        return;
      }

      if (branch.includes('..') || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid branch name.', {
          handler: 'history',
        });
        return;
      }

      if (folderParam !== null && !docName) {
        const validated = validateFolderRel(folderParam, res, 'folder', 'history');
        if (!validated) return;
        const rawFolderLimit = Number(url.searchParams.get('limit') ?? '50');
        const folderLimit = Math.min(200, Number.isFinite(rawFolderLimit) ? rawFolderLimit : 50);
        const rawFolderOffset = Number(url.searchParams.get('offset') ?? '0');
        const folderOffset = Math.max(0, Number.isFinite(rawFolderOffset) ? rawFolderOffset : 0);
        const folderKey = `folder\0${branch}\0${validated.folderRel}\0${folderLimit}\0${folderOffset}`;
        const { promise, coalesced } = historyInflight.run(folderKey, () =>
          getFolderTimeline(shadow, validated.folderRel, contentRoot ?? '.', {
            branch,
            limit: folderLimit,
            offset: folderOffset,
          }),
        );
        if (coalesced) recordTimelineCoalesced('folder');
        const result = await promise;
        successResponse(res, 200, HistorySuccessSchema, { ...result }, { handler: 'history' });
        return;
      }

      const resolvedContentRoot = contentRoot ?? '.';
      const docPathResult = safeDocPath(docName, resolvedContentRoot);
      if ('error' in docPathResult) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', docPathResult.error, {
          handler: 'history',
        });
        return;
      }

      const rawLimit = Number(url.searchParams.get('limit') ?? '50');
      const rawOffset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50);
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const type = url.searchParams.get('type') ?? undefined;
      const author = url.searchParams.get('author') ?? undefined;
      const excludeAuthor = url.searchParams.get('excludeAuthor') ?? undefined;
      const includeAutoCheckpoints = url.searchParams.get('includeAutoCheckpoints') === 'true';

      const docKey = `doc\0${branch}\0${docName}\0${limit}\0${offset}\0${type ?? ''}\0${author ?? ''}\0${excludeAuthor ?? ''}\0${includeAutoCheckpoints ? '1' : '0'}`;

      const t0 = Date.now();
      try {
        const { promise, coalesced } = historyInflight.run(docKey, () =>
          getDocumentHistory(
            shadow,
            {
              docName,
              branch,
              limit,
              offset,
              type,
              author,
              excludeAuthor,
              includeAutoCheckpoints,
            },
            resolvedContentRoot,
          ),
        );
        if (coalesced) recordTimelineCoalesced('doc');
        const result = await promise;

        const duration = Date.now() - t0;
        getLogger('timeline').info(
          { docName, entries: result.entries.length, durationMs: duration },
          'query',
        );

        successResponse(res, 200, HistorySuccessSchema, { ...result }, { handler: 'history' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read history.', {
          handler: 'history',
          cause: e,
        });
      }
    },
    { handler: 'history', method: 'GET', skipBodyParse: true },
  );

  async function handleHistoryVersion(
    req: IncomingMessage,
    res: ServerResponse,
    sha: string,
  ): Promise<void> {
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'history-version',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }

    const shadow = shadowRef?.current;
    if (!shadow) {
      errorResponse(res, 503, 'urn:ok:error:shadow-not-configured', 'Shadow repo not configured.', {
        handler: 'history-version',
      });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const docName = url.searchParams.get('docName') ?? '';

    const resolvedContentRoot = contentRoot ?? '.';
    const pathResult = safeDocPath(docName, resolvedContentRoot);
    if ('error' in pathResult) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', pathResult.error, {
        handler: 'history-version',
      });
      return;
    }
    const sg = shadowGit(shadow);
    const branch = getCurrentBranch?.() ?? 'main';

    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid commit SHA.', {
        handler: 'history-version',
      });
      return;
    }

    try {
      const renameLogIndex = getOrLoadRenameLogIndex(shadow.gitDir);
      const ancestorCache = createAncestorShaSetCache();
      const historicalPath = await resolveDocPathAtCommit(
        shadow,
        docName,
        sha,
        branch,
        renameLogIndex,
        (name) => docTreePathCandidates(name, resolvedContentRoot),
        ancestorCache,
      );
      if (historicalPath === null) {
        errorResponse(
          res,
          404,
          'urn:ok:error:doc-not-found',
          'Document did not exist at this version.',
          { handler: 'history-version' },
        );
        return;
      }

      const content = await sg.raw('show', `${sha}:${historicalPath}`);

      const logLine = (await sg.raw('log', '-1', '--format=%aI%x00%an', sha)).trim();
      const [timestamp = '', author = ''] = logLine.split('\x00');

      successResponse(
        res,
        200,
        HistoryVersionSuccessSchema,
        { sha, content, timestamp, author },
        { handler: 'history-version' },
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'history-version',
        cause: e,
      });
    }
  }

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/history': handleHistory,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      if (url.startsWith('/api/history/')) {
        const encodedSha = url.slice('/api/history/'.length);
        return {
          template: '/api/history/:sha',
          dispatch: encodedSha
            ? async (req, res) => {
                await handleHistoryVersion(req, res, decodeURIComponent(encodedSha));
              }
            : undefined,
        };
      }
      return null;
    },
    isMutating: () => false,
  };

  return {
    paths: [...Object.keys(routes), '/api/history/*'],
    table,
  };
}
