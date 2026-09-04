import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { relative, resolve } from 'node:path';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import {
  type DocumentListEntry,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  EmptyRequestSchema,
  type HeadingEntry,
  type LifecycleStatus,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { collectReferencedAssets } from '../asset-references.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import type { ContentFilter } from '../content-filter.ts';
import { canonicalDocName, getDocExtension } from '../doc-extensions.ts';
import type { FileIndexEntry, FolderIndexEntry } from '../file-watcher.ts';
import type { PinoLogger } from '../logger.ts';
import { extractPageIcon, extractPageTitle } from '../page-identity.ts';
import { toPosix } from '../path-utils.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { createStreamingErrorWriter, errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

function showAllWantsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

interface ShowAllWalkResult {
  documents: DocumentListEntry[];
  truncated: boolean;
}

interface InflightShowAllWalk {
  promise: Promise<ShowAllWalkResult>;
  controller: AbortController;
  waiters: number;
}

export interface DocumentRouteDeps {
  hocuspocus: Hocuspocus;
  contentDir: string;
  isSafeDocName: (docName: string) => boolean;
  resolveAlias: (docName: string) => string;
  resolveContentEntryPath: (contentDir: string, kind: 'file' | 'folder', path: string) => string;
  resolveDocPath: (docName: string) => string | null;
  extractHeadings: (content: string) => HeadingEntry[];
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  log: PinoLogger;
  ready: Promise<void> | undefined;
  contentFilter: ContentFilter | undefined;
  safeSubdir: (baseDir: string, subdir: string) => string;
  getShowAllMaxEntries: () => number;
  streamShowAllEntries: (opts: {
    contentDir: string;
    contentFilter: ContentFilter;
    dirFilter: string | null;
    maxEntries: number;
    maxDepth: number;
    showOk: boolean;
    signal: AbortSignal;
  }) => AsyncGenerator<DocumentListEntry, { truncated: boolean }, void>;
  walkContentDirForShowAll: (opts: {
    contentDir: string;
    contentFilter: ContentFilter;
    dirFilter: string | null;
    documents: DocumentListEntry[];
    maxEntries: number;
    maxDepth: number;
    showOk: boolean;
    signal: AbortSignal;
  }) => Promise<{ truncated: boolean }>;
  synthesizeShowAllAssetExt: (name: string) => string;
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getFolderIndex: (() => ReadonlyMap<string, FolderIndexEntry>) | undefined;
  getFolderAliasIndex: (() => ReadonlyMap<string, string>) | undefined;
  onReferencedAssetsCacheInvalidator: ((invalidate: () => void) => void) | undefined;
}

export interface DocumentRoutes {
  paths: readonly string[];
  table: ApiRouteTable;
  invalidateReferencedAssetsCache: () => void;
}

export function createDocumentRoutes(deps: DocumentRouteDeps): DocumentRoutes {
  const {
    hocuspocus,
    contentDir,
    isSafeDocName,
    resolveAlias,
    resolveContentEntryPath,
    resolveDocPath,
    extractHeadings,
    getFileIndex,
    log,
    ready,
    contentFilter,
    safeSubdir,
    getShowAllMaxEntries,
    streamShowAllEntries,
    walkContentDirForShowAll,
    synthesizeShowAllAssetExt,
    getAllFilesIndex,
    getFolderIndex,
    getFolderAliasIndex,
    onReferencedAssetsCacheInvalidator,
  } = deps;

  const showAllInflight = new Map<string, InflightShowAllWalk>();

  let referencedAssetsCache: {
    signature: string;
    assets: ReturnType<typeof collectReferencedAssets>;
  } | null = null;

  function referencedAssetsSignature(index: ReadonlyMap<string, FileIndexEntry>): string {
    return [...index.entries()]
      .map(
        ([docName, entry]) =>
          `${docName}\0${entry.canonicalPath}\0${entry.size}\0${entry.modified}\0${entry.aliases.join('\0')}`,
      )
      .sort()
      .join('\n');
  }

  function invalidateReferencedAssetsCache(): void {
    referencedAssetsCache = null;
  }
  onReferencedAssetsCacheInvalidator?.(invalidateReferencedAssetsCache);

  function readLifecycleStatus(document: Document): LifecycleStatus | null {
    const lifecycleMap = document.getMap('lifecycle');
    const status = lifecycleMap.get('status');
    if (typeof status !== 'string' || status.length === 0) return null;
    const reason = lifecycleMap.get('reason');
    return { status, reason: typeof reason === 'string' ? reason : '' };
  }

  const handleDocumentRead = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const rawDocName = url.searchParams.get('docName') || 'test-doc';
        if (!isSafeDocName(rawDocName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'document-read',
          });
          return;
        }
        const docName = canonicalDocName(resolveAlias(rawDocName));
        if (isSystemDoc(docName) || isConfigDoc(docName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${docName}' is a reserved document name.`,
            { handler: 'document-read' },
          );
          return;
        }

        const existing = hocuspocus.documents.get(docName);
        if (existing) {
          successResponse(
            res,
            200,
            DocumentReadSuccessSchema,
            {
              docName,
              content: existing.getText('source').toString(),
              lifecycle: readLifecycleStatus(existing),
            },
            { handler: 'document-read' },
          );
          return;
        }

        const filePath = resolveContentEntryPath(contentDir, 'file', docName);
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', `Document not found: ${docName}.`, {
            handler: 'document-read',
          });
          return;
        }

        const dc = await hocuspocus.openDirectConnection(docName);
        try {
          const document = dc.document;
          if (!document) {
            errorResponse(
              res,
              500,
              'urn:ok:error:doc-not-available',
              'Document is not available.',
              { handler: 'document-read' },
            );
            return;
          }
          const content = document.getText('source').toString();
          successResponse(
            res,
            200,
            DocumentReadSuccessSchema,
            { docName, content, lifecycle: readLifecycleStatus(document) },
            { handler: 'document-read' },
          );
        } finally {
          await dc.disconnect();
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read document.', {
          handler: 'document-read',
          cause: e,
        });
      }
    },
    { handler: 'document-read', method: 'GET', skipBodyParse: true },
  );

  const handleDocumentList = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'document-list' },
              '[api] ready gate rejected — responding with partial index',
            );
          });
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const dir = url.searchParams.get('dir');
        const showAll = url.searchParams.get('showAll') === 'true';
        const showOk = url.searchParams.get('showOk') === 'true';
        const showAllMaxDepth =
          url.searchParams.get('depth') === '1' ? 1 : Number.POSITIVE_INFINITY;

        if (dir) {
          try {
            safeSubdir(contentDir, dir);
          } catch {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Invalid directory parameter.',
              {
                handler: 'document-list',
              },
            );
            return;
          }
        }

        if (showAll && contentFilter && showAllWantsNdjson(req)) {
          const controller = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) controller.abort();
          });
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'Transfer-Encoding': 'chunked',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache',
          });
          const writeStreamError = createStreamingErrorWriter(res, 'document-list');

          const writeNdjsonLine = async (line: string): Promise<void> => {
            if (res.writableEnded || res.destroyed) return;
            if (res.write(line)) return;
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
            });
          };

          try {
            const maxEntries = getShowAllMaxEntries();
            const generator = streamShowAllEntries({
              contentDir,
              contentFilter,
              dirFilter: dir,
              maxEntries,
              maxDepth: showAllMaxDepth,
              showOk,
              signal: controller.signal,
            });
            let count = 0;
            let next = await generator.next();
            while (!next.done) {
              await writeNdjsonLine(`${JSON.stringify(next.value)}\n`);
              count += 1;
              next = await generator.next();
            }
            const { truncated } = next.value;
            if (truncated) {
              log.info(
                { handler: 'document-list', maxEntries, count },
                '[document-list][showAll] stream truncated at entry cap',
              );
            }
            await writeNdjsonLine(`${JSON.stringify({ type: 'complete', truncated, count })}\n`);
          } catch (err) {
            if (!res.writableEnded && !res.destroyed) {
              writeStreamError(
                500,
                'urn:ok:error:internal-server-error',
                'Failed to list documents (showAll stream).',
                { cause: err },
              );
            } else {
              log.error(
                { err, handler: 'document-list' },
                '[document-list][showAll] stream failed after response ended',
              );
            }
          } finally {
            if (!res.writableEnded) res.end();
          }
          return;
        }

        if (showAll && contentFilter) {
          const key = `showAll:${showAllMaxDepth === 1 ? 'd1:' : ''}${showOk ? 'ok:' : ''}${dir ?? ''}`;
          let entry = showAllInflight.get(key);
          if (!entry) {
            const controller = new AbortController();
            const promise = (async (): Promise<ShowAllWalkResult> => {
              const documents: DocumentListEntry[] = [];
              const maxEntries = getShowAllMaxEntries();
              const { truncated } = await walkContentDirForShowAll({
                contentDir,
                contentFilter,
                dirFilter: dir,
                documents,
                maxEntries,
                maxDepth: showAllMaxDepth,
                showOk,
                signal: controller.signal,
              });
              documents.sort((a, b) => {
                const aPath = a.kind === 'folder' ? (a.path ?? '') : (a.docName ?? a.path ?? '');
                const bPath = b.kind === 'folder' ? (b.path ?? '') : (b.docName ?? b.path ?? '');
                return aPath.localeCompare(bPath);
              });
              if (truncated) {
                log.info(
                  { handler: 'document-list', maxEntries, count: documents.length },
                  '[document-list][showAll] walk truncated at entry cap',
                );
              }
              return { documents, truncated };
            })();
            entry = { promise, controller, waiters: 0 };
            const created = entry;
            showAllInflight.set(key, created);
            void promise.finally(() => {
              if (showAllInflight.get(key) === created) showAllInflight.delete(key);
            });
          }

          const attached = entry;
          attached.waiters += 1;
          let released = false;
          const releaseOnDisconnect = () => {
            if (res.writableEnded || released) return;
            released = true;
            attached.waiters -= 1;
            if (attached.waiters <= 0) {
              attached.controller.abort();
              if (showAllInflight.get(key) === attached) showAllInflight.delete(key);
            }
          };
          res.on('close', releaseOnDisconnect);

          try {
            const { documents, truncated } = await attached.promise;
            if (released) return;
            successResponse(
              res,
              200,
              DocumentListSuccessSchema,
              truncated ? { documents, truncated } : { documents },
              { handler: 'document-list' },
            );
          } catch (e) {
            if (released) return;
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to list documents (showAll mode).',
              { handler: 'document-list', cause: e },
            );
          } finally {
            res.removeListener('close', releaseOnDisconnect);
          }
          return;
        }

        const index = getFileIndex();
        const allFiles = getAllFilesIndex();
        const folderIndex = getFolderIndex?.() ?? new Map<string, FolderIndexEntry>();
        const documents: DocumentListEntry[] = [];

        for (const [folderPath, entry] of folderIndex) {
          if (dir && !folderPath.startsWith(`${dir}/`) && folderPath !== dir) continue;
          documents.push({
            kind: 'folder',
            path: folderPath,
            size: 0,
            modified: entry.modified,
            docExt: '.md',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

        let assets: ReturnType<typeof collectReferencedAssets> = [];
        try {
          const assetSignature = referencedAssetsSignature(index);
          if (referencedAssetsCache?.signature !== assetSignature) {
            referencedAssetsCache = {
              signature: assetSignature,
              assets: collectReferencedAssets({
                contentDir,
                fileIndex: index,
                readMarkdown: (path) => {
                  try {
                    return readFileSync(path, 'utf-8');
                  } catch {
                    return null;
                  }
                },
                isExcluded: contentFilter ? (rel) => contentFilter.isPathIgnored(rel) : undefined,
              }),
            };
          }
          assets = referencedAssetsCache?.assets ?? [];
        } catch (err) {
          referencedAssetsCache = null;
          log.warn({ err }, '[document-list] asset collection failed; returning documents only');
        }

        const assetPaths = new Set<string>();
        for (const asset of assets) {
          if (dir && !asset.path.startsWith(`${dir}/`) && asset.path !== dir) continue;
          assetPaths.add(asset.path);
          documents.push({
            kind: 'asset',
            docName: asset.path,
            docExt: asset.assetExt,
            path: asset.path,
            assetExt: asset.assetExt,
            mediaKind: asset.mediaKind,
            referencedBy: asset.referencedBy,
            size: asset.size,
            modified: asset.modified,
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

        for (const [docName, entry] of allFiles) {
          if (entry.kind === 'markdown') {
            if (dir && !docName.startsWith(`${dir}/`) && docName !== dir) continue;

            const docExt = getDocExtension(docName);

            documents.push({
              kind: 'document',
              docName,
              docExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: false,
              canonicalDocName: null,
              targetPath: null,
            });

            for (const alias of entry.aliases) {
              if (dir && !alias.startsWith(`${dir}/`) && alias !== dir) continue;
              const targetRelPath = toPosix(relative(contentDir, entry.canonicalPath));
              documents.push({
                kind: 'document',
                docName: alias,
                docExt,
                size: entry.size,
                modified: entry.modified,
                isSymlink: true,
                canonicalDocName: docName,
                targetPath: targetRelPath,
              });
            }
            continue;
          }

          const passesDir = !dir || docName === dir || docName.startsWith(`${dir}/`);
          if (passesDir && !assetPaths.has(docName)) {
            const assetExt = synthesizeShowAllAssetExt(docName);
            documents.push({
              kind: 'file',
              docName,
              path: docName,
              docExt: `.${assetExt}`,
              assetExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: false,
              canonicalDocName: null,
              targetPath: null,
            });
          }
          for (const alias of entry.aliases) {
            const aliasPassesDir = !dir || alias === dir || alias.startsWith(`${dir}/`);
            if (!aliasPassesDir || assetPaths.has(alias)) continue;
            const targetRelPath = toPosix(relative(contentDir, entry.canonicalPath));
            const assetExt = synthesizeShowAllAssetExt(alias);
            documents.push({
              kind: 'file',
              docName: alias,
              path: alias,
              docExt: `.${assetExt}`,
              assetExt,
              size: entry.size,
              modified: entry.modified,
              isSymlink: true,
              canonicalDocName: docName,
              targetPath: targetRelPath,
            });
          }
        }

        const folderAliasIndex = getFolderAliasIndex?.() ?? new Map<string, string>();
        if (folderAliasIndex.size > 0) {
          const passesDirFilter = (p: string): boolean =>
            !dir || p === dir || p.startsWith(`${dir}/`);
          const aliasesByCanonical = new Map<string, string[]>();
          for (const [aliasPrefix, canonicalPrefix] of folderAliasIndex) {
            const arr = aliasesByCanonical.get(canonicalPrefix);
            if (arr) arr.push(aliasPrefix);
            else aliasesByCanonical.set(canonicalPrefix, [aliasPrefix]);
          }
          for (const [canonicalPrefix, aliasPrefixes] of aliasesByCanonical) {
            const canonRoot = folderIndex.get(canonicalPrefix);
            const rootTarget = canonRoot
              ? toPosix(relative(contentDir, canonRoot.canonicalPath))
              : canonicalPrefix;
            for (const aliasPrefix of aliasPrefixes) {
              if (!passesDirFilter(aliasPrefix)) continue;
              documents.push({
                kind: 'folder',
                path: aliasPrefix,
                size: 0,
                modified: canonRoot?.modified ?? '1970-01-01T00:00:00.000Z',
                docExt: '.md',
                isSymlink: true,
                canonicalDocName: canonicalPrefix,
                targetPath: rootTarget,
              });
            }
          }
          const projectChild = (name: string, emit: (aliasName: string) => void): void => {
            for (
              let slash = name.indexOf('/');
              slash !== -1;
              slash = name.indexOf('/', slash + 1)
            ) {
              const aliasPrefixes = aliasesByCanonical.get(name.slice(0, slash));
              if (!aliasPrefixes) continue;
              const rest = name.slice(slash);
              for (const aliasPrefix of aliasPrefixes) {
                const aliasName = `${aliasPrefix}${rest}`;
                if (passesDirFilter(aliasName)) emit(aliasName);
              }
            }
          };
          for (const [folderPath, fEntry] of folderIndex) {
            projectChild(folderPath, (aliasName) => {
              documents.push({
                kind: 'folder',
                path: aliasName,
                size: 0,
                modified: fEntry.modified,
                docExt: '.md',
                isSymlink: true,
                canonicalDocName: folderPath,
                targetPath: toPosix(relative(contentDir, fEntry.canonicalPath)),
              });
            });
          }
          for (const [docName, dEntry] of allFiles) {
            projectChild(docName, (aliasName) => {
              const targetRelPath = toPosix(relative(contentDir, dEntry.canonicalPath));
              if (dEntry.kind === 'markdown') {
                documents.push({
                  kind: 'document',
                  docName: aliasName,
                  docExt: getDocExtension(docName),
                  size: dEntry.size,
                  modified: dEntry.modified,
                  isSymlink: true,
                  canonicalDocName: docName,
                  targetPath: targetRelPath,
                });
              } else {
                const assetExt = synthesizeShowAllAssetExt(aliasName);
                documents.push({
                  kind: 'file',
                  docName: aliasName,
                  path: aliasName,
                  docExt: `.${assetExt}`,
                  assetExt,
                  size: dEntry.size,
                  modified: dEntry.modified,
                  isSymlink: true,
                  canonicalDocName: docName,
                  targetPath: targetRelPath,
                });
              }
            });
          }
        }

        documents.sort((a, b) => {
          const aPath = a.kind === 'folder' ? (a.path ?? '') : (a.docName ?? a.path ?? '');
          const bPath = b.kind === 'folder' ? (b.path ?? '') : (b.docName ?? b.path ?? '');
          return aPath.localeCompare(bPath);
        });
        successResponse(
          res,
          200,
          DocumentListSuccessSchema,
          { documents },
          { handler: 'document-list' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list documents.', {
          handler: 'document-list',
          cause: e,
        });
      }
    },
    { handler: 'document-list', method: 'GET', skipBodyParse: true },
  );

  const handlePageHeadings = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('docName');
        if (!docName || docName.length === 0) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Missing docName query parameter.',
            { handler: 'page-headings' },
          );
          return;
        }
        if (!isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'page-headings',
          });
          return;
        }
        const filePath = resolveDocPath(docName);
        if (!filePath) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'page-headings',
          });
          return;
        }
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Page not found.', {
            handler: 'page-headings',
          });
          return;
        }
        const content = readFileSync(filePath, 'utf-8');
        const headings = extractHeadings(content);
        successResponse(
          res,
          200,
          PageHeadingsSuccessSchema,
          { docName, headings },
          { handler: 'page-headings' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read headings.', {
          handler: 'page-headings',
          cause: e,
        });
      }
    },
    { handler: 'page-headings', method: 'GET', skipBodyParse: true },
  );

  const handlePages = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const index = getFileIndex();
        const pages: {
          docName: string;
          title: string;
          docExt: string;
          size: number;
          modified: string;
          icon?: string;
        }[] = [];
        for (const [docName, entry] of index) {
          const docExt = getDocExtension(docName);
          let title: string;
          let icon: string | undefined;
          if (entry.title !== undefined) {
            title = entry.title;
            icon = entry.icon;
          } else {
            title = docName;
            try {
              const filePath = resolve(contentDir, `${docName}${docExt}`);
              const content = readFileSync(filePath, 'utf-8');
              title = extractPageTitle(content, docName);
              icon = extractPageIcon(content);
            } catch (err) {
              log.warn({ docName, err }, `[pages] Failed to read title for ${docName}`);
            }
          }
          pages.push({ docName, title, docExt, size: entry.size, modified: entry.modified, icon });
        }
        pages.sort((a, b) => a.docName.localeCompare(b.docName));
        successResponse(res, 200, PagesSuccessSchema, { pages }, { handler: 'pages' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to list pages.', {
          handler: 'pages',
          cause: e,
        });
      }
    },
    { handler: 'pages', method: 'GET', skipBodyParse: true },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/document': handleDocumentRead,
    '/api/documents': handleDocumentList,
    '/api/pages': handlePages,
    '/api/page-headings': handlePageHeadings,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      return null;
    },
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
    invalidateReferencedAssetsCache,
  };
}
