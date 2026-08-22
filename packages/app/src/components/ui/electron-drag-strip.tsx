/**
 * 48px of restored title-bar reach — one chosen value, not a measurement.
 *
 * The two window classes disagree, so no single number is exact. The editor
 * window's chrome spans y=0..56 (an 8px vibrancy strip above the rows, see
 * `App.tsx`), leaving y=48..56 unrestored. The Navigator's chrome row is `h-9`,
 * so the band reaches 12px past it and turns that much overlay into drag
 * region. Both slips are accepted: the band only has to be a target big enough
 * to grab, and over- or under-shooting by a few pixels costs a sliver of
 * dismissal area or of reach, not correctness.
 *
 * `DRAG_BAND_CLEARANCE` below is hand-derived from this value. Changing one
 * means changing the other; nothing type-checks the pair.
 */
const DRAG_BAND_HEIGHT = 'h-12';

/**
 * Caps a vertically centered dialog so it can never grow under the drag band.
 *
 * Twice the band height, because the dialog is centered: a symmetric cap is
 * what buys the top gap without abandoning `top-1/2 -translate-y-1/2`. A dialog
 * tall enough to care gives up height rather than sliding under the band.
 */
const DRAG_BAND_CLEARANCE = 'max-h-[calc(100dvh-6rem)]';

function isElectronHost() {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

/**
 * The max-height a modal surface must respect to stay clear of the drag band,
 * or `undefined` off the desktop host — a browser tab has no band to clear.
 *
 * Belongs in the same `cn()` call as the surface's own `max-h`, ahead of any
 * caller `className`, so tailwind-merge drops the unclamped value while a
 * caller override still wins.
 */
export function electronDragBandClearance(): string | undefined {
  return isElectronHost() ? DRAG_BAND_CLEARANCE : undefined;
}

/**
 * Hands the title-bar band back to the window while a modal overlay is open.
 *
 * A modal overlay blankets the viewport with `-webkit-app-region: no-drag`,
 * which also neutralizes the chrome-row drag regions underneath it — so an open
 * dialog leaves an Electron window immovable until it is answered. Painting a
 * `drag` strip over that band restores it.
 *
 * MUST render between the overlay and the content. Chromium folds app regions
 * in DOM order — a layout-tree walk collecting each region, then a sequential
 * union/difference over that list, with z-index and paint order never consulted
 * — so that one position is what lets the strip beat the overlay while still
 * losing to the dialog itself. Moved above the content, it would turn the
 * top of a viewport-tall dialog — its heading, its close affordance — into drag
 * region and swallow those clicks, the exact failure `no-drag` on the content
 * exists to prevent. `electronDragBandClearance` keeps the two from overlapping
 * at all; the ordering is the backstop for whatever a caller `className` pushes
 * back under the band.
 *
 * `pointer-events-none` keeps the strip out of DOM hit-testing while
 * `-webkit-app-region` still resolves at the compositor — the same pairing the
 * editor-window chrome strip in `App.tsx` uses. `data-electron-drag` opts it
 * into the `globals.css` rule that suspends drag while a popper floater is open,
 * so a menu opened from inside the dialog stays dismissable by clicking the
 * band. That rule matches an explicit slot list rather than all floaters, so a
 * new popper primitive that can open inside a dialog has to be added there or
 * its outside-click dismissal dies on these pixels.
 *
 * The band costs the pixels it covers their outside-click dismissal: the OS
 * claims pointer events over a drag region before the DOM sees them, so a
 * dialog that dismisses on outside click no longer does so along its top edge.
 * Escape, the close button, and the rest of the overlay are unaffected — a
 * window that cannot be moved is the worse of the two.
 *
 * `testId` is per-surface rather than baked in because a Dialog can host an
 * AlertDialog, putting two strips in the tree at once.
 */
export function ElectronDragStrip({ testId }: { testId: string }) {
  if (!isElectronHost()) return null;

  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      data-electron-drag=""
      className={`pointer-events-none fixed inset-x-0 top-0 z-50 ${DRAG_BAND_HEIGHT} [-webkit-app-region:drag]`}
    />
  );
}
