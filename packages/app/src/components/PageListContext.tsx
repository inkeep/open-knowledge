import { toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
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
import { createRefreshScheduler } from '@/lib/refresh-scheduler';
import { deriveKnownFolderPaths } from './navigation-targets';

export const PUSH_REFRESH_COALESCE_MS = 300;

export interface PageMeta {
  size: number;
  modified: string;
  docExt?: string;
  icon?: string;
}

interface PageListContextValue {
  pages: Set<string>;
  pagesBySlug: ReadonlyMap<string, string>;
  pagesByBasename: ReadonlyMap<string, string>;
  pageTitles: ReadonlyMap<string, string>;
  pageMeta: ReadonlyMap<string, PageMeta>;
  folderPaths: Set<string>;
  assetPaths: Set<string>;
  filePaths: Set<string>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
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
    return Promise.all([
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
        pageListReady();
      })
      .catch((err) => {
        if (requestId !== latestRequestIdRef.current) return;
        logLoadPagesError(err);
        setError(err instanceof Error ? err.message : t`Failed to load pages`);
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
    const scheduler = createRefreshScheduler(refetch);
    scheduler.request();
    let pushFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        scheduler.request();
      }
    };
    window.addEventListener('focus', handleResume);
    window.addEventListener('visibilitychange', handleResume);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (!channels.includes('files')) return;
      if (pushFlushTimer !== null) return;
      pushFlushTimer = setTimeout(() => {
        pushFlushTimer = null;
        scheduler.request();
      }, PUSH_REFRESH_COALESCE_MS);
    });
    return () => {
      if (pushFlushTimer !== null) clearTimeout(pushFlushTimer);
      scheduler.dispose();
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
  const pageIcons = buildPageIconsIndex(serverPageMeta);

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

export function useOptionalPageList(): PageListContextValue | null {
  return use(PageListContext);
}
