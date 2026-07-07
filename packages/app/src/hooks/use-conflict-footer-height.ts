import { useEffect, useRef } from 'react';

/**
 * Publishes the measured height of a conflict-resolution footer as
 * `--conflict-footer-height` on the document root while `enabled` is true.
 *
 * Cross-file contract with BottomComposer + globals.css: the floating Ask AI
 * composer anchors its bottom to this var (the counterpart of the composer's
 * own `--ask-composer-height`) so it stacks ABOVE the conflict controls —
 * the both-modified footer inside DiffView and the delete-vs-modify footers
 * inside DiffViewBoundary — instead of covering them.
 *
 * Root-level var: at most one conflict footer has live EFFECTS at a time.
 * Hidden Activity entries in EditorActivityPool keep their DOM, but React
 * unmounts their effects, so only the visible conflict surface publishes.
 * The one interleaving that invariant does not cover is React's unspecified
 * mount-before-unmount ordering during a fast conflict-doc → conflict-doc
 * switch: the incoming footer's effect can run before the outgoing one's
 * cleanup. The module-level ownership token defends exactly that window —
 * once a newer footer claims the var, a stale instance's late
 * ResizeObserver fire or cleanup can neither overwrite nor remove it.
 */
let activePublisher: object | null = null;

export function useConflictFooterHeightVar(enabled: boolean) {
  const footerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const footer = footerRef.current;
    if (!footer) return;
    const token = {};
    activePublisher = token;
    const root = document.documentElement;
    let last: string | null = null;
    const apply = () => {
      if (activePublisher !== token) return;
      const next = `${footer.offsetHeight}px`;
      if (next === last) return;
      last = next;
      root.style.setProperty('--conflict-footer-height', next);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      if (activePublisher === token) {
        activePublisher = null;
        root.style.removeProperty('--conflict-footer-height');
      }
    };
    // `enabled` as the only dep is load-bearing: correctness requires that
    // the footer DOM node cannot change while `enabled` stays true (ref
    // mutations don't re-run effects, so a swapped node would leave the
    // observer on a detached element). Both call sites guarantee this —
    // DiffView's conflictMode is stable for the mount, and DiffViewBoundary's
    // setSides(null) reset forces enabled false→true across kind switches.
  }, [enabled]);

  return footerRef;
}
