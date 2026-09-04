import { useEffect, useRef } from 'react';

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
  }, [enabled]);

  return footerRef;
}
