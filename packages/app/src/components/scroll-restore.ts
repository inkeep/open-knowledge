/**
 * Pure decision logic for ScrollPreservingContainer's restore loop
 * (EditorActivityPool.tsx). Extracted so the geometry/finalization rules are
 * unit-testable without mounting the pool.
 *
 * The restore contract: converge the scroller on the saved BODY offset using
 * only valid layout evidence, and yield only to user intent, an external
 * scroll, or the hard backstop. Two properties are load-bearing:
 *
 *   1. A mounted-but-not-laid-out anchor (display:none — e.g. while a
 *      Suspense fallback replaces the committed children during a slow
 *      reveal) reports a zero rect at the viewport origin. Treating that as a
 *      measurement degenerates the anchor-relative target into
 *      `scrollTop + offset - containerTop`, which self-amplifies on every
 *      re-apply frame (each write raises scrollTop, which raises the next
 *      target) until the scroller runs away from the saved position. Such
 *      frames must yield NO target (hold), not a wrong one.
 *
 *   2. `scrollTop` is device-pixel-clamped while anchor-derived targets are
 *      fractional, so exact equality between them can never be reached on
 *      standard-DPR displays. Landing checks need a sub-pixel tolerance or
 *      the loop rewrites forever and telemetry misclassifies an on-target
 *      restore as abandoned.
 */

/** Anchor layout evidence for one frame. */
export type AnchorMeasurement =
  | { kind: 'measured'; contentPos: number }
  | { kind: 'unmeasurable' }
  | { kind: 'absent' };

/**
 * Position of `anchor` within `container`'s scroll content (distance from the
 * content top, independent of the current scroll offset) — the total height
 * ABOVE the anchor: page header + Properties section.
 *
 * `absent` = no anchor in this layout (caller falls back to the raw saved
 * scrollTop, compensation delta 0). `unmeasurable` = the anchor exists but
 * generates no layout boxes this frame (display:none / detached), so there is
 * no valid measurement — callers must hold rather than compute from the zero
 * rect (property 1 above).
 */
export function measureAnchor(
  container: HTMLElement,
  anchor: HTMLElement | null | undefined,
): AnchorMeasurement {
  if (!anchor) return { kind: 'absent' };
  if (anchor.getClientRects().length === 0) return { kind: 'unmeasurable' };
  const cTop = container.getBoundingClientRect().top;
  const aTop = anchor.getBoundingClientRect().top;
  return { kind: 'measured', contentPos: aTop - cTop + container.scrollTop };
}

/**
 * The scrollTop the restore should apply this frame, or `null` to hold
 * (no valid evidence this frame — do not write).
 *
 * With no saved body offset, or with no anchor in the layout at all, the raw
 * saved scrollTop is the restore basis (legacy behavior). With a body offset
 * and a measured anchor, the target keeps the body offset constant as the
 * height above the body changes.
 */
export function computeRestoreTarget(
  rawTarget: number,
  bodyOffset: number | null,
  anchor: AnchorMeasurement,
): number | null {
  if (bodyOffset === null) return rawTarget;
  switch (anchor.kind) {
    case 'measured':
      return anchor.contentPos + bodyOffset;
    case 'absent':
      return rawTarget;
    case 'unmeasurable':
      return null;
    default:
      return assertNever(anchor);
  }
}

/**
 * Whether a scroll event's position is safe to record as the user's saved
 * position. The save-side twin of the restore-side hold: recording while the
 * anchor is transiently hidden pairs the scrollTop with a missing/garbage
 * anchor measurement and corrupts the saved body offset the next restore
 * relies on.
 */
export function shouldRecordScrollPosition(anchor: AnchorMeasurement): boolean {
  switch (anchor.kind) {
    case 'measured':
    case 'absent':
      return true;
    case 'unmeasurable':
      return false;
    default:
      return assertNever(anchor);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AnchorMeasurement variant: ${JSON.stringify(value)}`);
}

/**
 * Sub-pixel landing tolerance (property 2 above): browsers clamp scrollTop to
 * device pixels, so a fractional target is "reached" within one CSS pixel.
 */
export const SCROLL_LANDING_TOLERANCE_PX = 1;

export function hasLandedAt(scrollTop: number, target: number): boolean {
  return Math.abs(scrollTop - target) <= SCROLL_LANDING_TOLERANCE_PX;
}

/**
 * True when the scroller moved between our frames in a way only an external
 * scroller could produce — a programmatic scrollIntoView (outline click,
 * find-in-doc) or a user scroll not caught by the intent listeners. Such a
 * move is a "someone else owns the scroll now" signal and must end the
 * restore immediately; fighting it re-applies a stale target over an
 * intentional scroll.
 *
 * Direction is the discriminator. The browser's shrink-clamp — the one
 * non-external scrollTop mover left once the caller suspends CSS scroll
 * anchoring — can only ever move scrollTop DOWN, and it can happen against a
 * TRANSIENT height (the Suspense warm-fallback -> editor swap collapses
 * scrollHeight and re-grows it within a frame under contention), so a
 * downward move can never be attributed reliably: comparing against the
 * current maxScroll misreads a stale clamp as a takeover and strands the
 * restore at the clamped position. Downward moves are therefore treated as
 * re-clamps to re-apply over (downward USER takeovers are caught by the
 * wheel/touch/mousedown/keydown listeners). An upward move we didn't write
 * has no browser-side explanation and is external.
 */
export function isExternalScroll(prevScrollTop: number, scrollTop: number): boolean {
  return scrollTop - prevScrollTop > SCROLL_LANDING_TOLERANCE_PX;
}

/**
 * Hard wall-clock backstop for the restore loop. Not a finalizer in the
 * design sense — user intent and external scrolls are the normal exits — but
 * a guarantee that a doc whose anchor never becomes measurable again
 * re-enables user scroll capture eventually. Long deliberately: the loop
 * finalizing while layout is still churning is precisely how a transient
 * degenerate window used to freeze into a permanently wrong position, so the
 * backstop must comfortably exceed any contended hydration + panel-settle
 * window rather than approximate a typical one.
 */
export const RESTORE_BACKSTOP_MS = 10_000;
