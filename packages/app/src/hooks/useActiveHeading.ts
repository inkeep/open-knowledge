import type { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getSourceViewForDoc, subscribeSourceViewRegistry } from '@/editor/active-source-view';
import { sourceHeadingLines } from '@/editor/source-heading-lines';

function domHeadingTop(slug: string): number | null {
  const el = document.getElementById(slug);
  return el ? el.getBoundingClientRect().top : null;
}

function sourceHeadingTop(view: EditorView): (slug: string) => number | null {
  const offsets = new Map<string, number>();
  for (const heading of sourceHeadingLines(view.state.doc)) {
    offsets.set(heading.slug, heading.from);
  }
  const documentTop = view.documentTop;

  return (slug) => {
    const from = offsets.get(slug);
    if (from === undefined) return null;
    return documentTop + view.lineBlockAt(from).top;
  };
}

export function useActiveHeading(
  slugs: string[],
  options: { isSourceMode?: boolean; docName?: string } = {},
): string | undefined {
  const { isSourceMode = false, docName } = options;
  const [activeSlug, setActiveSlug] = useState<string | undefined>(undefined);
  const rafRef = useRef<number | null>(null);

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
      const resolveTop = isSourceMode && sourceView ? sourceHeadingTop(sourceView) : domHeadingTop;
      const midY = window.innerHeight / 2;
      let scrolledPast: string | undefined;
      let topHalf: string | undefined;

      for (const slug of slugs) {
        const top = resolveTop(slug);
        if (top === null) continue;
        if (top < 0) {
          scrolledPast = slug;
        } else if (topHalf === undefined && top < midY) {
          topHalf = slug;
        }
      }

      setActiveSlug(topHalf ?? scrolledPast ?? slugs[0]);
    }

    function handleScroll() {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    }

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
