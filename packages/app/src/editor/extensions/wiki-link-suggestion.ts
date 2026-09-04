import {
  BacklinksSuccessSchema,
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  ForwardLinksSuccessSchema,
  type HeadingEntry,
  isHiddenDocName,
  MAX_WORKSPACE_SEARCH_LIMIT,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  ProblemDetailsSchema,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchKind,
} from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { fetchDocumentListShared } from '@/lib/documents-fetch';
import { HttpResponseParseError } from '../http-client';
import { WikiLinkSuggestionMenu } from '../wiki-link-suggestion/WikiLinkSuggestionMenu';
import { getEditorDocName } from './doc-context';
import { suggestionAllow } from './suggestion-allow';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from './suggestion-floating-ui';
import { buildUnresolvedWikiLinkAttrs } from './wiki-link-helpers';

export const wikiLinkSuggestionKey = new PluginKey('wikiLinkSuggestion');

export interface PageItem {
  kind?: 'page' | 'asset' | 'folder';
  docName: string;
  title: string;
}

export type WikiLinkSuggestionItem =
  | { kind: 'page'; docName: string; title: string }
  | { kind: 'asset'; target: string; path: string; title: string }
  | { kind: 'create'; docName: string; title: string; actionLabel: string }
  | { kind: 'anchor'; docName: string; level: number; text: string; slug: string };

interface ParsedQuery {
  mode: 'page' | 'anchor';
  pageTarget: string;
  anchorQuery: string;
}

const MAX_ITEMS = 8;

export interface WikiLinkContext {
  currentDocName: string | null;
  connectedDocNames: ReadonlySet<string>;
}

const EMPTY_WIKI_LINK_CONTEXT: WikiLinkContext = {
  currentDocName: null,
  connectedDocNames: new Set(),
};

const SKILL_FOLDER_SEGMENTS: ReadonlySet<string> = new Set(['.agents', '.claude', '.cursor']);

const SKILL_FOLDER_PENALTY = 200;
const LINK_GRAPH_BOOST = 100;
const CURRENT_PAGE_BOOST = 50;

export function isSkillFolderDoc(docName: string): boolean {
  return docName.split('/').some((segment) => SKILL_FOLDER_SEGMENTS.has(segment));
}

export function autocompleteBoost(docName: string, context: WikiLinkContext): number {
  let boost = 0;
  if (isSkillFolderDoc(docName)) boost -= SKILL_FOLDER_PENALTY;
  if (context.currentDocName !== null && docName === context.currentDocName) {
    boost += CURRENT_PAGE_BOOST;
  } else if (context.connectedDocNames.has(docName)) {
    boost += LINK_GRAPH_BOOST;
  }
  return boost;
}

interface SuggestionSearchCorpus<T> {
  fingerprint: string;
  byId: ReadonlyMap<string, T>;
  corpus: WorkspaceSearchCorpus;
}

const PAGE_SEARCH_CORPUS_CACHE_SLOTS = 2;
const cachedPageSearchCorpora = new Map<string, SuggestionSearchCorpus<PageItem>>();
let cachedHeadingSearchCorpus: SuggestionSearchCorpus<HeadingEntry> | null = null;

export function parseQuery(query: string): ParsedQuery {
  const hashIdx = query.indexOf('#');
  if (hashIdx > 0) {
    return {
      mode: 'anchor',
      pageTarget: query.slice(0, hashIdx),
      anchorQuery: query.slice(hashIdx + 1),
    };
  }
  return { mode: 'page', pageTarget: '', anchorQuery: '' };
}

export function filterPages(
  pages: PageItem[],
  query: string,
  context: WikiLinkContext = EMPTY_WIKI_LINK_CONTEXT,
): PageItem[] {
  if (!query) {
    return pages
      .map((page, index) => ({ page, index, boost: autocompleteBoost(page.docName, context) }))
      .sort((a, b) => b.boost - a.boost || a.index - b.index)
      .slice(0, MAX_ITEMS)
      .map((entry) => entry.page);
  }
  const searchCorpus = getCachedPageSearchCorpus(pages);
  return searchWorkspaceCorpus(searchCorpus.corpus, query, {
    intent: 'autocomplete',
    scopes: ['page', 'folder', 'file'],
    limit: MAX_WORKSPACE_SEARCH_LIMIT,
  })
    .map((result) => ({
      result,
      adjusted: result.score + autocompleteBoost(result.document.path, context),
    }))
    .sort(
      (a, b) =>
        b.adjusted - a.adjusted || a.result.document.path.localeCompare(b.result.document.path),
    )
    .slice(0, MAX_ITEMS)
    .map((entry) => searchCorpus.byId.get(entry.result.document.id))
    .filter((page) => !!page);
}

function pageSearchKind(item: PageItem): WorkspaceSearchKind {
  if (item.kind === 'folder') return 'folder';
  if (item.kind === 'asset') return 'file';
  return 'page';
}

function getCachedPageSearchCorpus(pages: readonly PageItem[]): SuggestionSearchCorpus<PageItem> {
  const fingerprint = pages
    .map((page) => `${page.kind ?? 'page'}\u0000${page.docName}\u0000${page.title}`)
    .join('\u0001');
  const cached = cachedPageSearchCorpora.get(fingerprint);
  if (cached) {
    cachedPageSearchCorpora.delete(fingerprint);
    cachedPageSearchCorpora.set(fingerprint, cached);
    return cached;
  }
  const built: SuggestionSearchCorpus<PageItem> = {
    fingerprint,
    byId: new Map(pages.map((page) => [`${pageSearchKind(page)}:${page.docName}`, page])),
    corpus: createWorkspaceSearchCorpus(
      pages.map((page) =>
        createWorkspaceSearchDocument({
          kind: pageSearchKind(page),
          path: page.docName,
          title: page.title,
        }),
      ),
    ),
  };
  cachedPageSearchCorpora.set(fingerprint, built);
  while (cachedPageSearchCorpora.size > PAGE_SEARCH_CORPUS_CACHE_SLOTS) {
    const oldest = cachedPageSearchCorpora.keys().next().value;
    if (oldest === undefined) break;
    cachedPageSearchCorpora.delete(oldest);
  }
  return built;
}

function getCachedHeadingSearchCorpus(
  headings: readonly HeadingEntry[],
): SuggestionSearchCorpus<HeadingEntry> {
  const fingerprint = headings
    .map((heading) => `${heading.slug}\u0000${heading.level}\u0000${heading.text}`)
    .join('\u0001');
  if (cachedHeadingSearchCorpus?.fingerprint === fingerprint) return cachedHeadingSearchCorpus;
  cachedHeadingSearchCorpus = {
    fingerprint,
    byId: new Map(headings.map((heading) => [`page:${heading.slug}`, heading])),
    corpus: createWorkspaceSearchCorpus(
      headings.map((heading) =>
        createWorkspaceSearchDocument({
          kind: 'page',
          path: heading.slug,
          title: heading.text,
        }),
      ),
    ),
  };
  return cachedHeadingSearchCorpus;
}

export function filterHeadings(headings: HeadingEntry[], anchorQuery: string): HeadingEntry[] {
  if (!anchorQuery) return headings.slice(0, MAX_ITEMS);
  const searchCorpus = getCachedHeadingSearchCorpus(headings);
  return searchWorkspaceCorpus(searchCorpus.corpus, anchorQuery, {
    intent: 'autocomplete',
    limit: MAX_ITEMS,
  })
    .map((result) => searchCorpus.byId.get(result.document.id))
    .filter((heading) => !!heading);
}

export function buildSuggestionItems(
  pages: PageItem[],
  query: string,
  context: WikiLinkContext = EMPTY_WIKI_LINK_CONTEXT,
): WikiLinkSuggestionItem[] {
  const filtered = filterPages(pages, query, context).filter((item) => item.kind !== 'folder');
  if (filtered.length > 0) {
    return filtered.map((item) =>
      item.kind === 'asset'
        ? {
            kind: 'asset',
            target: item.docName,
            path: item.docName.replace(/^\//, ''),
            title: item.title,
          }
        : { kind: 'page', docName: item.docName, title: item.title },
    );
  }

  const attrs = buildUnresolvedWikiLinkAttrs(query);
  if (!attrs) return [];

  return [
    {
      kind: 'create',
      docName: attrs.target,
      title: query.trim(),
      actionLabel: `Insert unresolved link "${query.trim()}"`,
    },
  ];
}

export function buildAnchorItems(
  docName: string,
  headings: HeadingEntry[],
  anchorQuery: string,
): WikiLinkSuggestionItem[] {
  return filterHeadings(headings, anchorQuery).map((h) => ({
    kind: 'anchor',
    docName,
    level: h.level,
    text: h.text,
    slug: h.slug,
  }));
}

export function computeFallbackAttrs(
  query: string,
): { target: string; alias: string | null; anchor: string | null } | null {
  const { mode, pageTarget, anchorQuery } = parseQuery(query);
  if (mode === 'anchor' && pageTarget) {
    return { target: pageTarget, alias: null, anchor: anchorQuery.trim() || null };
  }
  return buildUnresolvedWikiLinkAttrs(query);
}

export function wikiLinkMatcher(config: {
  $position: ResolvedPos;
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const { $position } = config;
  const textBefore = $position.parent.textBetween(0, $position.parentOffset, undefined, '\ufffc');
  const match = textBefore.match(/\[\[([^\]]*)$/);
  if (!match) return null;

  const query = match[1];
  const blockStart = $position.start();
  const triggerPos = blockStart + textBefore.lastIndexOf('[[');

  return {
    range: { from: triggerPos, to: $position.pos },
    query,
    text: match[0],
  };
}

export interface FetchPagesOptions {
  includeFolders?: boolean;
}

export async function fetchPages(options: FetchPagesOptions = {}): Promise<PageItem[]> {
  const r = await fetch('/api/pages');
  let body: unknown;
  try {
    body = await r.json();
  } catch (cause) {
    throw new HttpResponseParseError('Pages response was not JSON', {
      cause,
      status: r.status,
    });
  }
  if (!r.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    throw new Error(problem.success ? problem.data.title : `/api/pages responded with ${r.status}`);
  }
  const success = PagesSuccessSchema.safeParse(body);
  if (!success.success) {
    console.warn('[wiki-link-suggestion] /api/pages response schema drift:', success.error);
    return [];
  }
  const pages: PageItem[] = success.data.pages.map((page) => ({
    kind: 'page',
    docName: page.docName,
    title: page.title,
  }));

  let docData: { documents?: Array<{ kind?: string; path?: string }> };
  try {
    const { ok, status, body } = await fetchDocumentListShared();
    if (!ok) {
      console.warn('[wiki-link-suggestion] /api/documents responded with', status);
      return pages;
    }
    docData = (body ?? {}) as { documents?: Array<{ kind?: string; path?: string }> };
    if (!Array.isArray(docData.documents)) return pages;
  } catch (err) {
    console.warn('[wiki-link-suggestion] Failed to fetch referenced assets:', err);
    return pages;
  }

  const assets = docData.documents
    .filter((entry): entry is { kind: 'asset'; path: string } => {
      return entry.kind === 'asset' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((asset): PageItem => {
      const title = asset.path.split('/').pop() ?? asset.path;
      return { kind: 'asset', docName: `/${asset.path}`, title };
    });

  const files = docData.documents
    .filter((entry): entry is { kind: 'file'; path: string } => {
      return (
        entry.kind === 'file' &&
        typeof entry.path === 'string' &&
        entry.path.length > 0 &&
        !isHiddenDocName(entry.path)
      );
    })
    .map((file): PageItem => {
      const title = file.path.split('/').pop() ?? file.path;
      return { kind: 'asset', docName: `/${file.path}`, title };
    });

  if (!options.includeFolders) return [...pages, ...assets, ...files];

  const folders = docData.documents
    .filter((entry): entry is { kind: 'folder'; path: string } => {
      return entry.kind === 'folder' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((folder): PageItem => {
      const title = folder.path.split('/').pop() ?? folder.path;
      return { kind: 'folder', docName: folder.path, title };
    });

  return [...pages, ...assets, ...files, ...folders];
}

export async function fetchHeadings(docName: string): Promise<HeadingEntry[]> {
  const r = await fetch(`/api/page-headings?docName=${encodeURIComponent(docName)}`);
  let body: unknown;
  try {
    body = await r.json();
  } catch (cause) {
    throw new HttpResponseParseError('Page headings response was not JSON', {
      cause,
      status: r.status,
    });
  }
  if (!r.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    throw new Error(
      problem.success ? problem.data.title : `/api/page-headings responded with ${r.status}`,
    );
  }
  const success = PageHeadingsSuccessSchema.safeParse(body);
  if (!success.success) {
    console.warn('[wiki-link-suggestion] /api/page-headings response schema drift:', success.error);
    return [];
  }
  return success.data.headings ?? [];
}

async function fetchForwardLinkTargets(docName: string): Promise<string[]> {
  try {
    const r = await fetch(`/api/forward-links?docName=${encodeURIComponent(docName)}`);
    if (!r.ok) {
      console.warn('[wiki-link-suggestion] /api/forward-links responded', r.status, docName);
      return [];
    }
    const success = ForwardLinksSuccessSchema.safeParse(await r.json());
    if (!success.success) return [];
    return success.data.forwardLinks.flatMap((link) => (link.kind === 'doc' ? [link.docName] : []));
  } catch (err) {
    console.warn('[wiki-link-suggestion] Failed to fetch forward links:', err);
    return [];
  }
}

async function fetchBacklinkSources(docName: string): Promise<string[]> {
  try {
    const r = await fetch(`/api/backlinks?docName=${encodeURIComponent(docName)}`);
    if (!r.ok) {
      console.warn('[wiki-link-suggestion] /api/backlinks responded', r.status, docName);
      return [];
    }
    const success = BacklinksSuccessSchema.safeParse(await r.json());
    if (!success.success) return [];
    return success.data.backlinks.map((link) => link.source);
  } catch (err) {
    console.warn('[wiki-link-suggestion] Failed to fetch backlinks:', err);
    return [];
  }
}

export async function loadWikiLinkContext(currentDocName: string | null): Promise<WikiLinkContext> {
  if (!currentDocName) return EMPTY_WIKI_LINK_CONTEXT;
  const [outgoing, incoming] = await Promise.all([
    fetchForwardLinkTargets(currentDocName),
    fetchBacklinkSources(currentDocName),
  ]);
  const connectedDocNames = new Set<string>([...outgoing, ...incoming]);
  connectedDocNames.delete(currentDocName);
  return { currentDocName, connectedDocNames };
}

export function configureWikiLinkSuggestion(editor: Editor) {
  let cachedPages: PageItem[] = [];
  let pagesLoaded = false;
  let pagesPromise: Promise<PageItem[]> | null = null;
  let cachedContext: WikiLinkContext = EMPTY_WIKI_LINK_CONTEXT;
  let contextPromise: Promise<WikiLinkContext> | null = null;
  let cachedHeadings = new Map<string, HeadingEntry[]>();
  let anchorFetchingFor: string | null = null;
  let fetchError: string | null = null;
  let anchorFetchError: string | null = null;

  return Suggestion<WikiLinkSuggestionItem>({
    editor,
    pluginKey: wikiLinkSuggestionKey,
    char: '[[',
    allowedPrefixes: null,
    findSuggestionMatch: wikiLinkMatcher,
    allow: suggestionAllow,

    items: async ({ query }) => {
      const { mode, pageTarget, anchorQuery } = parseQuery(query);

      if (mode === 'anchor') {
        if (!cachedHeadings.has(pageTarget) && anchorFetchingFor !== pageTarget) {
          anchorFetchingFor = pageTarget;
          try {
            const headings = await fetchHeadings(pageTarget);
            cachedHeadings.set(pageTarget, headings);
            anchorFetchError = null;
          } catch (err) {
            console.error('[wiki-link-suggestion] Failed to fetch headings:', err);
            cachedHeadings.set(pageTarget, []);
            anchorFetchError = `Failed to load headings for ${pageTarget}. Press Escape and type [[ again to retry.`;
          } finally {
            anchorFetchingFor = null;
          }
        }
        const headings = cachedHeadings.get(pageTarget) ?? [];
        return buildAnchorItems(pageTarget, headings, anchorQuery);
      }

      if (!pagesLoaded) {
        pagesPromise ||= fetchPages();
        contextPromise ||= loadWikiLinkContext(getEditorDocName(editor));
        const [pagesResult, contextResult] = await Promise.allSettled([
          pagesPromise,
          contextPromise,
        ]);
        if (pagesResult.status === 'fulfilled') {
          cachedPages = pagesResult.value;
          fetchError = null;
        } else {
          console.error('[wiki-link-suggestion] Failed to fetch pages:', pagesResult.reason);
          fetchError =
            'Failed to load pages. Press Escape and type [[ again to retry, or continue typing to insert an unresolved link.';
          cachedPages = [];
        }
        if (contextResult.status === 'fulfilled') {
          cachedContext = contextResult.value;
        } else {
          console.warn('[wiki-link-suggestion] link context load rejected:', contextResult.reason);
          cachedContext = EMPTY_WIKI_LINK_CONTEXT;
        }
        pagesLoaded = true;
        pagesPromise = null;
        contextPromise = null;
      }
      return buildSuggestionItems(cachedPages, query, cachedContext);
    },

    command: ({ editor, range, props: item }) => {
      try {
        let attrs: { target: string; alias: string | null; anchor: string | null } | null = null;

        if (item.kind === 'page') {
          attrs = { target: item.docName, alias: null, anchor: null };
        } else if (item.kind === 'asset') {
          attrs = { target: item.target, alias: item.title, anchor: null };
        } else if (item.kind === 'anchor') {
          attrs = { target: item.docName, alias: null, anchor: item.slug };
        } else if (item.kind === 'create') {
          attrs = buildUnresolvedWikiLinkAttrs(item.title);
        }

        if (!attrs) return;

        editor.chain().focus().deleteRange(range).insertContent({ type: 'wikiLink', attrs }).run();
      } catch (err) {
        console.error('[wiki-link-suggestion] command failed', { item, range }, err);
      }
    },

    render: () => {
      let renderer: ReactRenderer<typeof WikiLinkSuggestionMenu> | null = null;
      let currentProps: SuggestionProps<WikiLinkSuggestionItem> | null = null;
      let selectedIndex = 0;
      const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };

      let doPosition: (() => void) | null = null;
      let reveal: (() => void) | null = null;

      const onSelect = (item: WikiLinkSuggestionItem) => {
        currentProps?.command(item);
      };

      function computeMenuProps(
        props: SuggestionProps<WikiLinkSuggestionItem>,
        loadingOverride: boolean | null,
        onSelectCb: (item: WikiLinkSuggestionItem) => void,
      ) {
        const { mode, pageTarget, anchorQuery } = parseQuery(props.query ?? '');
        const loading =
          loadingOverride !== null
            ? loadingOverride
            : mode === 'anchor'
              ? !cachedHeadings.has(pageTarget)
              : !pagesLoaded;
        const items = props.items ?? [];
        const onlyCreateFallback = items.length === 1 && items[0]?.kind === 'create';
        return {
          items,
          query: props.query ?? '',
          selectedIndex,
          onSelect: onSelectCb,
          loading,
          error: mode === 'page' ? fetchError : anchorFetchError,
          mode,
          pageTarget,
          anchorQuery,
          hasMore: !onlyCreateFallback && items.length >= MAX_ITEMS,
        };
      }

      const rerender = (loadingOverride: boolean | null) => {
        if (!renderer || !currentProps) return;
        renderer.updateProps(computeMenuProps(currentProps, loadingOverride, onSelect));
      };

      const fallbackInsert = () => {
        if (!currentProps) return;
        const { editor, range } = currentProps;
        const attrs = computeFallbackAttrs(currentProps.query ?? '');
        if (!attrs) return;

        try {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: 'wikiLink', attrs })
            .run();
        } catch (err) {
          console.error('[wiki-link-suggestion] fallback insert error:', err);
        }
      };

      return {
        onBeforeStart(props: SuggestionProps<WikiLinkSuggestionItem>) {
          currentProps = props;
          selectedIndex = 0;

          const result = createSuggestionPopup(() => currentProps, 'wiki-link-suggestion', {
            clipToEditorPane: true,
          });
          posState.popup = result.popup;
          doPosition = result.doPosition;
          reveal = result.reveal;

          renderer = new ReactRenderer(WikiLinkSuggestionMenu, {
            props: computeMenuProps(props, true, onSelect),
            editor: props.editor,
          });
          result.popup.appendChild(renderer.element);
          posState.stopAutoUpdate = result.startAutoUpdate();
        },

        onBeforeUpdate(props: SuggestionProps<WikiLinkSuggestionItem>) {
          const prevMode = currentProps ? parseQuery(currentProps.query ?? '').mode : null;
          const nextMode = parseQuery(props.query ?? '').mode;
          currentProps = props;
          if (prevMode !== nextMode) {
            selectedIndex = 0;
            rerender(true);
          }
        },

        onStart(props: SuggestionProps<WikiLinkSuggestionItem>) {
          currentProps = props;
          selectedIndex = 0;
          rerender(null);
          reveal?.();
        },

        onUpdate(props: SuggestionProps<WikiLinkSuggestionItem>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
          rerender(null);
          doPosition?.();
        },

        onKeyDown({ event }: SuggestionKeyDownProps) {
          if (!currentProps) return false;
          const items = currentProps.items;

          if (event.key === 'ArrowDown') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex + 1) % items.length;
            rerender(null);
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            rerender(null);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[selectedIndex];
            if (item) {
              currentProps.command(item);
            } else {
              fallbackInsert();
            }
            return true;
          }
          if (event.key === 'Escape') {
            return false;
          }
          return false;
        },

        onExit() {
          destroySuggestionPopup(posState);
          doPosition = null;
          reveal = null;
          renderer?.destroy();
          renderer = null;
          currentProps = null;
          selectedIndex = 0;
          cachedPages = [];
          cachedContext = EMPTY_WIKI_LINK_CONTEXT;
          cachedHeadings = new Map();
          fetchError = null;
          anchorFetchError = null;
          pagesLoaded = false;
          pagesPromise = null;
          contextPromise = null;
          anchorFetchingFor = null;
        },
      };
    },
  });
}
