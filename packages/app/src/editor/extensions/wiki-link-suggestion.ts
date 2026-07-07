import {
  BacklinksSuccessSchema,
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  ForwardLinksSuccessSchema,
  type HeadingEntry,
  MAX_WORKSPACE_SEARCH_LIMIT,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  ProblemDetailsSchema,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
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
import { getEditorSourceMode } from './editor-mode-context';
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
  /** The page slug before `#` (only set in anchor mode). */
  pageTarget: string;
  /** The text after `#` used to filter headings. */
  anchorQuery: string;
}

/**
 * Per-popup cap on rendered suggestion items. Applies uniformly to:
 *   - Page mode, empty query (initial dropdown) — first 8 pages in source order
 *   - Page mode, filtered query — top 8 matches by `searchWorkspaceCorpus`
 *     ranking (BM25 + title boost + recency, intent `autocomplete`)
 *   - Anchor mode — first/top 8 headings of the resolved page
 *
 * The menu surfaces a "Showing top N — keep typing to narrow" footer when the
 * returned items count hits this cap (`items.length >= MAX_ITEMS`), as a
 * passive signal that more matches may exist below the visible set. The cap
 * itself is a UX choice (8 fits a popover without scrolling and gives ranking
 * room to surface the best matches), not a perf gate — the corpus is small
 * and search runs in-memory.
 */
const MAX_ITEMS = 8;

/**
 * Link-graph context for the `[[` page picker, captured once per suggestion
 * session. Drives autocomplete re-ranking: the page being edited and the pages
 * it is connected to (incoming ∪ outgoing links) are the most likely link
 * targets, so they earn a score boost; docs under skill/tooling folders
 * (`.agents` / `.claude` / `.cursor`) are noise in a knowledge-base mention and
 * earn a penalty.
 */
export interface WikiLinkContext {
  /** docName of the page being edited, or null when unknown. */
  currentDocName: string | null;
  /** docNames linked to/from the current page (incoming ∪ outgoing). */
  connectedDocNames: ReadonlySet<string>;
}

const EMPTY_WIKI_LINK_CONTEXT: WikiLinkContext = {
  currentDocName: null,
  connectedDocNames: new Set(),
};

/**
 * Folder names whose docs are agent/editor tooling (skills, rules, configs)
 * rather than knowledge-base content. Matched per path segment so both
 * top-level (`.claude/...`) and nested (`some/subtree/.claude/...`) layouts are
 * caught. Intentionally a narrow, explicit list of agent-tooling folders — not
 * every dot-prefixed segment (`.obsidian`, `.github`, … stay un-penalized) — so
 * this deliberately does NOT reuse the broader `isHiddenDocName` predicate.
 */
const SKILL_FOLDER_SEGMENTS: ReadonlySet<string> = new Set(['.agents', '.claude', '.cursor']);

// Additive adjustments to the autocomplete ranking score. For `intent:
// 'autocomplete'` (no semantic input) that score is `lexical + fullText*20 +
// recency` (recency is 0 here — this corpus carries no modifiedTs), and the
// lexical match brackets are spaced 50 apart (see `lexicalScore` /
// `searchWorkspaceCorpus` in core). So skill penalty ≈ 4 lexical brackets down,
// link-neighbor boost ≈ 2 up, current-page ≈ 1 up. These reorder near-equal
// matches and dominate the empty/weak-query case, but a sufficiently strong
// `fullText` match can still outrank a penalized skill — the intended
// "deprioritized, not hidden" behavior. Tunable.
const SKILL_FOLDER_PENALTY = 200;
const LINK_GRAPH_BOOST = 100;
const CURRENT_PAGE_BOOST = 50;

export function isSkillFolderDoc(docName: string): boolean {
  return docName.split('/').some((segment) => SKILL_FOLDER_SEGMENTS.has(segment));
}

/**
 * Per-doc score adjustment for `[[` autocomplete: deprioritize skill-folder
 * docs, prioritize the current page and its link-graph neighbors. Returns 0 for
 * an ordinary doc with an empty context, so callers without context rank
 * exactly as before.
 */
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
  byPath: ReadonlyMap<string, T>;
  corpus: WorkspaceSearchCorpus;
}

let cachedPageSearchCorpus: SuggestionSearchCorpus<PageItem> | null = null;
let cachedHeadingSearchCorpus: SuggestionSearchCorpus<HeadingEntry> | null = null;

/** Split `query` on the first `#` with a non-empty left side. */
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
    // No query yet (just typed `[[`): order by context boost, with the original
    // page order as a stable tiebreak so an empty context returns the same page
    // references in the same order as `pages.slice(0, MAX_ITEMS)`.
    return pages
      .map((page, index) => ({ page, index, boost: autocompleteBoost(page.docName, context) }))
      .sort((a, b) => b.boost - a.boost || a.index - b.index)
      .slice(0, MAX_ITEMS)
      .map((entry) => entry.page);
  }
  const searchCorpus = getCachedPageSearchCorpus(pages);
  // Pull the full candidate window (not just MAX_ITEMS) so a boosted neighbor
  // ranked just outside the natural top-N can still surface, then re-rank by
  // base score + context boost and trim. With an empty context every boost is 0,
  // so the comparator matches core's own (score desc, path asc) and the trimmed
  // top-N is identical to requesting `limit: MAX_ITEMS` directly.
  return searchWorkspaceCorpus(searchCorpus.corpus, query, {
    intent: 'autocomplete',
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
    .map((entry) => searchCorpus.byPath.get(entry.result.document.path))
    .filter((page) => !!page);
}

function getCachedPageSearchCorpus(pages: readonly PageItem[]): SuggestionSearchCorpus<PageItem> {
  const fingerprint = pages
    .map((page) => `${page.kind ?? 'page'}\u0000${page.docName}\u0000${page.title}`)
    .join('\u0001');
  if (cachedPageSearchCorpus?.fingerprint === fingerprint) return cachedPageSearchCorpus;
  cachedPageSearchCorpus = {
    fingerprint,
    byPath: new Map(pages.map((page) => [page.docName, page])),
    corpus: createWorkspaceSearchCorpus(
      pages.map((page) =>
        createWorkspaceSearchDocument({
          kind: 'page',
          path: page.docName,
          title: page.title,
        }),
      ),
    ),
  };
  return cachedPageSearchCorpus;
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
    byPath: new Map(headings.map((heading) => [heading.slug, heading])),
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
    .map((result) => searchCorpus.byPath.get(result.document.path))
    .filter((heading) => !!heading);
}

export function buildSuggestionItems(
  pages: PageItem[],
  query: string,
  context: WikiLinkContext = EMPTY_WIKI_LINK_CONTEXT,
): WikiLinkSuggestionItem[] {
  const filtered = filterPages(pages, query, context);
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

/**
 * Derive wiki-link attrs from a raw query for fallback insertion — used when
 * Enter is pressed with no item selected. Anchor mode inserts `{ target, anchor }`;
 * page mode falls back to unresolved link attrs (null if query is empty/unslugable).
 *
 * Pure function — exported for testability.
 */
export function computeFallbackAttrs(
  query: string,
): { target: string; alias: string | null; anchor: string | null } | null {
  const { mode, pageTarget, anchorQuery } = parseQuery(query);
  if (mode === 'anchor' && pageTarget) {
    return { target: pageTarget, alias: null, anchor: anchorQuery.trim() || null };
  }
  return buildUnresolvedWikiLinkAttrs(query);
}

/**
 * Custom `findSuggestionMatch` for `@tiptap/suggestion` — detects `[[` paired
 * delimiters using the same regex as the original ProseMirror plugin. The query
 * includes `#` so anchor mode (`page#heading`) works transparently.
 */
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

export async function fetchPages(): Promise<PageItem[]> {
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

  // Folders (`kind:'folder'`) carry no `.md` suffix — their `path` is the
  // workspace-relative folder path the chip serializes to verbatim.
  const folders = docData.documents
    .filter((entry): entry is { kind: 'folder'; path: string } => {
      return entry.kind === 'folder' && typeof entry.path === 'string' && entry.path.length > 0;
    })
    .map((folder): PageItem => {
      const title = folder.path.split('/').pop() ?? folder.path;
      return { kind: 'folder', docName: folder.path, title };
    });

  return [...pages, ...assets, ...folders];
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

/** Outgoing doc-link targets of `docName` (external links excluded). */
async function fetchForwardLinkTargets(docName: string): Promise<string[]> {
  try {
    const r = await fetch(`/api/forward-links?docName=${encodeURIComponent(docName)}`);
    if (!r.ok) {
      // Distinguish a server error from a genuinely linkless page — otherwise a
      // 5xx silently disables ranking on every [[ session with no signal.
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

/** docNames of pages that link to `docName` (incoming links). */
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

/**
 * Capture the current page's link-graph neighbors for autocomplete re-ranking.
 * Never rejects — link context is a ranking nicety, so any failure degrades to
 * "no neighbors" rather than blocking the picker. Shared with the source-mode
 * `[[` completion (`wiki-link-source.ts`) so both surfaces re-rank in lockstep.
 */
export async function loadWikiLinkContext(currentDocName: string | null): Promise<WikiLinkContext> {
  if (!currentDocName) return EMPTY_WIKI_LINK_CONTEXT;
  const [outgoing, incoming] = await Promise.all([
    fetchForwardLinkTargets(currentDocName),
    fetchBacklinkSources(currentDocName),
  ]);
  const connectedDocNames = new Set<string>([...outgoing, ...incoming]);
  // The current page gets its own (separate) boost; don't double-count a self-link.
  connectedDocNames.delete(currentDocName);
  return { currentDocName, connectedDocNames };
}

/**
 * Returns a `@tiptap/suggestion` plugin for wiki-link `[[` autocompletion.
 * Replaces the former hand-rolled ProseMirror Plugin with the same Suggestion
 * framework used by slash commands, plus `onBeforeStart` and
 * `onBeforeUpdate` hooks for per-mode async loading labels.
 */
export function configureWikiLinkSuggestion(editor: Editor) {
  // Mutable closure state — reset in onExit for behavioral parity
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
    // null allows mid-word triggers — safe because [[ is an unambiguous delimiter (unlike single-char /)
    allowedPrefixes: null,
    findSuggestionMatch: wikiLinkMatcher,
    // Gate inside @tiptap/suggestion's apply() reducer keeps `state.active`
    // false in source mode — bridge-propagated `[[` from CodeMirror cannot
    // mount the page picker popup. Signal lives in `editor-mode-context.ts`.
    allow: ({ editor }) => !getEditorSourceMode(editor),

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

      // Page mode — two-flag dedupe. Pages + link context load in parallel so
      // the context fetch doesn't serialize behind the (already awaited) pages
      // fetch; loadWikiLinkContext never rejects, so allSettled keeps shapes
      // uniform without a second try/catch.
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
          // Unreachable today — loadWikiLinkContext catches internally and never
          // rejects. Guards a future contract change so a silent throw can't
          // blank ranking unnoticed.
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
        // Silent failure is intentional — TipTap chains are atomic (single transaction),
        // so partial state (deleteRange applied, insertContent not) cannot occur.
        // User can retry with [[ if needed.
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
        // `hasMore` infers cap-hit from item count rather than tracking the
        // unbounded total alongside (avoids a parallel API mutation across
        // filterPages/filterHeadings/searchWorkspaceCorpus). The inference is
        // exact: `filterPages`/`filterHeadings` always trim to MAX_ITEMS, so
        // `items.length >= MAX_ITEMS` is true exactly when the cap was hit.
        // The lone false-positive shape — page mode falling back to a single
        // `'create'` sentinel — is length 1, well below the cap, so the flag
        // stays false. Skip the hint when the only items are the create-
        // fallback (page mode) to keep the footer aligned with truncation of
        // *real* matches.
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

      /** Fallback: insert a wiki-link from the raw query when no item is selected. */
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

          const result = createSuggestionPopup(() => currentProps, 'wiki-link-suggestion');
          posState.popup = result.popup;
          doPosition = result.doPosition;
          reveal = result.reveal;

          renderer = new ReactRenderer(WikiLinkSuggestionMenu, {
            props: computeMenuProps(props, true, onSelect),
            editor: props.editor,
          });
          result.popup.appendChild(renderer.element);
          // startAutoUpdate after content is in popup — autoUpdate fires
          // doPosition synchronously on setup. Popup remains visibility:hidden
          // until reveal() is called in onStart (after items load) — this
          // prevents the loading-state flash at the wrong position.
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
          // Items have loaded — reveal the popup. reveal() triggers a
          // doPosition pass that measures the populated content (so flip()
          // correctly decides above/below), then unhides on resolution.
          // No separate doPosition call needed — reveal() does it.
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
          // Positioning cleanup first (stop autoUpdate → remove popup DOM)
          destroySuggestionPopup(posState);
          doPosition = null;
          reveal = null;
          // React cleanup last — if destroy() throws, DOM is already clean
          renderer?.destroy();
          renderer = null;
          currentProps = null;
          selectedIndex = 0;
          // Reset cache — each [[ session re-fetches for freshness
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
