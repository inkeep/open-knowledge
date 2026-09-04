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
import {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  type HeadingEntry,
  resolveWikiLinkTarget,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import { openExternalUrl } from '@/lib/external-link';
import { hashFromAssetPath, hashFromDocName } from '../../lib/doc-hash';
import { resolveWikiLinkAssetTarget, toWikiLinkSlug } from '../extensions/wiki-link-helpers';
import {
  fetchHeadings,
  fetchPages,
  filterHeadings,
  filterPages,
  loadWikiLinkContext,
  type PageItem,
  type WikiLinkContext,
} from '../extensions/wiki-link-suggestion';
import { openHashHrefInNewTab, shouldOpenInNewTab } from '../internal-link-helpers';
import {
  isLinkValidationVisible,
  subscribeToLinkValidationPolicy,
} from '../link-validation-policy';

const PAGES_CACHE_TTL_MS = 5_000;

let pagesCache: PageItem[] | null = null;
let pagesCacheTime = 0;
let knownTargetSet: Set<string> | null = null;
let wikiLinkLookup: WikiLinkLookupIndex | null = null;

const EMPTY_WIKI_LINK_LOOKUP: WikiLinkLookupIndex = {
  pages: new Set(),
  pagesBySlug: new Map(),
  pagesByBasename: new Map(),
  assetPaths: new Set(),
};
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
  pagesCache = await fetchPages({ includeFolders: true });
  pagesCacheTime = now;
  knownTargetSet = buildKnownWikilinkTargetSet(pagesCache);
  wikiLinkLookup = buildSourceWikiLinkLookup(pagesCache);
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

export function buildSourceWikiLinkLookup(pages: PageItem[]): WikiLinkLookupIndex {
  const docNames = new Set<string>();
  const assetPaths = new Set<string>();
  for (const page of pages) {
    if (page.kind === 'asset') assetPaths.add(page.docName.replace(/^\//, ''));
    else if (page.kind !== 'folder') docNames.add(page.docName);
  }
  return {
    pages: docNames,
    assetPaths,
    pagesBySlug: buildPagesBySlugIndex(docNames, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(docNames, toWikiLinkSlug),
  };
}

export type SourceWikiLinkDestination =
  | { kind: 'external'; url: string }
  | { kind: 'hash'; href: string };

export function resolveSourceWikiLinkDestination(
  target: string,
  anchor: string | null,
  lookup: WikiLinkLookupIndex,
): SourceWikiLinkDestination | null {
  const classified = resolveWikiLinkTarget(target, anchor, lookup);
  if (!classified) return null;
  if (classified.kind === 'external') return { kind: 'external', url: classified.url };
  if (classified.kind === 'asset') {
    const assetPath =
      resolveWikiLinkAssetTarget(classified.url, lookup.assetPaths ?? new Set<string>()) ??
      classified.url.replace(/^\//, '');
    return { kind: 'hash', href: hashFromAssetPath(assetPath) };
  }
  return { kind: 'hash', href: hashFromDocName(classified.docName, classified.anchor) };
}

export function extractWikilinkTarget(inner: string): string {
  return inner.split(/[#|]/)[0].trim().toLowerCase();
}

export function wikiLinkSourceClass(inner: string, targetSet: ReadonlySet<string> | null): string {
  if (targetSet === null) return 'cm-wiki-link';
  const target = extractWikilinkTarget(inner);
  return target && !targetSet.has(target) && isLinkValidationVisible()
    ? 'cm-wiki-link cm-wiki-link-broken'
    : 'cm-wiki-link';
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const targetSet = pagesCache ? knownTargetSet : null;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    WIKI_LINK_RE.lastIndex = 0;
    let m = WIKI_LINK_RE.exec(text);
    while (m !== null) {
      const className = wikiLinkSourceClass(m[0].slice(2, -2), targetSet);
      const mark = className.includes('cm-wiki-link-broken') ? wikiLinkBrokenMark : wikiLinkMark;
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
    private validationVisibleAtBuild: boolean;
    private readonly unsubscribePolicy: () => void;

    constructor(view: EditorView) {
      this.cacheWarmAtBuild = pagesCache !== null;
      this.validationVisibleAtBuild = isLinkValidationVisible();
      this.decorations = buildDecorations(view);
      this.unsubscribePolicy = subscribeToLinkValidationPolicy(() => {
        try {
          view.dispatch({});
        } catch {}
      });
      if (!this.cacheWarmAtBuild) this.warmCache(view);
    }

    update(update: ViewUpdate) {
      const cacheNowWarm = pagesCache !== null;
      const validationVisible = isLinkValidationVisible();
      if (
        update.docChanged ||
        update.viewportChanged ||
        (!this.cacheWarmAtBuild && cacheNowWarm) ||
        this.validationVisibleAtBuild !== validationVisible
      ) {
        this.cacheWarmAtBuild = cacheNowWarm;
        this.validationVisibleAtBuild = validationVisible;
        this.decorations = buildDecorations(update.view);
      }
    }

    private warmCache(view: EditorView) {
      getPages()
        .then(() => {
          try {
            view.dispatch({});
          } catch {}
        })
        .catch((err) => {
          console.warn('[wiki-link-source] warmCache fetch failed:', err);
        });
    }

    destroy() {
      this.unsubscribePolicy();
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
          const destination = resolveSourceWikiLinkDestination(
            target,
            anchor,
            wikiLinkLookup ?? EMPTY_WIKI_LINK_LOOKUP,
          );
          if (!destination) return false;
          event.preventDefault();
          if (destination.kind === 'external') {
            openExternalUrl(destination.url);
          } else if (shouldOpenInNewTab(event)) {
            openHashHrefInNewTab(destination.href);
          } else {
            window.location.hash = destination.href;
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
  const triggerPos = context.pos - query.length;
  const hashIdx = query.indexOf('#');

  if (hashIdx > 0) {
    const pageTarget = query.slice(0, hashIdx);
    const anchorQuery = query.slice(hashIdx + 1);
    const anchorPos = triggerPos + hashIdx + 1;

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
  const filtered = filterPages(
    pages.filter((p) => p.kind !== 'folder'),
    query,
    linkContext,
  );

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
    color: 'oklch(52.7% 0.154 228.4)',
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
