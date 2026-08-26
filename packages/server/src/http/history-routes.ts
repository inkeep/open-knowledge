/**
 * The version-history read family — `history` plus the dynamic
 * `history/:sha` prefix — the sixth natively-routed Wave 2 group and the
 * SECOND to carry a DYNAMIC legacy prefix (`link-graph-routes.ts`'s
 * `/api/tags/:name` was the first). Same lift shape as the earlier groups:
 * what the handlers closed over in the extension arrives as
 * {@link HistoryRouteDeps}, the handler bodies are unchanged, and the extension
 * composes this group's table into its `nativeApi` handle while the legacy
 * dispatch record (and its `/api/history/` resolve fall-through) lose the paths
 * in the same change.
 *
 * The dynamic `/api/history/:sha` leg follows the `/api/tags/:name` precedent
 * in `link-graph-routes.ts`: a Hono `/api/history/*` wildcard preserves the
 * legacy URL template and its edge-case statuses. The two diverge on malformed
 * input by design — `tags` returns a typed 400, while here the table's
 * `resolve` decodes the sha inside `dispatch` so a malformed encoding surfaces
 * as the dispatch span's generic 500 (the legacy behavior), because byte parity
 * with the lifted handler outranks modernization for the lift. `/api/rollback`
 * mutates and stays on the legacy MUTATING_ROUTES gate.
 */

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
  /** Drains OK-artifact (contributor) stragglers before a history read. */
  commitOkArtifactWrite: (context: string) => Promise<void>;
  getCurrentBranch: (() => string | null) | undefined;
  /** The extension's folder-path validator, shared with folder-config/template. */
  validateFolderRel: (
    raw: string,
    res: ServerResponse,
    label?: 'path' | 'folder',
    handler?: string,
  ) => { folderRel: string; resolvedContentDir: string } | null;
  /** Traversal-safe docName → git pathspec guard (shared module helper). */
  safeDocPath: (docName: string, contentRoot: string) => { path: string } | { error: string };
  /** Historical tree-path candidates for a docName (shared module helper). */
  docTreePathCandidates: (docName: string, contentRoot: string) => readonly string[];
}

export interface HistoryRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
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

  // Single-flight dedupe for `GET /api/history`. Keyed by the
  // full normalized query tuple (mode + branch + every param each mode reads),
  // so N concurrent identical history requests share ONE git walk and N
  // identical responses. Per-server-instance, same rationale as showAllInflight.
  const historyInflight = createSingleFlight<Awaited<ReturnType<typeof getDocumentHistory>>>();

  const handleHistory = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const shadow = shadowRef?.current;
      if (!shadow) {
        // 503 (not 400): shadow-repo unavailability is a server-side state,
        // matching the sync-not-active precedent.
        errorResponse(
          res,
          503,
          'urn:ok:error:shadow-not-configured',
          'Shadow repo not configured.',
          { handler: 'history' },
        );
        return;
      }

      // Read-your-writes: agent write handlers no longer force an L2 shadow
      // commit per write (they ride the persistence debounce), so drain any
      // pending commit before querying — a `history` call issued right after a
      // write must list that write. No-op when nothing is pending. The flush
      // blocks the response, so surface slow (cold-index) drains in the logs.
      try {
        const flushStart = performance.now();
        await flushGitCommit?.();
        // Contributor stragglers too: lifecycle writes flush fire-and-forget
        // now, so a contributor recorded after an in-flight run snapshotted
        // the map is not in the drained commit — without this second drain the
        // just-made version is missing from the timeline. Reader-side on
        // purpose: draining in the generic flush changed shutdown semantics.
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

      // Folder timeline — attributed activity over a folder's
      // `.ok/` artifacts (templates + frontmatter). Distinct from the doc DAG
      // walk: no rename chain, no checkpoint filter.
      if (folderParam !== null && !docName) {
        const validated = validateFolderRel(folderParam, res, 'folder', 'history');
        if (!validated) return;
        const rawFolderLimit = Number(url.searchParams.get('limit') ?? '50');
        const folderLimit = Math.min(200, Number.isFinite(rawFolderLimit) ? rawFolderLimit : 50);
        const rawFolderOffset = Number(url.searchParams.get('offset') ?? '0');
        const folderOffset = Math.max(0, Number.isFinite(rawFolderOffset) ? rawFolderOffset : 0);
        // Single-flight key — folder mode. The resolved `branch` (not the raw
        // param) is used so two requests on the same effective branch coalesce.
        const folderKey = `folder\0${branch}\0${validated.folderRel}\0${folderLimit}\0${folderOffset}`;
        // `getFolderTimeline` is self-contained: it catches its own git/IO
        // errors, logs them, and returns an empty result rather than throwing —
        // so a handler-level catch here would be dead code.
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

      // Validate docName before it reaches `getDocumentHistory`, which
      // interpolates it into a git pathspec for `git log` / `cat-file -e`.
      // Without this guard, a docName containing `..` or null bytes could
      // (after git's pathspec normalization) target a path outside the
      // configured content root in the shadow repo. Sibling endpoints
      // (handleHistoryVersion, handleDiff, handleRollback) already gate via
      // safeDocPath.
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
      // Auto-consolidation checkpoints are hidden by default; opt-in for
      // debugging / a future maintenance UI. Part of the single-flight tuple
      // because it changes the result set.
      const includeAutoCheckpoints = url.searchParams.get('includeAutoCheckpoints') === 'true';

      // Single-flight key — doc mode. Covers every param `getDocumentHistory`
      // reads so a differing tuple never shares a wrong result.
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
        // Generic title — raw `e.message` can leak FS paths / library internals.
        // The underlying message is forwarded to Pino via `cause` for ops triage.
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read history.', {
          handler: 'history',
          cause: e,
        });
      }
    },
    { handler: 'history', method: 'GET', skipBodyParse: true },
  );

  // ── GET /api/history/:sha ─────────────────────────────────────────────────
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
      // 503 (not 400): shadow-repo unavailability is a server-side state,
      // matching the sync-not-active precedent.
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

    // Validate SHA format
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid commit SHA.', {
        handler: 'history-version',
      });
      return;
    }

    try {
      // Resolve the doc's historical path at this commit by walking the
      // rename chain (mirrors handleRollback + handleDiff). Without
      // this, requesting a pre-rename commit's content returns 404 even
      // though the timeline correctly shows the entry — the UI then falls
      // back to its "Diff unavailable" / "Document did not exist" rendering.
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

      // Resolve commit metadata
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
          // Decode inside dispatch so a malformed encoding surfaces as the
          // dispatch span's generic 500 (the legacy behavior), not a
          // resolve-time throw.
          dispatch: encodedSha
            ? async (req, res) => {
                await handleHistoryVersion(req, res, decodeURIComponent(encodedSha));
              }
            : undefined,
        };
      }
      return null;
    },
    // `isMutating` tracks legacy MUTATING_ROUTES membership, NOT actual side
    // effects: neither route was in that set at the merge base, so the
    // declaration is byte-faithful even though `GET /api/history` flushes a
    // pending git commit + drains contributor stragglers. `/api/rollback`
    // mutates and stays on the legacy gate in the extension.
    isMutating: () => false,
  };

  return {
    // `/api/history/*` (not `:sha`) so an empty or slash-containing tail
    // reaches the table exactly like the legacy prefix match did.
    paths: [...Object.keys(routes), '/api/history/*'],
    table,
  };
}
