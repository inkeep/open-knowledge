import { useEffect, useState } from 'react';

/**
 * Whether the user has asked for reduced motion, kept live.
 *
 * Components that only need to suppress a CSS animation should use the
 * `prefers-reduced-motion` media query directly in the stylesheet. This hook is
 * for the cases where JavaScript has to branch — an imperative animation loop
 * that must not start, or DOM that must be reset when the setting flips.
 */
export function useReducedMotion(): boolean {
  // Lazy-init from the live query so a reduced-motion user never sees one
  // animated frame before an effect corrects it.
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
