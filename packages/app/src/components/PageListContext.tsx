import { toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import {
  buildPageIconsIndex,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  setPageListCache,
} from '@/editor/page-list-cache';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { fetchDocumentListShared } from '@/lib/documents-fetch';
import { parseApiError } from '@/lib/parse-api-error';
import { pageListReady } from '@/lib/perf/startup-marks';
import { deriveKnownFolderPaths } from './navigation-targets';

export interface PageMeta {
  size: number;
  modified: string;
  /**
   * On-disk extension — `.md` or `.mdx`. Surfaced by `/api/pages` so
   * the editor header can render `foo.mdx` vs `foo.md` faithfully
   * instead of hard-coding `.md`. Optional for backward compat.
   */
  docExt?: string;
  /**
   * Raw frontmatter `icon:` value (emoji glyph, URL, or contentDir-
   * rooted path). Render-time classification via `resolvePageIcon` —
   * see `components/page-header-utils.ts`. Surfaced for the wiki-link
   * chip prefix. Undefined when the doc has no `icon:` frontmatter
   * key (or the value is blank).
   */
  icon?: string;
}

interface PageListContextValue {
  /** Set of known docNames (filename without .md extension). */
  pages: Set<string>;
  /**
   * Slug-keyed index mapping `toWikiLinkSlug(docName)` → original docName.
   * First-wins on slug collision. Used by navigation / resolution paths so
   * a dropped `.md` file carrying a lowercased-slug target
   * (e.g. `casecheck123`) resolves against a case-preserved cache entry
   * (e.g. `CaseCheck123`). Without this, `pages.has(slug)` fails every
   * time on non-slug-form docNames.
   */
  pagesBySlug: ReadonlyMap<string, string>;
  /**
   * Basename-keyed index mapping `toWikiLinkSlug(basename(docName))` →
   * original docName. Sibling of `pagesBySlug` that handles bare-name
   * wiki-links pointing at files in subfolders (`[[analysis]]` →
   * `andrew-data/project-x/analysis`). Alphabetical-first on basename
   * collision. Consulted only when exact + slug-of-full-path miss.
   */
  pagesByBasename: ReadonlyMap<string, string>;
  /** Display titles returned by `/api/pages`, keyed by docName. */
  pageTitles: ReadonlyMap<string, string>;
  /** File metadata (size, modified) returned by `/api/pages`, keyed by docName. */
  pageMeta: ReadonlyMap<string, PageMeta>;
  /** Set of known folder paths derived from the current document list. */
  folderPaths: Set<string>;
  /** Referenced image/video assets surfaced by `/api/documents`. */
  assetPaths: Set<string>;
  /**
   * Set of tracked non-markdown, non-asset files surfaced by `/api/documents`
   * via the `kind:'file'` row. Paths are contentDir-
   * relative and include the on-disk extension (e.g. `data/example.csv`,
   * `packages/app/src/index.ts`). The omnibar + dead-link existence check
   * both consume this set so a tracked non-markdown file is findable in ⌘K
   * and its inbound `[[wiki-link]]` / `[text](path)` references no
   * longer render dead.
   */
  filePaths: Set<string>;
  /** True while the page list is being fetched from the server. */
  loading: boolean;
  /** Error message from the most recent fetch failure, or null on success. */
  error: string | null;
  /** Re-fetch the page list from the server. Call after creating a new page. */
  refetch: () => void;
  /** Optimistically mark a page as present before watcher/index propagation settles. */
  addPage: (docName: string) => void;
}

const PageListContext = createContext<PageListContextValue | null>(null);

interface PageSummary {
  docName: string;
  title: string;
  size: number;
  modified: string;
  docExt?: string;
  icon?: string;
}

interface DocumentListEntry {
  kind?: 'document' | 'asset' | 'folder' | 'file';
  path?: string;
}

export function mergePageSets(
  serverPages: ReadonlySet<string>,
  optimisticPages: ReadonlySet<string>,
) {
  if (optimisticPages.size === 0) return new Set(serverPages);
  const merged = new Set(serverPages);
  for (const docName of optimisticPages) merged.add(docName);
  return merged;
}

export function pruneConfirmedOptimisticPages(
  optimisticPages: ReadonlySet<string>,
  serverPages: ReadonlySet<string>,
) {
  if (optimisticPages.size === 0) return new Set<string>();
  const pending = new Set<string>();
  for (const docName of optimisticPages) {
    if (!serverPages.has(docName)) pending.add(docName);
  }
  return pending;
}

function mergePageTitles(
  serverTitles: ReadonlyMap<string, string>,
  optimisticPages: ReadonlySet<string>,
) {
  const merged = new Map(serverTitles);
  for (const docName of optimisticPages) {
    if (!merged.has(docName)) {
      merged.set(docName, docName);
    }
  }
  return merged;
}

async function loadPages(): Promise<PageSummary[]> {
  const r = await fetch('/api/pages');
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as unknown;
    throw new Error(parseApiError(body) ?? `/api/pages responded with ${r.status}`);
  }
  const data: { pages?: PageSummary[] } = await r.json();
  if (Array.isArray(data.pages)) {
    return data.pages;
  }
  return [];
}

async function loadDocumentListSummary(): Promise<{
  assetPaths: string[];
  folderPaths: string[];
  filePaths: string[];
}> {
  // Routed through the shared single-flight so EmptyEditorState + the wiki-link
  // suggestion source don't trigger a parallel `/api/documents` walk on the
  // same tick (boot + every CC1 `files` push). FileTree keeps its own depth-1
  // lazy fetch (different URL) — that consolidation is a separate change.
  const { ok, status, body } = await fetchDocumentListShared();
  if (!ok) {
    throw new Error(parseApiError(body) ?? `/api/documents responded with ${status}`);
  }
  const data = (body ?? {}) as { documents?: DocumentListEntry[] };
  if (!Array.isArray(data.documents)) return { assetPaths: [], folderPaths: [], filePaths: [] };
  const assetPaths = data.documents
    .filter((entry): entry is DocumentListEntry & { kind: 'asset'; path: string } => {
      return entry.kind === 'asset' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((entry) => entry.path);
  const folderPaths = data.documents
    .filter((entry): entry is DocumentListEntry & { kind: 'folder'; path: string } => {
      return entry.kind === 'folder' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((entry) => entry.path);
  // `kind:'file'` rows are the tracked non-markdown,
  // non-referenced-asset files. Pulled into a dedicated set rather than
  // collapsed into `assetPaths` so the "name-only" search hint can distinguish
  // hits whose body the server CAN'T search (file) from referenced assets
  // (asset — still body-less, but already navigationally inferable from
  // their inbound links) and from markdown pages (whose bodies ARE searched).
  const filePaths = data.documents
    .filter((entry): entry is DocumentListEntry & { kind: 'file'; path: string } => {
      return entry.kind === 'file' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((entry) => entry.path);
  return { assetPaths, folderPaths, filePaths };
}

function logLoadPagesError(err: unknown) {
  console.error('[PageListContext] Failed to load pages:', err);
}

function logLoadAssetsError(err: unknown) {
  console.warn('[PageListContext] Failed to load referenced assets:', err);
}

export function PageListProvider({ children }: { children: ReactNode }) {
  const [serverPages, setServerPages] = useState(new Set<string>());
  const [serverPageTitles, setServerPageTitles] = useState(new Map<string, string>());
  const [serverPageMeta, setServerPageMeta] = useState(new Map<string, PageMeta>());
  const [serverAssetPaths, setServerAssetPaths] = useState(new Set<string>());
  const [serverFolderPaths, setServerFolderPaths] = useState(new Set<string>());
  const [serverFilePaths, setServerFilePaths] = useState(new Set<string>());
  const [optimisticPages, setOptimisticPages] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequestIdRef = useRef(0);

  function refetch() {
    const requestId = ++latestRequestIdRef.current;
    // `loading` gates a cold-load skeleton in consumers (e.g. FolderOverview
    // returns a full-view skeleton while it is true). It is intentionally
    // NOT re-raised here: refetch fires on every window focus,
    // visibilitychange, and CC1 `files` push,
    // so re-raising it would tear the entire consuming view down to a
    // skeleton and remount it on each of those — a flicker even though the
    // page list is unchanged. The initial `useState(true)` covers the cold
    // load; background refetches keep serving the last-good `pages` and
    // reconcile in place when the fresh response lands.
    void Promise.all([
      loadPages(),
      loadDocumentListSummary().catch((err) => {
        logLoadAssetsError(err);
        return { assetPaths: [], folderPaths: [], filePaths: [] };
      }),
    ])
      .then(([pageSummaries, documentList]) => {
        if (requestId !== latestRequestIdRef.current) return;
        const pageNames = new Set(pageSummaries.map((page) => page.docName));
        setServerPages(pageNames);
        setServerPageTitles(
          new Map(pageSummaries.map((page) => [page.docName, page.title] as const)),
        );
        setServerPageMeta(
          new Map(
            pageSummaries.map(
              (page) =>
                [
                  page.docName,
                  {
                    size: page.size,
                    modified: page.modified,
                    docExt: page.docExt,
                    icon: page.icon,
                  },
                ] as const,
            ),
          ),
        );
        setServerAssetPaths(new Set(documentList.assetPaths));
        setServerFolderPaths(new Set(documentList.folderPaths));
        setServerFilePaths(new Set(documentList.filePaths));
        setOptimisticPages((prev) => pruneConfirmedOptimisticPages(prev, pageNames));
        setError(null);
        // Startup waterfall: the page-list-ready checkpoint. Stamped in the
        // success branch, not `.finally`, so a failed initial fetch can't mark
        // the list "ready" before it has actually loaded (first-write-wins would
        // then pin the mark optimistically early). Idempotent, so later
        // refetches (focus / CC1 `files` push) don't move it.
        pageListReady();
      })
      .catch((err) => {
        if (requestId !== latestRequestIdRef.current) return;
        logLoadPagesError(err);
        setError(err instanceof Error ? err.message : 'Failed to load pages');
      })
      .finally(() => {
        if (requestId !== latestRequestIdRef.current) return;
        setLoading(false);
      });
  }

  function addPage(docName: string) {
    setOptimisticPages((prev) => {
      if (prev.has(docName)) return prev;
      const next = new Set(prev);
      next.add(docName);
      return next;
    });
    setError(null);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run only on mount
  useEffect(() => {
    void refetch();
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    };
    window.addEventListener('focus', handleResume);
    window.addEventListener('visibilitychange', handleResume);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) {
        refetch();
      }
    });
    return () => {
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('visibilitychange', handleResume);
      unsubscribe();
    };
  }, []);

  const pages = mergePageSets(serverPages, optimisticPages);
  const pageTitles = mergePageTitles(serverPageTitles, optimisticPages);
  const pageMeta: ReadonlyMap<string, PageMeta> = serverPageMeta;
  const assetPaths = serverAssetPaths;
  const filePaths = serverFilePaths;
  const folderPaths = new Set([...deriveKnownFolderPaths(pages), ...serverFolderPaths]);
  const pagesBySlug = buildPagesBySlugIndex(pages, toWikiLinkSlug);
  const pagesByBasename = buildPagesByBasenameIndex(pages, toWikiLinkSlug);
  // Derived icon-only projection of `pageMeta` — published to the
  // page-list-cache side-channel so plain-DOM consumers (wiki-link
  // chip NodeView) read raw icon values without round-tripping
  // through React context. Built every render; `setPageListCache`
  // absorbs no-op writes via map-content equality.
  const pageIcons = buildPageIconsIndex(serverPageMeta);

  // Publish to the page-list-cache side-channel so plain-DOM chip consumers
  // (internal-link.ts / wiki-link.ts NodeView) can read live resolution
  // state without React context. `setPageListCache` absorbs no-op calls via
  // Set-content equality — safe to call every render. `pagesBySlug` is
  // derived from `pages` via `buildPagesBySlugIndex` (first-wins on slug
  // collision) so slug-normalized wiki-link resolution is O(1) in the hot
  // path — dropped `.md` files carry lowercased slugs as targets; the
  // index bridges that to the case-preserved / non-slug-form cache entries.
  useEffect(() => {
    setPageListCache({
      pages,
      folderPaths,
      pagesBySlug,
      pagesByBasename,
      assetPaths,
      filePaths,
      pageIcons,
    });
  }, [pages, folderPaths, pagesBySlug, pagesByBasename, assetPaths, filePaths, pageIcons]);

  return (
    <PageListContext
      value={{
        pages,
        pagesBySlug,
        pagesByBasename,
        pageTitles,
        pageMeta,
        folderPaths,
        assetPaths,
        filePaths,
        loading,
        error,
        refetch,
        addPage,
      }}
    >
      {children}
    </PageListContext>
  );
}

export function usePageList(): PageListContextValue {
  const ctx = use(PageListContext);
  if (!ctx) {
    throw new Error('usePageList must be used within <PageListProvider />');
  }
  return ctx;
}

/**
 * Variant of `usePageList` that returns `null` when no `<PageListProvider />`
 * is mounted, instead of throwing. Use this when a consumer can degrade
 * gracefully — e.g. `SrcAutocomplete` falls back to "no suggestions" in
 * `renderToString` tests that don't mount the provider, rather than crashing
 * the host PropPanel render.
 *
 * Don't reach for this in production code unless the missing-provider case
 * is a real, intentional surface (a portal-rendered modal, a server-side
 * static-output path). For interactive surfaces, prefer mounting the
 * provider — null-return masks a missing-provider bug as a "no data" state.
 */
export function useOptionalPageList(): PageListContextValue | null {
  return use(PageListContext);
}
