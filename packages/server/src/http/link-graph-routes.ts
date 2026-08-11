/**
 * The link/graph read family — `backlinks`, `backlink-counts`,
 * `forward-links`, `link-graph`, `dead-links`, `orphans`, `hubs`,
 * `tags-list`, `tags-for-name`, `suggest-links` — lifted out of
 * `api-extension.ts` as the first natively-routed Wave 2 group. Same lift
 * shape as `skills-sh-handlers.ts`: what the handlers closed over in the
 * extension arrives as {@link LinkGraphRouteDeps}, and the handler bodies
 * are unchanged.
 *
 * Unlike the skills.sh handlers, this group does NOT return to the legacy
 * route table: `createLinkGraphRoutes` returns an {@link ApiRouteTable} +
 * the Hono patterns for the native mount, and the extension exposes them as
 * its `nativeApi` handle. A route lives in exactly one router — these paths
 * are gone from the legacy dispatch record in the same change.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  BacklinkCountsSuccessSchema,
  BacklinksSuccessSchema,
  DeadLinksSuccessSchema,
  EmptyRequestSchema,
  ForwardLinksSuccessSchema,
  HubsSuccessSchema,
  LinkGraphSuccessSchema,
  OrphansSuccessSchema,
  SuggestLinksSuccessSchema,
  TagsForNameSuccessSchema,
  TagsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import {
  type DerivedDocumentIndexApiPort,
  type DerivedGraphNode,
  isDerivedOrphanMode,
  isLocalTargetIndexNotReadyError,
} from '../derived-document-index.ts';
import type { FileIndexEntry } from '../file-watcher.ts';
import { toForwardLinkLocalTargets } from '../local-target-assessment.ts';
import type { FrontmatterMetadata } from '../page-identity.ts';
import { SuggestLinksTargetNotFoundError, suggestLinks } from '../suggest-links.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface LinkGraphRouteDeps {
  hocuspocus: Hocuspocus;
  derivedDocumentIndex: DerivedDocumentIndexApiPort | undefined;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  /** The extension's docName safety predicate (path-traversal refusal). */
  isSafeDocName: (docName: string) => boolean;
  readPageTitleForDocName: (docName: string) => string;
  readPageTitleForLinkedDocName: (docName: string, admitted: Set<string>) => string;
  readFrontmatterMetadataForLinkedDocName: (
    docName: string,
    admitted: Set<string>,
  ) => FrontmatterMetadata;
  collectAdmittedDocNames: () => Promise<Set<string>>;
  resolveAlias: (docName: string) => string;
  respondToDerivedIndexQueryFailure: (
    res: ServerResponse,
    err: unknown,
    options: { handler: string; failureTitle: string },
  ) => void;
}

export interface LinkGraphRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
  table: ApiRouteTable;
}

export function createLinkGraphRoutes(deps: LinkGraphRouteDeps): LinkGraphRoutes {
  const {
    hocuspocus,
    derivedDocumentIndex,
    getFileIndex,
    isSafeDocName,
    readPageTitleForDocName,
    readPageTitleForLinkedDocName,
    readFrontmatterMetadataForLinkedDocName,
    collectAdmittedDocNames,
    resolveAlias,
    respondToDerivedIndexQueryFailure,
  } = deps;

  const handleBacklinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'backlinks' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'backlinks',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'backlinks',
          });
          return;
        }
        const backlinks = (await derivedDocumentIndex.getBacklinks(docName)).map((entry) => ({
          source: entry.source,
          anchor: entry.anchor,
          title: readPageTitleForDocName(entry.source),
          snippet: entry.snippet,
        }));
        successResponse(
          res,
          200,
          BacklinksSuccessSchema,
          { docName, backlinks },
          { handler: 'backlinks' },
        );
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'backlinks',
          failureTitle: 'Failed to read backlinks.',
        });
      }
    },
    { handler: 'backlinks', method: 'GET', skipBodyParse: true },
  );

  /**
   * Bulk backlink-count lookup. `GET /api/backlink-counts?docNames=a,b,c`
   * returns `{ counts: { a: 3, b: 0, c: 2 } }`. Serves listing UIs
   * (exec ls/grep/find slim enrichment) that need connection density per file
   * without N-amplifying the single-doc `/api/backlinks` endpoint.
   * docNames failing `isSafeDocName` are silently dropped from `counts`.
   */
  const handleBacklinkCounts = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'backlink-counts' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const raw = url.searchParams.get('docNames');
        if (!raw) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docNames parameter.', {
            handler: 'backlink-counts',
          });
          return;
        }
        const docNames = raw
          .split(',')
          .map((docName) => docName.trim())
          .filter((docName) => docName && isSafeDocName(docName));
        const counts = await derivedDocumentIndex.getBacklinkCounts(docNames);
        successResponse(
          res,
          200,
          BacklinkCountsSuccessSchema,
          { counts },
          { handler: 'backlink-counts' },
        );
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'backlink-counts',
          failureTitle: 'Failed to read backlink counts.',
        });
      }
    },
    { handler: 'backlink-counts', method: 'GET', skipBodyParse: true },
  );

  const handleForwardLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'forward-links' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'forward-links',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'forward-links',
          });
          return;
        }
        const admitted = await collectAdmittedDocNames();
        const forwardLinks = (await derivedDocumentIndex.getForwardLinkEntries(docName)).map(
          (entry) =>
            entry.kind === 'doc'
              ? {
                  kind: 'doc' as const,
                  docName: entry.target,
                  anchor: entry.anchor,
                  title: readPageTitleForLinkedDocName(entry.target, admitted),
                  snippet: entry.snippet,
                }
              : {
                  kind: 'external' as const,
                  url: entry.url,
                  title: entry.label ?? entry.url,
                  snippet: entry.snippet,
                },
        );
        // Local file/image references ride an additive sibling collection sourced
        // from the assessment index — never reclassified from the graph rows above,
        // so document relationship semantics stay pure.
        let localTargets: ReturnType<typeof toForwardLinkLocalTargets> | undefined;
        try {
          const localTargetSources = await derivedDocumentIndex.getLocalTargetAssessmentsForSources(
            [docName],
          );
          localTargets = toForwardLinkLocalTargets(
            localTargetSources.flatMap((entry) => entry.assessments),
          );
        } catch (error) {
          if (!isLocalTargetIndexNotReadyError(error)) throw error;
        }
        successResponse(
          res,
          200,
          ForwardLinksSuccessSchema,
          { docName, forwardLinks, ...(localTargets ? { localTargets } : {}) },
          { handler: 'forward-links' },
        );
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'forward-links',
          failureTitle: 'Failed to read forward links.',
        });
      }
    },
    { handler: 'forward-links', method: 'GET', skipBodyParse: true },
  );

  const handleLinkGraph = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'link-graph' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (docName && !isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'link-graph',
          });
          return;
        }

        const rawDegrees = url.searchParams.get('degrees');
        if (rawDegrees && !docName) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'docName is required when degrees is provided.',
            { handler: 'link-graph' },
          );
          return;
        }

        let nodes: DerivedGraphNode[];
        let links: Array<{ source: string; target: string }>;

        if (rawDegrees && docName) {
          const degrees = Number.parseInt(rawDegrees, 10);
          if (!Number.isFinite(degrees) || degrees < 0) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'degrees must be a non-negative integer.',
              { handler: 'link-graph' },
            );
            return;
          }

          ({ nodes, links } = await derivedDocumentIndex.getLinkGraphNeighborhood(
            docName,
            degrees,
          ));
        } else {
          ({ nodes, links } = await derivedDocumentIndex.getLinkGraph());
        }

        const admitted = await collectAdmittedDocNames();
        const enrichedNodes = nodes.map((node) => {
          if (node.kind === 'doc') {
            const meta = readFrontmatterMetadataForLinkedDocName(node.docName, admitted);
            return {
              id: node.id,
              kind: 'doc' as const,
              docName: node.docName,
              anchor: node.anchor ?? null,
              label: readPageTitleForLinkedDocName(node.docName, admitted),
              cluster: meta.cluster ?? null,
              category: meta.category ?? null,
              tags: meta.tags ?? null,
            };
          }
          return {
            id: node.id,
            kind: 'external' as const,
            url: node.url,
            label: node.label ?? node.url,
          };
        });
        successResponse(
          res,
          200,
          LinkGraphSuccessSchema,
          { nodes: enrichedNodes, links },
          { handler: 'link-graph' },
        );
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'link-graph',
          failureTitle: 'Failed to read link graph.',
        });
      }
    },
    { handler: 'link-graph', method: 'GET', skipBodyParse: true },
  );

  const handleDeadLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'dead-links' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const sourceDocNames = url.searchParams.getAll('sourceDocName');
        if (sourceDocNames.some((docName) => docName.length === 0 || !isSafeDocName(docName))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid sourceDocName.', {
            handler: 'dead-links',
          });
          return;
        }

        const sourceDocNameFilter = sourceDocNames.length
          ? [...new Set(sourceDocNames.map((docName) => resolveAlias(docName)))]
          : undefined;
        const deadLinks = await derivedDocumentIndex.getDeadLinks(
          await collectAdmittedDocNames(),
          sourceDocNameFilter,
        );

        successResponse(
          res,
          200,
          DeadLinksSuccessSchema,
          {
            deadLinks: deadLinks.map((entry) => ({
              target: entry.target,
              sources: entry.sources.map((sourceEntry) => ({
                source: sourceEntry.source,
                title: readPageTitleForDocName(sourceEntry.source),
                snippet: sourceEntry.snippet,
              })),
            })),
          },
          { handler: 'dead-links' },
        );
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'dead-links',
          failureTitle: 'Failed to read dead links.',
        });
      }
    },
    { handler: 'dead-links', method: 'GET', skipBodyParse: true },
  );

  const handleOrphans = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'orphans' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const mode = url.searchParams.get('mode') ?? 'both';
        if (!isDerivedOrphanMode(mode)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid orphan mode. Allowed values: incoming, outgoing, both.',
            { handler: 'orphans' },
          );
          return;
        }

        const orphans = (
          await derivedDocumentIndex.getOrphans([...getFileIndex().keys()], mode)
        ).map((docName) => ({
          docName,
          title: readPageTitleForDocName(docName),
        }));
        successResponse(res, 200, OrphansSuccessSchema, { orphans }, { handler: 'orphans' });
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'orphans',
          failureTitle: 'Failed to read orphan pages.',
        });
      }
    },
    { handler: 'orphans', method: 'GET', skipBodyParse: true },
  );

  const handleHubs = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:backlink-index-not-configured',
          'Backlink index is not configured.',
          { handler: 'hubs' },
        );
        return;
      }
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawLimit = url.searchParams.get('limit');
        const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
        const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
        const admitted = await collectAdmittedDocNames();
        const hubs = (await derivedDocumentIndex.getHubs(limit)).map((hub) => ({
          docName: hub.docName,
          title: readPageTitleForLinkedDocName(hub.docName, admitted),
          count: hub.count,
        }));
        successResponse(res, 200, HubsSuccessSchema, { hubs }, { handler: 'hubs' });
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'hubs',
          failureTitle: 'Failed to read hub pages.',
        });
      }
    },
    { handler: 'hubs', method: 'GET', skipBodyParse: true },
  );

  const handleSuggestLinks = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing docName parameter.', {
            handler: 'suggest-links',
          });
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'suggest-links',
          });
          return;
        }
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'suggest-links' },
          );
          return;
        }

        const result = await suggestLinks({
          hocuspocus,
          fileIndex: getFileIndex(),
          docName,
        });
        successResponse(res, 200, SuggestLinksSuccessSchema, result, { handler: 'suggest-links' });
      } catch (error) {
        if (error instanceof SuggestLinksTargetNotFoundError) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Page not found.', {
            handler: 'suggest-links',
            cause: error,
          });
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to suggest links.', {
          handler: 'suggest-links',
          cause: error,
        });
      }
    },
    { handler: 'suggest-links', method: 'GET', skipBodyParse: true },
  );

  const handleTagsList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!derivedDocumentIndex) {
        errorResponse(
          res,
          503,
          'urn:ok:error:tag-index-not-configured',
          'Tag index not configured.',
          { handler: 'tags-list' },
        );
        return;
      }
      try {
        const tags = await derivedDocumentIndex.getAllTags();
        successResponse(res, 200, TagsListSuccessSchema, { tags }, { handler: 'tags-list' });
      } catch (e) {
        respondToDerivedIndexQueryFailure(res, e, {
          handler: 'tags-list',
          failureTitle: 'Failed to read tags.',
        });
      }
    },
    { handler: 'tags-list', method: 'GET', skipBodyParse: true },
  );

  async function handleTagsForName(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
  ): Promise<void> {
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'tags-for-name',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    if (!derivedDocumentIndex) {
      errorResponse(
        res,
        503,
        'urn:ok:error:tag-index-not-configured',
        'Tag index not configured.',
        { handler: 'tags-for-name' },
      );
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch (uriErr) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid tag name encoding.', {
        handler: 'tags-for-name',
        cause: uriErr,
      });
      return;
    }
    if (!name) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing tag name.', {
        handler: 'tags-for-name',
      });
      return;
    }
    try {
      const docs = (await derivedDocumentIndex.getDocsForTagWithMatches(name)).map(
        ({ docName, matchingTags }) => ({
          docName,
          title: readPageTitleForDocName(docName),
          matchingTags,
          snippet: null,
        }),
      );
      successResponse(
        res,
        200,
        TagsForNameSuccessSchema,
        { name, docs },
        {
          handler: 'tags-for-name',
        },
      );
    } catch (e) {
      respondToDerivedIndexQueryFailure(res, e, {
        handler: 'tags-for-name',
        failureTitle: 'Failed to read tag membership.',
      });
    }
  }

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/backlinks': handleBacklinks,
    '/api/backlink-counts': handleBacklinkCounts,
    '/api/forward-links': handleForwardLinks,
    '/api/link-graph': handleLinkGraph,
    '/api/dead-links': handleDeadLinks,
    '/api/orphans': handleOrphans,
    '/api/hubs': handleHubs,
    '/api/tags': handleTagsList,
    '/api/suggest-links': handleSuggestLinks,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      if (url.startsWith('/api/tags/')) {
        const rawName = url.slice('/api/tags/'.length);
        return {
          template: '/api/tags/:name',
          // Empty name (`/api/tags/`): no dispatch — the pipeline's explicit
          // 404 owns it, under the same template the legacy dispatch used.
          dispatch: rawName ? (req, res) => handleTagsForName(req, res, rawName) : undefined,
        };
      }
      return null;
    },
    // Every route in this group is a read (none rode the legacy
    // MUTATING_ROUTES loopback/Host gate).
    isMutating: () => false,
  };

  return {
    // `/api/tags/*` (not `:name`) so an empty or slash-containing tail
    // reaches the table exactly like the legacy prefix match did.
    paths: [...Object.keys(routes), '/api/tags/*'],
    table,
  };
}
