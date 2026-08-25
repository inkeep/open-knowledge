/**
 * The document/pages read family — `document`, `pages`, `page-headings` —
 * lifted out of `api-extension.ts` as the third natively-routed Wave 2
 * group. Same lift shape as `link-graph-routes.ts` / `metrics-routes.ts`:
 * what the handlers closed over in the extension arrives as
 * {@link DocumentRouteDeps}, the handler bodies are unchanged, and the
 * extension composes this group's table into its `nativeApi` handle while
 * the legacy dispatch record loses the paths in the same change.
 */

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

/**
 * True when a `GET /api/documents?showAll=true` caller negotiated the NDJSON
 * stream via `Accept: application/x-ndjson`. Buffered callers (no such Accept —
 * tests, scripts, non-streaming clients) keep the single-JSON single-flight
 * response, so streaming is strictly opt-in and back-compatible.
 */
function showAllWantsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

/** Sorted result of one Show All Files walk, shared by all coalesced callers. */
interface ShowAllWalkResult {
  documents: DocumentListEntry[];
  truncated: boolean;
}

/**
 * One in-flight Show All Files walk, shared by every concurrent request of the
 * same shape (single-flight dedupe — collapses the `concurrent_walks` heap
 * multiplier to 1). `waiters` refcounts still-connected callers; the walk is
 * aborted via `controller` only once it reaches zero, so one caller
 * disconnecting never strands the others.
 */
interface InflightShowAllWalk {
  promise: Promise<ShowAllWalkResult>;
  controller: AbortController;
  waiters: number;
}

export interface DocumentRouteDeps {
  hocuspocus: Hocuspocus;
  contentDir: string;
  /** The extension's docName safety predicate (path-traversal refusal). */
  isSafeDocName: (docName: string) => boolean;
  resolveAlias: (docName: string) => string;
  /** Traversal-confined absolute path for a content entry (extension's helper). */
  resolveContentEntryPath: (contentDir: string, kind: 'file' | 'folder', path: string) => string;
  /** Extension-scoped docName → absolute file path resolution (null on refusal). */
  resolveDocPath: (docName: string) => string | null;
  extractHeadings: (content: string) => HeadingEntry[];
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  log: PinoLogger;
  /** Init-completion gate; document-list parks on it before serving the index. */
  ready: Promise<void> | undefined;
  contentFilter: ContentFilter | undefined;
  /** Traversal-rejecting subdir join (throws on escape) — extension export. */
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
  /** Registers the referenced-assets cache invalidator with the outer server. */
  onReferencedAssetsCacheInvalidator: ((invalidate: () => void) => void) | undefined;
}

export interface DocumentRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
  table: ApiRouteTable;
  /**
   * Drops the referenced-assets cache. The extension's write paths
   * (create/delete/rename spines) call this so the next /api/documents
   * recomputes asset references; also registered with the outer server via
   * `onReferencedAssetsCacheInvalidator`.
   */
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

  // Single-flight dedupe for `GET /api/documents?showAll=true`. Keyed per
  // server instance (NOT module-global — tests boot several servers in one
  // process) by request shape so concurrent identical walks share one
  // traversal and one sorted result. Entries evict on settle.
  const showAllInflight = new Map<string, InflightShowAllWalk>();

  let referencedAssetsCache: {
    signature: string;
    assets: ReturnType<typeof collectReferencedAssets>;
  } | null = null;

  function referencedAssetsSignature(index: ReadonlyMap<string, FileIndexEntry>): string {
    // File watcher entries use a wall-clock `modified` stamp on every event,
    // so this metadata signature still tracks content changes when mtime
    // granularity would otherwise miss a rapid edit.
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

  /**
   * Read `lifecycle.status` + `lifecycle.reason` off a Y.Doc. Returns
   * `null` when no status is set so consumers can rely on a stable
   * `lifecycle === null` check rather than `lifecycle?.status`. `reason`
   * falls back to the empty string when only `status` is set — the typed
   * schema requires both fields, and the Y.Map's `reason` is set in
   * lockstep with `status` in every server-factory site that writes it.
   */
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
        // Collapse an extension-qualified spelling onto the document it names.
        // The room lookup below is a direct map read, so without this a caller
        // asking for `notes.md` misses the `notes` room and is answered from a
        // separate one that never converged with it.
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

        // Existing in-memory Y.Doc → read it directly; no need to round-trip
        // through openDirectConnection (which would still resolve to the same
        // doc but adds a connect/disconnect cycle).
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

        // No in-memory doc → require an on-disk file before opening a
        // connection. `openDirectConnection` on a missing path materializes
        // an empty Y.Doc into `Hocuspocus.documents` that auto-unload is
        // suppressed for. The persistence layer's phantom-doc guard blocks
        // the eventual 0-byte file write, but any later code path that
        // populates the lingering Y.Doc with content (a mis-routed agent
        // write, the rename spine pulling it in via a stale backlink edge)
        // would then land a phantom file because `reconciledBase` was never
        // set. 404 here closes that whole class.
        const filePath = resolveContentEntryPath(contentDir, 'file', docName);
        if (!existsSync(filePath)) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', `Document not found: ${docName}.`, {
            handler: 'document-read',
          });
          return;
        }

        // Read via a transient DirectConnection rather than sessionManager.getSession —
        // this endpoint has no agent identity, and creating a cached session would
        // leak an anonymous "Agent" (icon='bot') entry into the presence bar.
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
        // Park until the watcher's seed walk has populated the in-memory
        // file/folder index. Without this, a renderer that fetches before
        // initAsync resolves sees `documents: []` and renders the false
        // "No files yet" / "Welcome to your LLM brain" cold-start flash.
        // `.catch()` keeps the handler responsive on a degraded boot so
        // we serve whatever partial state is available rather than 500ing.
        // Most init failures already populate `degraded[]` via per-subsystem
        // try-catches inside `initAsync`, but a throw outside those guards
        // (e.g., a future subsystem added without its own catch) propagates
        // here unlabeled — log it so operators have a trail.
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
        // Tree-listing reveal: admit `.ok` rows (minus worktrees/local) into
        // the showAll walk. Inert without showAll — the watcher indexes
        // backing the non-showAll path never hold non-skill `.ok` entries.
        const showOk = url.searchParams.get('showOk') === 'true';
        // Lazy per-directory contract: `?depth=1` yields only the
        // scoped dir's immediate children (each folder stamped `hasChildren`),
        // so the sidebar fetches one level on expand instead of the whole tree.
        // Only `1` is honored; any other value falls through to the full
        // recursive walk. Composes with the showAll cap / single-flight /
        // streaming paths below unchanged.
        const showAllMaxDepth =
          url.searchParams.get('depth') === '1' ? 1 : Number.POSITIVE_INFINITY;

        // Validate dir parameter (reject traversal attempts)
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

        // Streaming Show All Files: when the client negotiates
        // NDJSON, stream the on-demand disk walk one entry per line instead of
        // buffering the whole listing. `streamShowAllEntries` yields one entry
        // at a time, so the server retains O(1) entries — the durable fix for
        // the showAll serialization heap peak that the buffered single-flight
        // path below (plus its entry cap) only bounds. Abort-on-disconnect maps
        // straight onto the response: a client `close` aborts the walk, which
        // bails at the next directory boundary.
        if (showAll && contentFilter && showAllWantsNdjson(req)) {
          const controller = new AbortController();
          // A streaming response has exactly one caller, so its own disconnect
          // is the last (only) waiter leaving — no refcount needed. `writableEnded`
          // gates out the normal-completion `close` so a finished walk is never
          // spuriously marked aborted.
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

          // Honor backpressure so the socket write buffer can't grow to hold the
          // full listing — that buffered copy is exactly what streaming removes.
          // Resolve early on `close` so a stalled or disconnected client never
          // strands the walk awaiting a drain that will never fire.
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
            // Terminal control line. Streamed entries are bare DocumentListEntry
            // objects (always carry `kind`, never `type`); the `type` discriminant
            // marks this completion record so the client can finalize and read the
            // truncation flag the per-entry lines can't carry.
            await writeNdjsonLine(`${JSON.stringify({ type: 'complete', truncated, count })}\n`);
          } catch (err) {
            // Past `writeHead` the status line is already on the wire, so a failure
            // surfaces as a typed mid-stream `{type:'error',problem}` event, not an
            // `errorResponse` (which would try to write a second set of headers).
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

        // Show All Files mode — fresh on-demand disk walk via
        // `ContentFilter.{isExcluded,isDirExcluded}` with `bypassFilters:true`.
        // Returns .gitignored / content-bearing `BUILTIN_SKIP_DIRS` files
        // (`dist/`, `build/`, …), while `.okignore` remains authoritative.
        // The `ALWAYS_SKIP_DIRS` floor (`.git/` / `node_modules/` / `.ok/`) and
        // synthetic system + config doc names remain unbypassable. Per-request
        // only — fileIndex stays populated with the non-bypass set, so the next
        // non-`?showAll=true` call serves today's filtered view unchanged.
        if (showAll && contentFilter) {
          // Single-flight: coalesce concurrent identical walks into one. Key by
          // the already-traversal-validated `dir` (the exact `dirFilter` the
          // walk consumes) plus the depth and showOk markers, so only requests
          // producing the same traversal share one walk and one sorted result.
          // Coalescing across showOk modes would hand one caller the other
          // mode's listing (`.ok` rows leaking to a plain caller, or silently
          // missing for a reveal caller).
          const key = `showAll:${showAllMaxDepth === 1 ? 'd1:' : ''}${showOk ? 'ok:' : ''}${dir ?? ''}`;
          let entry = showAllInflight.get(key);
          if (!entry) {
            const controller = new AbortController();
            // Build the shared promise synchronously — no `await` between the
            // map miss and the `set` below — so a burst of identical requests
            // arriving on the same tick all attach to this entry rather than
            // each starting a walk. The walk owns its accumulator and sorts
            // once, so every coalesced caller serializes the identical result.
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
              // Surface cap saturation so operators can alert and retune
              // `OK_SHOWALL_MAX_ENTRIES` before users notice. Bounded fields
              // (two small integers) — safe on a histogrammed log attribute.
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
            // Evict on settle (success AND error). Guard the delete so a newer
            // entry created under the same key after this one settled is never
            // clobbered.
            void promise.finally(() => {
              if (showAllInflight.get(key) === created) showAllInflight.delete(key);
            });
          }

          // Abort-on-disconnect, refcounted: abort the shared walk only once
          // every attached caller has disconnected (aborting on the first
          // disconnect would strand still-connected co-waiters). `res.on(close)`
          // fires on both normal completion and client disconnect, so
          // `res.writableEnded` gates out the completion case — no spurious
          // abort, no spurious log.
          const attached = entry;
          attached.waiters += 1;
          let released = false;
          const releaseOnDisconnect = () => {
            if (res.writableEnded || released) return;
            released = true;
            attached.waiters -= 1;
            if (attached.waiters <= 0) {
              attached.controller.abort();
              // Drop the doomed walk before it settles so a request arriving in
              // the abort-to-settle window starts a fresh full walk instead of
              // attaching and receiving the partial, aborted result.
              if (showAllInflight.get(key) === attached) showAllInflight.delete(key);
            }
          };
          res.on('close', releaseOnDisconnect);

          try {
            const { documents, truncated } = await attached.promise;
            // This caller already disconnected — its co-waiters (if any) own the
            // walk; writing to a closed socket would throw.
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

        // Read from the watcher's in-memory indexes (instant, no filesystem scan).
        // Use the canonical `DocumentListEntry` type from the schema (sole source
        // of truth) — an inline duplicate of the row shape used to live here and
        // drifted from the schema, which is exactly the schema-vs-server class
        // `successResponse` closes structurally.
        // Enumerate the all-files index so the listing surfaces every tracked
        // file (markdown + non-markdown), not just markdown + referenced assets.
        // `getFileIndex()` stays the source of truth for the referenced-asset
        // pass below (asset collection only resolves links from markdown bodies
        // — never reads `kind:'file'` content). This is one of the three
        // allowlisted all-files call sites (the caller meta-test pre-allowlists
        // `handleDocumentList`). The loop below structurally narrows by
        // `entry.kind === 'markdown'` vs `entry.kind` (the file variant) — the
        // markdown-assuming consumers (`safeContentPath`, backlink wikilink
        // parse, …) NEVER receive a `kind:'file'` row from this site.
        const index = getFileIndex();
        const allFiles = getAllFilesIndex();
        const folderIndex = getFolderIndex?.() ?? new Map<string, FolderIndexEntry>();
        const documents: DocumentListEntry[] = [];

        // Emit folder entries first; client sorts by path so this just primes
        // the array. Empty folders show up only via this index.
        for (const [folderPath, entry] of folderIndex) {
          if (dir && !folderPath.startsWith(`${dir}/`) && folderPath !== dir) continue;
          documents.push({
            kind: 'folder',
            path: folderPath,
            size: 0,
            modified: entry.modified,
            // DocumentListEntry's defaults will resolve the rest; folder entries
            // intentionally omit docName / docExt / asset fields per the
            // refined schema.
            docExt: '.md',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          });
        }

        // Asset references: emit referenced sidebar assets alongside
        // documents so the unified tree can render images / videos discovered
        // through wiki-link or markdown image syntax. Cache keyed off a
        // signature derived from the file index — recomputed only when an
        // indexed page mutates.
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
                // Use `isPathIgnored` (user-configured ignore-file rules
                // + BUILTIN_SKIP_DIRS) rather than `isExcluded` (which
                // also evaluates the sibling-asset heuristic). The
                // sibling heuristic is correct for traversal-time
                // admission but wrong here: an image at
                // `docs/media/diagram.png` referenced from `docs/guide.md`
                // lives in a directory with no `.md` of its own and would
                // be dropped from /api/documents.
                isExcluded: contentFilter ? (rel) => contentFilter.isPathIgnored(rel) : undefined,
              }),
            };
          }
          assets = referencedAssetsCache?.assets ?? [];
        } catch (err) {
          referencedAssetsCache = null;
          log.warn({ err }, '[document-list] asset collection failed; returning documents only');
        }

        // Dedup set: every path emitted as a kind:'asset' entry is suppressed
        // from the kind:'file' all-files pass below. The asset variant carries
        // mediaKind / referencedBy and is what the sidebar's inline-renderable
        // tree decoration keys on, so it wins for renderable assets that the
        // markdown bodies actually reference. Any other non-markdown file falls
        // through to the file variant.
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
            // Filter by dir prefix if specified
            if (dir && !docName.startsWith(`${dir}/`) && docName !== dir) continue;

            // getDocExtension() returns the registered on-disk extension for the
            // docName (or `.md` by default when nothing is yet recorded). Surfacing
            // it to the client lets the sidebar render `foo.mdx` vs `foo.md`
            // faithfully instead of hard-coding `.md`.
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

            // Emit alias entries for this canonical file
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

          // Name-only `kind:'file'` row. The docName key for
          // a non-markdown index entry IS the full contentDir-relative path
          // (extension preserved by `pathToDocName` for non-supported exts).
          // Emit one row per visible alias so symlinked file paths surface
          // alongside the canonical, mirroring the document-side alias loop.
          // Suppress when the same path is already covered by the asset pass
          // (renderable referenced assets win — they carry mediaKind +
          // referencedBy that name-only files can't).
          const passesDir = !dir || docName === dir || docName.startsWith(`${dir}/`);
          if (passesDir && !assetPaths.has(docName)) {
            const assetExt = synthesizeShowAllAssetExt(docName);
            documents.push({
              kind: 'file',
              docName,
              path: docName,
              // `docExt` carries the schema's `.default('.md')` for the document
              // variant; for kind:'file' we mirror the synthesized assetExt so
              // tree-side display sites (extension badges) keep working
              // uniformly across asset/file rows. The dot prefix keeps the
              // shape consistent with kind:'document' (`.md`/`.mdx`).
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

        // Project directory-symlink alias EDGES into the listing. The index holds
        // one edge per symlinked directory (aliasPrefix → canonicalPrefix); here we
        // re-prefix the canonical subtree's rows under each alias prefix at response
        // time — transient, never stored, so the index stays O(symlinks). Alias rows
        // carry `canonicalDocName` so the client opens the canonical Y.Doc: an alias
        // path realpath-resolves to the same inode, so a second Y.Doc keyed by the
        // alias name would fight the canonical over one file on disk.
        const folderAliasIndex = getFolderAliasIndex?.() ?? new Map<string, string>();
        if (folderAliasIndex.size > 0) {
          const passesDirFilter = (p: string): boolean =>
            !dir || p === dir || p.startsWith(`${dir}/`);
          // Group aliases by canonical prefix so the corpus is scanned once even
          // when one directory is symlinked from several places.
          const aliasesByCanonical = new Map<string, string[]>();
          for (const [aliasPrefix, canonicalPrefix] of folderAliasIndex) {
            const arr = aliasesByCanonical.get(canonicalPrefix);
            if (arr) arr.push(aliasPrefix);
            else aliasesByCanonical.set(canonicalPrefix, [aliasPrefix]);
          }
          // Alias folder roots.
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
          // Single pass over folders + files: project each entry under every alias
          // whose canonical prefix is an ancestor of the entry (O(corpus × depth)).
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
            // Enriched index entry: title/icon were derived during the file-watcher
            // seed walk / live disk events from content already read for the hash,
            // so serve from memory — no per-request readFileSync + frontmatter parse.
            title = entry.title;
            icon = entry.icon;
          } else {
            // Bare entry (title absent): fall back to a one-off disk read.
            // See FileIndexEntry.title.
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
    // Every route in this group is a read (none rode the legacy
    // MUTATING_ROUTES loopback/Host gate).
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
    invalidateReferencedAssetsCache,
  };
}
