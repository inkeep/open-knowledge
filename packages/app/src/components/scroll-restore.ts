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
 *
 *   3. A scroller's `scrollHeight` is not a statement about the document.
 *      Absolutely positioned chrome inside it counts toward the scrollable
 *      overflow region, so scrollHeight can describe space no content
 *      occupies — and a saved offset measured against a taller earlier layout
 *      lands in exactly that space. Targets and the runway checks that gate
 *      them must be bounded by measured content, or a restore can "succeed"
 *      onto a blank viewport and then defend that position.
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
 * The editing surfaces whose boxes describe the document. Both ProseMirror's
 * `view.dom` and CodeMirror's `.cm-content` carry the attribute, so no
 * per-mode knowledge is needed. The scroll-coordinate conversion below is
 * exact for the modes whose surface is laid out by THIS scroller (WYSIWYG,
 * full-page source — CM6 there renders at content height with no internal
 * scrollport). Diff, standalone Mermaid, and standalone text docs mount
 * `.cm-content` behind their own overflow pane inside the scroller, where the
 * conversion would mix the outer scrollTop with an inner-positioned rect —
 * inert today because the outer scroller cannot overflow in those modes, so
 * the clamp is unreachable there.
 *
 * Load-bearing exclusion: overlay chrome mounted inside the scroller (the
 * block drag handle, selection indicators) must NOT carry `contenteditable` —
 * an overlay that gained the attribute would re-enter this measurement and
 * re-open the phantom-space hazard the selector exists to exclude.
 */
const CONTENT_SURFACE_SELECTOR = '[contenteditable]';

/**
 * Bottom of `container`'s document content, in the container's scroll
 * coordinates (distance from the top of the scrollable content), or `null`
 * when no editing surface is laid out in it this frame.
 *
 * Neither of the two obvious measurements works here (property 3 above):
 *
 *   - `scrollHeight` is the polluted quantity, at every level. It counts the
 *     scrollable overflow of absolutely positioned chrome, so the scroller AND
 *     every wrapper between it and the document report the same inflated
 *     height.
 *   - the container's own children are height-constrained wrappers (`h-full`
 *     on the editor column), and the document overflows them. Their boxes
 *     describe the viewport, not the document — measuring them would clamp
 *     every restore to roughly the top of the page.
 *
 * The editing surface is the one box that both encloses the document and
 * excludes the chrome, because that chrome is mounted as its SIBLING rather
 * than inside it, and `getBoundingClientRect` reports an element's own border
 * box. A surface with no boxes (a hidden mode's editor, a skipped subtree)
 * contributes nothing rather than a zero rect at the viewport origin — the
 * same hazard as an unmeasurable anchor — and a frame with no surface at all
 * (a Suspense skeleton or warm fallback) yields `null` so callers hold their
 * previous behavior instead of clamping against content they cannot see.
 */
export function measureContentExtent(container: HTMLElement): number | null {
  const containerTop = container.getBoundingClientRect().top;
  const { scrollTop } = container;
  let contentBottom: number | null = null;
  for (const surface of Array.from(container.querySelectorAll(CONTENT_SURFACE_SELECTOR))) {
    // `[contenteditable]` also matches the contenteditable=false atom node
    // views nested inside an editing surface (wiki-link chips, embeds, image
    // widgets) — in-flow boxes that can never extend below their surface's
    // bottom. Skipping them by ancestry keeps the per-frame cost at one rect
    // read per top-level surface instead of one per atom in a chip-dense doc.
    if (surface.parentElement?.closest(CONTENT_SURFACE_SELECTOR)) continue;
    if (surface.getClientRects().length === 0) continue;
    const bottom = surface.getBoundingClientRect().bottom - containerTop + scrollTop;
    if (contentBottom === null || bottom > contentBottom) contentBottom = bottom;
  }
  return contentBottom;
}

/**
 * `target` bounded so the viewport it produces still sits over real content.
 *
 * This is what the browser already does to an over-large `scrollTop` write —
 * clamp it to `scrollHeight - clientHeight` — minus the chrome that inflates
 * `scrollHeight`. On a document whose geometry has not changed the bound is
 * the identity: an offset the user could reach when it was saved is still
 * reachable. It only bites once the content that offset was measured against
 * is gone, which is precisely when landing on it would show nothing.
 *
 * An unmeasurable extent leaves the target alone; the caller's own runway
 * check falls back to `scrollHeight` in that case rather than clamping
 * against a measurement we do not have.
 */
export function clampTargetToContent(
  target: number,
  contentBottom: number | null,
  clientHeight: number,
): number {
  if (contentBottom === null) return target;
  return Math.min(target, Math.max(0, contentBottom - clientHeight));
}

/**
 * Whether the layout can actually hold `target` — whether there is document
 * below it, not merely scrollable space. Gates the success marks (a scrollTop
 * that equals its target only because both were clamped to 0 is not a restore)
 * and the re-apply write (nothing to reach). Falls back to `scrollHeight` only
 * when no content extent could be measured.
 */
export function hasRestoreRunway(
  target: number,
  contentBottom: number | null,
  scrollHeight: number,
): boolean {
  return (contentBottom ?? scrollHeight) > target;
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
