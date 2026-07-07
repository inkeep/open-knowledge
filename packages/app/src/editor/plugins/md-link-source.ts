/**
 * Internal markdown link support for CodeMirror (source mode):
 *
 * 1. Mark decorations — highlights [text](./internal.md) links with the same
 *    sky colour used for wiki links, with the broken-link affordance applied
 *    after the page/asset cache confirms a target is missing.
 *
 * 2. Ctrl/Cmd+click navigation — resolves the href relative to the current
 *    document (from window.location.hash) and follows in-app doc + anchor links.
 *
 * External links (http://, https://, etc.) are left untouched.
 */
import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { computeLinkResolutionState } from '../extensions/link-resolution';
import {
  classifyCurrentMarkdownHref,
  getCurrentDocNameFromHash,
  navigateToMarkdownTarget,
  openInternalHashHrefInNewTab,
  shouldOpenInNewTab,
} from '../internal-link-helpers';
import type { PageListCacheSnapshot } from '../page-list-cache';
import { getPageListCache, subscribePageListCache } from '../page-list-cache';

// ── Decoration ────────────────────────────────────────────────────────────────

// Matches [text](href) with an optional CommonMark title. Captures [1] text and
// [2] href only so downstream resolution doesn't need to strip the title.
const MD_LINK_RE =
  /\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;

const internalLinkMark = Decoration.mark({ class: 'cm-md-internal-link' });
const brokenInternalLinkMark = Decoration.mark({
  class: 'cm-md-internal-link cm-md-link-broken',
});

export function markdownSourceLinkClass(
  href: string,
  sourceDocName: string,
  cache: PageListCacheSnapshot | null,
): string | null {
  const state = computeLinkResolutionState(href, sourceDocName, cache);
  if (state === 'external') return null;
  return state === 'unresolved' ? 'cm-md-internal-link cm-md-link-broken' : 'cm-md-internal-link';
}

function markdownSourceLinkMark(
  href: string,
  sourceDocName: string,
  cache: PageListCacheSnapshot | null,
): Decoration | null {
  const className = markdownSourceLinkClass(href, sourceDocName, cache);
  if (className === null) return null;
  return className.includes('cm-md-link-broken') ? brokenInternalLinkMark : internalLinkMark;
}

function isImageMatch(text: string, matchIndex: number): boolean {
  return matchIndex > 0 && text[matchIndex - 1] === '!';
}

function getMatchHref(match: RegExpExecArray): string {
  const href = match[2] ?? '';
  return href.startsWith('<') && href.endsWith('>') ? href.slice(1, -1) : href;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sourceDocName = getCurrentDocNameFromHash();
  const cache = getPageListCache();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    MD_LINK_RE.lastIndex = 0;
    let m = MD_LINK_RE.exec(text);
    while (m !== null) {
      const mark = isImageMatch(text, m.index)
        ? null
        : markdownSourceLinkMark(getMatchHref(m), sourceDocName, cache);
      if (mark) {
        builder.add(from + m.index, from + m.index + m[0].length, mark);
      }
      m = MD_LINK_RE.exec(text);
    }
  }
  return builder.finish();
}

const mdLinkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private cacheAtBuild: PageListCacheSnapshot | null;
    private readonly unsubscribe: () => void;

    constructor(view: EditorView) {
      this.cacheAtBuild = getPageListCache();
      this.decorations = buildDecorations(view);
      this.unsubscribe = subscribePageListCache((snapshot) => {
        if (this.cacheAtBuild === snapshot) return;
        queueMicrotask(() => {
          try {
            view.dispatch({});
          } catch {
            /* view destroyed before cache refresh */
          }
        });
      });
    }
    update(update: ViewUpdate) {
      const cache = getPageListCache();
      if (update.docChanged || update.viewportChanged || this.cacheAtBuild !== cache) {
        this.cacheAtBuild = cache;
        this.decorations = buildDecorations(update.view);
      }
    }
    destroy() {
      this.unsubscribe();
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Ctrl/Cmd+click navigation ─────────────────────────────────────────────────

const mdLinkClickHandler = EditorView.domEventHandlers({
  mousedown(event: MouseEvent, view: EditorView) {
    if (!event.ctrlKey && !event.metaKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const line = view.state.doc.lineAt(pos);
    MD_LINK_RE.lastIndex = 0;
    let m = MD_LINK_RE.exec(line.text);
    while (m !== null) {
      const start = line.from + m.index;
      const end = start + m[0].length;
      if (pos >= start && pos <= end) {
        const href = getMatchHref(m);
        const target = isImageMatch(line.text, m.index) ? null : classifyCurrentMarkdownHref(href);
        if (target && target.kind !== 'external') {
          const state = computeLinkResolutionState(
            href,
            getCurrentDocNameFromHash(),
            getPageListCache(),
          );
          if (state === 'unresolved') {
            // Source mode has no create popover; the broken decoration is the cue.
            return false;
          }
          event.preventDefault();
          if (target.kind === 'doc' && shouldOpenInNewTab(event)) {
            openInternalHashHrefInNewTab(target);
            return true;
          }
          navigateToMarkdownTarget(target);
          return true;
        }
      }
      m = MD_LINK_RE.exec(line.text);
    }
    return false;
  },
});

// ── Theme ─────────────────────────────────────────────────────────────────────

const mdLinkTheme = EditorView.theme({
  '.cm-md-internal-link': {
    color: 'oklch(52.7% 0.154 228.4)', // sky-700 — same as cm-wiki-link
    fontWeight: '500',
  },
  '.cm-md-internal-link:hover': {
    textDecoration: 'underline',
    cursor: 'pointer',
  },
});

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * CodeMirror extensions for internal markdown link support in source mode.
 * Highlights relative [text](href) links and enables Cmd/Ctrl+click navigation.
 */
export function createMdLinkSourceExtension(): Extension {
  return [mdLinkDecorations, mdLinkClickHandler, mdLinkTheme];
}
