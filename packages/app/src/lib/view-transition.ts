import { flushSync } from 'react-dom';

/**
 * Stable identity the browser morphs between surfaces. The empty-state mascot
 * and the game's player are the same character, so naming both lets the View
 * Transitions API tween the one between the other instead of cutting.
 */
export const MASCOT_VIEW_TRANSITION_NAME = 'ok-blob-mascot';

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

/**
 * Run a state update inside a view transition when the platform offers one.
 *
 * `flushSync` is load-bearing: the callback must leave the DOM in its final
 * state before it returns, and React's concurrent rendering would otherwise
 * commit after the browser has already taken its "after" snapshot, producing a
 * transition between two identical frames.
 *
 * Falls back to a plain update when the API is missing or the user asked for
 * reduced motion, so the caller never has to branch.
 */
export function withViewTransition(update: () => void): void {
  if (typeof document === 'undefined') {
    update();
    return;
  }
  const start = (document as ViewTransitionDocument).startViewTransition;
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (typeof start !== 'function' || prefersReducedMotion) {
    update();
    return;
  }
  start.call(document, () => {
    flushSync(update);
  });
}
