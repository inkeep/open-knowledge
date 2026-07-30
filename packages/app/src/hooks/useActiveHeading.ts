import type { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getSourceViewForDoc, subscribeSourceViewRegistry } from '@/editor/active-source-view';
import { sourceHeadingLines } from '@/editor/source-heading-lines';

/** Screen-space top of a rendered heading element, or null when it is not in the DOM. */
function domHeadingTop(slug: string): number | null {
  const el = document.getElementById(slug);
  return el ? el.getBoundingClientRect().top : null;
}

/**
 * Resolve each heading's screen-space top from its source line rather than a DOM
 * node. CodeMirror renders only the lines near the viewport, so most heading
 * lines have no element at all; `lineBlockAt` answers from the height map for
 * every document position, measured or interpolated.
 *
 * `documentTop` and `BlockInfo.top` are both already in scaled screen space, so
 * they combine by plain addition and the sum lands in the space
 * `getBoundingClientRect().top` reports. Do NOT scale either term: the height map
 * is populated from `getBoundingClientRect().height`, CodeMirror divides block
 * values by `scaleY` when converting back to CSS pixels, and its own
 * `moveVertically` and `posAtCoords` combine the two with no multiply. Scaling
 * here would double-scale, which is inert while `scaleY` is 1 but wrong under any
 * CSS transform on an ancestor.
 *
 * Falling back to the heading elements in the hidden WYSIWYG pane would be worse
 * than having no answer: that pane keeps its layout while hidden but is
 * absolutely positioned, so it contributes nothing to the shared scrollport's
 * scroll range, and its taller content means the trailing headings can never
 * come into range at any scroll position.
 */
function sourceHeadingTop(view: EditorView): (slug: string) => number | null {
  const offsets = new Map<string, number>();
  for (const heading of sourceHeadingLines(view.state.doc)) {
    offsets.set(heading.slug, heading.from);
  }
  // Read once per resolver rather than once per slug: this getter is an uncached
  // `getBoundingClientRect()`, and nothing in the caller's loop mutates the DOM.
  const documentTop = view.documentTop;

  return (slug) => {
    const from = offsets.get(slug);
    if (from === undefined) return null;
    return documentTop + view.lineBlockAt(from).top;
  };
}

/**
 * Tracks which heading is currently "active" based on scroll position.
 *
 * Uses a capturing scroll listener on document to catch scrolling inside any
 * container (including the editor's inner overflow-y-auto div). Priority is the
 * first heading visible in the top half of the viewport, else the last heading
 * scrolled past, else the first heading, so the top heading is always
 * highlighted at the top of the page.
 *
 * The two editing modes share the scrollport but not the geometry source.
 * WYSIWYG headings are real elements carrying `id` attributes, which the
 * HeadingAnchors TipTap extension provides. Source mode measures CodeMirror line
 * positions from the view registered for `docName`; that view can legitimately be
 * absent (mid mode-toggle, doc switch, editor-pool eviction) and there is no
 * answer to give then, so the hook reports none. Without the guard a source-mode
 * read falls through to `domHeadingTop`, which either finds no element and sticks
 * at the first heading, or — mid mode-toggle, while the hidden WYSIWYG pane is
 * still mounted — reads that pane's absolutely-positioned geometry and reports a
 * wrong active heading (the trap `sourceHeadingTop` documents above).
 */
export function useActiveHeading(
  slugs: string[],
  options: { isSourceMode?: boolean; docName?: string } = {},
): string | undefined {
  const { isSourceMode = false, docName } = options;
  const [activeSlug, setActiveSlug] = useState<string | undefined>(undefined);
  const rafRef = useRef<number | null>(null);

  // A view mounting is not a React state change, so tracking subscribes to the
  // registry instead of reading it once per mount — a view that arrives after
  // this hook first ran must still be picked up.
  const sourceView = useSyncExternalStore(
    subscribeSourceViewRegistry,
    () => (docName ? getSourceViewForDoc(docName) : null),
    () => null,
  );

  useEffect(() => {
    if (slugs.length === 0 || (isSourceMode && !sourceView)) {
      setActiveSlug(undefined);
      return;
    }

    function compute() {
      // Rebuilt per frame: the source resolver reads the document it was handed,
      // and heading offsets move as the user types.
      const resolveTop = isSourceMode && sourceView ? sourceHeadingTop(sourceView) : domHeadingTop;
      const midY = window.innerHeight / 2;
      let scrolledPast: string | undefined; // last heading above the viewport
      let topHalf: string | undefined; // first heading visible in the top half

      for (const slug of slugs) {
        const top = resolveTop(slug);
        if (top === null) continue;
        if (top < 0) {
          scrolledPast = slug;
        } else if (topHalf === undefined && top < midY) {
          topHalf = slug;
        }
      }

      // Priority: visible-in-top-half > scrolled-past > first heading (top of page)
      setActiveSlug(topHalf ?? scrolledPast ?? slugs[0]);
    }

    function handleScroll() {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    }

    // capture: true catches scroll events from any element, including the
    // editor's inner overflow-y-auto container
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    compute();

    return () => {
      document.removeEventListener('scroll', handleScroll, { capture: true });
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [slugs, isSourceMode, sourceView]);

  return activeSlug;
}
