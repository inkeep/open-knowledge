/**
 * One model of the xterm scroll behaviour that `restoreScrollReach` turns on,
 * shared by every fake that needs it.
 *
 * Two fakes model this terminal: the unit fake beside `restoreScrollReach`, and
 * the `MockTerminal` the panel's DOM tests render against. They were written
 * independently and could disagree silently — and a fake that is kinder than
 * the real terminal accepts a restore the real terminal swallows, which is the
 * failure this whole seam exists to make impossible. Keeping the rules here
 * means TypeScript, rather than a comment, is what stops them drifting.
 *
 * Three rules, all read off the pinned `CoreBrowserTerminal`:
 *
 * 1. A scroll to the line already showing does nothing at all — `scrollToLine`
 *    computes `line - buffer.ydisp` and returns early on zero. This is what
 *    swallows the second half of a bounce whose first half has not landed yet.
 * 2. While `smoothScrollDuration` is set, a scroll hands a target to an
 *    animated viewport and returns with `ydisp` unmoved; at zero it lands
 *    immediately. This is why two scrolls in one tick cannot see each other's
 *    work unless the duration is suppressed across the pair.
 * 3. A scroll that lands immediately CANCELS one still animating —
 *    `setScrollPositionNow` disposes the pending smooth scroll before it sets
 *    state. That is the production path rather than a hypothetical: it is how
 *    suppressing the duration cuts a live momentum scroll short.
 *
 * The scrollbar's position is tracked apart from the buffer's because their
 * disagreement IS the defect under repair: landing on the parked line is not
 * observable in `viewportY` alone, which is where the viewport already reads.
 */

export interface ScrollModelState {
  /** First line the viewport is showing, as `buffer.active.viewportY` reads it. */
  viewportY: number;
  /** Where the scrollbar points. Agreement with `viewportY` is the fix. */
  scrollbarLine: number;
  /** Non-null while an animated scroll is still only scheduled. */
  pendingTarget: number | null;
}

export function createScrollModelState(
  viewportY: number,
  scrollbarLine = viewportY,
): ScrollModelState {
  return { viewportY, scrollbarLine, pendingTarget: null };
}

/** `scrollToLine` / `scrollToBottom`; the latter is the former aimed at `baseY`. */
export function applyModelledScroll(
  state: ScrollModelState,
  target: number,
  smoothScrollDuration: number | undefined,
): void {
  if (target - state.viewportY === 0) return;
  if (smoothScrollDuration) {
    state.pendingTarget = target;
    return;
  }
  state.viewportY = target;
  state.scrollbarLine = target;
  // Rule 3. Keeping a superseded target here would let `settle` teleport the
  // view past the scroll that replaced it; `terminal-scroll-reach.ts` discloses
  // the live-momentum case as the one thing the fix adds.
  state.pendingTarget = null;
}

/** Run whatever an animated scroll only scheduled. */
export function settleModelledScroll(state: ScrollModelState): void {
  if (state.pendingTarget === null) return;
  state.viewportY = state.pendingTarget;
  state.scrollbarLine = state.pendingTarget;
  state.pendingTarget = null;
}

/**
 * Instrument an options bag so writes to `smoothScrollDuration` are counted.
 *
 * Takes the bag rather than manufacturing one, so the DOM mock can instrument
 * the options the component hands it and the unit fake can instrument a literal
 * — one counter, both fakes, no second hand-rolled accessor pair.
 *
 * The scrolled-back guard has no effect on the scroll STATE — at the bottom,
 * both halves of the bounce target the line already showing, and rule 1 makes
 * each a no-op on its own. What the guard actually buys is that an ordinary
 * resize, which is most of them and every step of a drag, does not touch the
 * terminal's options at all. Counting the writes is how a test can see that,
 * and is why dropping the guard fails rather than passing silently.
 */
export function instrumentSmoothScrollOption(options: {
  smoothScrollDuration?: number;
}): () => number {
  let current = options.smoothScrollDuration;
  let writes = 0;
  Object.defineProperty(options, 'smoothScrollDuration', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (next: number | undefined) => {
      current = next;
      writes += 1;
    },
  });
  return () => writes;
}
