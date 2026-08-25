/**
 * Put a scrolled-back terminal viewport back in agreement with its scrollbar
 * after the grid resizes, without moving what the reader is looking at.
 *
 * A resize taken while the user is scrolled up leaves the viewport refusing to
 * go any further up. The lines above are still there — scrolling all the way
 * DOWN and back up reaches them — but every scroll-up from the parked position
 * is ignored, by wheel and by keyboard alike, and no later resize clears it.
 *
 * The cause is that xterm keeps two positions: `buffer.ydisp`, which the rows
 * are rendered from, and the scrollbar's own `scrollTop`. A resize re-derives
 * the scrollbar's DIMENSIONS on the next refresh callback but never its
 * POSITION, so `scrollTop` can end up pinned at zero while `ydisp` still says a
 * line well into the buffer. A scroll-up then resolves to the `scrollTop` it
 * already has, decides nothing changed, and the rows never move. Touching the
 * bottom is what re-establishes agreement, because a scroll that really moves
 * drives `scrollTop` and `ydisp` back through the same path together.
 *
 * Hence a bounce — but it only works with the animation off. The panel sets
 * `smoothScrollDuration`, under which every public scroll hands a target to an
 * animated viewport and returns before `ydisp` has moved. Two of them therefore
 * do not compose: `scrollToLine` computes its delta as `line - buffer.ydisp`,
 * so after an animated `scrollToBottom` it reads a `ydisp` that has not moved,
 * computes zero, and does nothing at all — leaving the reader at the bottom
 * instead of where they were. Suppressing the duration across the pair makes
 * both hops land in this tick, which is what lets the second one see the first,
 * and is why nothing is painted at the bottom on the way through.
 *
 * Two gates, and they are not the same gate. The caller only reaches here when
 * the fit CHANGED THE GRID, because a resize crossing no cell boundary cannot
 * cost anyone their reach. This checks that the viewport is SCROLLED BACK — and
 * not because the bounce would otherwise move something: at the bottom both
 * hops target the line already showing, and a scroll to the line you are on
 * returns early on its zero delta, so it moves nothing at all. What the gate
 * buys is that an ordinary resize never writes the terminal's OPTIONS, and the
 * fit half of the caller's observer is deliberately unthrottled, so that is
 * every grid-changing step of a drag. Both tests assert the position too, but
 * the option writes are what DISCRIMINATE: at the bottom a correct guard and
 * one with the guard REMOVED leave the position identical, since both hops
 * would target the line already showing, so the two writes the unguarded
 * version makes are the only thing telling them apart. Neither gate implies the other, so the
 * caller's is not re-checked here and this one is not hoisted into the caller.
 *
 * Retiring this: it can go when a resize leaves the scrollbar and `ydisp` in
 * agreement on its own. Nothing in xterm's public API reports that, so the test
 * is the behaviour rather than a version number — park a viewport back in the
 * scrollback, resize the grid, and see whether `Shift+PageUp` moves the rows
 * without this having run first. If it does, delete this and its tests.
 *
 * What this does NOT do is hold the line the reader had before the resize.
 * xterm anchors the most recent visible line through a reflow, so a tall panel
 * becoming a short one moves them down the buffer whatever happens here; this
 * adds no movement of its own on top of that.
 *
 * Nor does it preserve a scroll that is still ANIMATING. Suppressing the
 * duration makes both hops land immediately, and an immediate scroll disposes
 * any pending smooth scroll before it sets position — so a resize arriving
 * while the reader's momentum is still running cancels the rest of it, and
 * `parked` is read from wherever the animation had got to rather than where it
 * was heading. Each wheel event restarts the animation, so that window lasts as
 * long as the momentum stream does, and the unthrottled fit means a menu-driven
 * move or a window resize can land inside it. Strictly better than the dead end
 * it replaces, but it is the one thing the reader may notice.
 */

/** The slice of xterm's `Terminal` this needs, so a caller can be a stub. */
export interface ScrollReachTarget {
  readonly buffer: {
    readonly active: {
      /** First line the viewport is showing. */
      readonly viewportY: number;
      /** The viewport line that means "at the bottom". */
      readonly baseY: number;
    };
  };
  options: { smoothScrollDuration?: number };
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

export function restoreScrollReach(term: ScrollReachTarget): void {
  const parked = term.buffer.active.viewportY;
  if (parked >= term.buffer.active.baseY) return;

  const smoothScrollDuration = term.options.smoothScrollDuration;
  term.options.smoothScrollDuration = 0;
  try {
    term.scrollToBottom();
    term.scrollToLine(parked);
  } finally {
    term.options.smoothScrollDuration = smoothScrollDuration;
  }
}
