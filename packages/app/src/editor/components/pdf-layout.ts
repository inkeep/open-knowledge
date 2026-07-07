/**
 * Pure layout-math helpers extracted from `Pdf.tsx` so the precision suite
 * can exercise the scale-computation logic without dragging in React,
 * lucide-react, or pdfjs-dist. Keeping the math pure and testable means a
 * future tweak to one of the five layout modes can't silently regress the
 * others — every branch has a pinned input/output mapping.
 */

/** Layout presets — single source of truth for the string set the
 *  toolbar dropdown ranges over. `Pdf.tsx` re-exports this as a local
 *  `LayoutMode` alias so the component file stays self-documenting,
 *  but every dispatch site reads through this declaration. */
export type PdfLayoutMode = 'fit-width' | 'fit-height' | 'single' | 'two-odd' | 'two-even';

/** Per-page natural dimensions (scale=1 viewport). Computed once at load
 *  time; doesn't depend on layout mode or zoom. */
export interface PdfPageInfo {
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Container padding budget — `0.75rem` on each axis (matches the
 * `.ok-pdf-pages` padding) so the canvas never bleeds into the scrollbar
 * gutter. Subtracted from the available container size before computing
 * the fit-* and two-* scales.
 */
const PAD_X = 24;
const PAD_Y = 24;

/**
 * Two-page-mode gutter — horizontal space reserved between the two
 * canvases in a row plus a small scrollbar margin so the row doesn't
 * trigger horizontal scrolling at exactly half-width.
 */
const TWO_PAGE_GUTTER = 12;

/**
 * Minimum scale floor — guards against pathological container sizes
 * (very narrow or very short) producing a sub-readable render.
 */
const MIN_SCALE = 0.1;

/**
 * Compute the base render scale for a page given the active layout mode
 * and the current container dimensions. The toolbar's zoom multiplier
 * composes on top of this — `effectiveScale = baseScale * zoomScale`.
 *
 * Falls back to `1` when the container dimensions relevant to the mode
 * aren't yet known (initial render before `ResizeObserver` fires) so the
 * canvas isn't sized to zero on first paint.
 */
export function computeBaseScale(
  mode: PdfLayoutMode,
  page: PdfPageInfo,
  containerW: number,
  containerH: number,
): number {
  // Width-dependent modes need a known width; height-dependent mode
  // needs a known height. Until the relevant dimension is measured,
  // fall through to `1` so the initial render isn't blank.
  if (containerW <= 0 && (mode === 'fit-width' || mode === 'two-odd' || mode === 'two-even')) {
    return 1;
  }
  if (containerH <= 0 && mode === 'fit-height') return 1;

  switch (mode) {
    case 'fit-width':
      return Math.max(MIN_SCALE, (containerW - PAD_X) / page.naturalWidth);
    case 'fit-height':
      return Math.max(MIN_SCALE, (containerH - PAD_Y) / page.naturalHeight);
    case 'single':
      return 1;
    case 'two-odd':
    case 'two-even':
      // Each page gets ~half the container width minus the gutter.
      return Math.max(MIN_SCALE, ((containerW - PAD_X) / 2 - TWO_PAGE_GUTTER) / page.naturalWidth);
  }
}
