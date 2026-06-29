import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { classifyWikiLinkTarget, type HeadingEntry } from '@inkeep/open-knowledge-core';
import { hashFromAssetPath, hashFromDocName } from '../../lib/doc-hash';
import { resolveWikiLinkAssetTarget } from '../extensions/wiki-link-helpers';
import {
  fetchHeadings,
  fetchPages,
  filterHeadings,
  filterPages,
  loadWikiLinkContext,
  type PageItem,
  type WikiLinkContext,
} from '../extensions/wiki-link-suggestion';
import {
  openHashHrefInNewTab,
  openInternalHashHrefInNewTab,
  shouldOpenInNewTab,
} from '../internal-link-helpers';


const PAGES_CACHE_TTL_MS = 5_000;

let pagesCache: PageItem[] | null = null;
let pagesCacheTime = 0;
let knownTargetSet: Set<string> | null = null;
const headingsCache = new Map<string, { headings: HeadingEntry[]; time: number }>();
const contextCache = new Map<string, { context: WikiLinkContext; time: number }>();

async function getWikiLinkContext(docName: string | null): Promise<WikiLinkContext> {
  if (!docName) return loadWikiLinkContext(null);
  const now = Date.now();
  const cached = contextCache.get(docName);
  if (cached !== undefined && now - cached.time < PAGES_CACHE_TTL_MS) return cached.context;
  const context = await loadWikiLinkContext(docName);
  contextCache.set(docName, { context, time: now });
  return context;
}

async function getPages(): Promise<PageItem[]> {
  const now = Date.now();
  if (pagesCache && now - pagesCacheTime < PAGES_CACHE_TTL_MS) return pagesCache;
  pagesCache = await fetchPages();
  pagesCacheTime = now;
  knownTargetSet = buildKnownWikilinkTargetSet(pagesCache);
  return pagesCache;
}

async function getHeadings(docName: string): Promise<HeadingEntry[]> {
  const now = Date.now();
  const cached = headingsCache.get(docName);
  if (cached !== undefined && now - cached.time < PAGES_CACHE_TTL_MS) {
    return cached.headings;
  }
  try {
    const h = await fetchHeadings(docName);
    headingsCache.set(docName, { headings: h, time: now });
    return h;
  } catch (err) {
    console.warn('[wiki-link-source] /api/page-headings fetch failed:', err);
    headingsCache.set(docName, { headings: [], time: now });
    return [];
  }
}


const WIKI_LINK_RE = /\[\[[^\]]*?\]\]/g;
const wikiLinkMark = Decoration.mark({ class: 'cm-wiki-link' });
const wikiLinkBrokenMark = Decoration.mark({
  class: 'cm-wiki-link cm-wiki-link-broken',
});

/** Build a lowercase Set of known page names (docName + title) for O(1) lookup.
 * Exported for unit tests — the plugin uses it internally. */
export function buildPageNameSet(pages: PageItem[]): Set<string> {
  const s = new Set<string>();
  for (const p of pages) {
    s.add(p.docName.toLowerCase());
    if (p.title) s.add(p.title.toLowerCase());
    if (p.kind === 'asset') {
      const path = p.docName.replace(/^\//, '');
      s.add(path.toLowerCase());
      const slash = path.lastIndexOf('/');
      s.add((slash === -1 ? path : path.slice(slash + 1)).toLowerCase());
    }
  }
  return s;
}

export function buildKnownWikilinkTargetSet(pages: PageItem[]): Set<string> {
  const s = buildPageNameSet(pages);
  for (const page of pages) {
    if (page.kind === 'asset') continue;
    const segments = page.docName.split('/');
    segments.pop();
    let folderPath = '';
    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      s.add(folderPath.toLowerCase());
    }
  }
  return s;
}

/** Extract the target page name from a wikilink's inner text (the part between
 * `[[` and `]]`). Strips optional `#anchor` and `|alias`, normalizes to lowercase.
 * Returns the empty string for empty or whitespace-only inner text.
 * Exported for unit tests. */
export function extractWikilinkTarget(inner: string): string {
  return inner.split(/[#|]/)[0].trim().toLowerCase();
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const targetSet = pagesCache ? knownTargetSet : null;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    WIKI_LINK_RE.lastIndex = 0;
    let m = WIKI_LINK_RE.exec(text);
    while (m !== null) {
      let mark = wikiLinkMark;
      if (targetSet) {
        const target = extractWikilinkTarget(m[0].slice(2, -2)); // strip [[ and ]]
        if (target && !targetSet.has(target)) {
          mark = wikiLinkBrokenMark;
        }
      }
      builder.add(from + m.index, from + m.index + m[0].length, mark);
      m = WIKI_LINK_RE.exec(text);
    }
  }
  return builder.finish();
}

const wikiLinkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private cacheWarmAtBuild: boolean;

    constructor(view: EditorView) {
      this.cacheWarmAtBuild = pagesCache !== null;
      this.decorations = buildDecorations(view);
      if (!this.cacheWarmAtBuild) this.warmCache(view);
    }

    update(update: ViewUpdate) {
      const cacheNowWarm = pagesCache !== null;
      if (update.docChanged || update.viewportChanged || (!this.cacheWarmAtBuild && cacheNowWarm)) {
        this.cacheWarmAtBuild = cacheNowWarm;
        this.decorations = buildDecorations(update.view);
      }
    }

    private warmCache(view: EditorView) {
      getPages()
        .then(() => {
          try {
            view.dispatch({});
          } catch {
          }
        })
        .catch((err) => {
          console.warn('[wiki-link-source] warmCache fetch failed:', err);
        });
    }
  },
  { decorations: (v) => v.decorations },
);


const WIKI_LINK_FULL_RE = /\[\[([^[\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

const wikiLinkClickHandler = EditorView.domEventHandlers({
  mousedown(event: MouseEvent, view: EditorView) {
    if (!event.ctrlKey && !event.metaKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const line = view.state.doc.lineAt(pos);
    WIKI_LINK_FULL_RE.lastIndex = 0;
    let m = WIKI_LINK_FULL_RE.exec(line.text);
    while (m !== null) {
      const start = line.from + m.index;
      const end = start + m[0].length;
      if (pos >= start && pos <= end) {
        const target = m[1]?.trim();
        const anchor = m[2]?.trim() || null;
        if (target) {
          const classified = classifyWikiLinkTarget(target, anchor);
          if (!classified) return false;
          event.preventDefault();
          if (classified.kind === 'external') {
            openHashHrefInNewTab(classified.url);
          } else if (classified.kind === 'asset') {
            const assetPath =
              resolveWikiLinkAssetTarget(
                classified.url,
                new Set(
                  (pagesCache ?? [])
                    .filter((item) => item.kind === 'asset')
                    .map((item) => item.docName.replace(/^\//, '')),
                ),
              ) ?? classified.url.replace(/^\//, '');
            if (shouldOpenInNewTab(event)) {
              window.open(hashFromAssetPath(assetPath), '_blank', 'noopener,noreferrer');
            } else {
              window.location.hash = hashFromAssetPath(assetPath);
            }
          } else if (shouldOpenInNewTab(event)) {
            openInternalHashHrefInNewTab(classified);
          } else {
            window.location.hash = hashFromDocName(classified.docName, classified.anchor);
          }
        }
        return true;
      }
      m = WIKI_LINK_FULL_RE.exec(line.text);
    }
    return false;
  },
});


async function wikiLinkCompletionSource(
  context: CompletionContext,
  currentDocName: string | null,
): Promise<CompletionResult | null> {
  const textBefore = context.state.doc.sliceString(0, context.pos);

  const match = textBefore.match(/\[\[([^\]]*)$/);
  if (!match) return null;

  const query = match[1];
  const triggerPos = context.pos - query.length; // position right after [[
  const hashIdx = query.indexOf('#');

  if (hashIdx > 0) {
    const pageTarget = query.slice(0, hashIdx);
    const anchorQuery = query.slice(hashIdx + 1);
    const anchorPos = triggerPos + hashIdx + 1; // position right after #

    const headings = await getHeadings(pageTarget);
    if (!headings.length) return null;

    const filtered = filterHeadings(headings, anchorQuery);
    if (!filtered.length) return null;

    return {
      from: anchorPos,
      filter: false,
      options: filtered.map((h) => ({
        label: h.text,
        detail: `H${h.level}`,
        apply(view: EditorView, _c: unknown, from: number, to: number) {
          const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
          view.dispatch({
            changes: { from, to, insert: h.slug + suffix },
            selection: { anchor: from + h.slug.length + suffix.length },
          });
        },
      })),
    };
  }

  const [pages, linkContext] = await Promise.all([
    getPages().catch((err) => {
      console.warn('[wiki-link-source] Failed to fetch pages:', err);
      return [] as PageItem[];
    }),
    getWikiLinkContext(currentDocName),
  ]);
  const filtered = filterPages(pages, query, linkContext);

  return {
    from: triggerPos,
    filter: false,
    options: filtered.map((p) => ({
      label: p.title,
      detail: p.title !== p.docName ? p.docName : undefined,
      apply(view: EditorView, _c: unknown, from: number, to: number) {
        const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
        const insert = p.kind === 'asset' ? `${p.docName}|${p.title}${suffix}` : p.docName + suffix;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      },
    })),
  };
}


const wikiLinkTheme = EditorView.theme({
  '.cm-wiki-link': {
    color: 'oklch(52.7% 0.154 228.4)', // sky-700
    fontWeight: '500',
  },
  '.cm-wiki-link:hover': {
    textDecoration: 'underline',
    cursor: 'pointer',
  },
});


export function createWikiLinkSourceExtension(currentDocName: string | null = null): Extension {
  return [
    wikiLinkDecorations,
    wikiLinkClickHandler,
    wikiLinkTheme,
    markdownLanguage.data.of({
      autocomplete: (context: CompletionContext) =>
        wikiLinkCompletionSource(context, currentDocName),
    }),
  ];
}
