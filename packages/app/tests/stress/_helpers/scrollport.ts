/**
 * Shared scrollport-containment predicate for scroll/landing e2e tests.
 *
 * The editor toolbar is absolute-positioned over the top of the shared scroller,
 * so a match sitting behind it is on-screen but not readable. This one definition
 * encodes that readable band; a per-test copy that omitted the toolbar inset
 * silently could not detect toolbar occlusion, and the two copies had already
 * drifted apart on their inset and tolerance.
 */

import type { Page } from '@playwright/test';

/** Pixels of the scrollport's top edge overlapped by the absolute toolbar. */
const TOOLBAR_OVERLAP_PX = 56;

interface ScrollportContainmentOptions {
  /** Toolbar overlap to exclude at the top of the scrollport. */
  toolbarPx?: number;
  /** Slack on each edge, absorbing sub-pixel and block-granularity rounding. */
  tolerancePx?: number;
}

/**
 * True iff the first `matchSelector` element inside the painted editor scroll
 * container sits fully within the readable band: below the toolbar overlap and
 * above the scroller's bottom edge. Returns false when the container or match is
 * absent, so a missing target never reads as "contained".
 *
 * The container is chosen by layout boxes rather than a first-match query: a
 * hidden `<Activity>` entry keeps its scroll container in the DOM, so more than
 * one can exist at once and only the painted one is the active scrollport.
 */
export async function matchIsWithinReadableScrollport(
  page: Page,
  matchSelector: string,
  { toolbarPx = TOOLBAR_OVERLAP_PX, tolerancePx = 2 }: ScrollportContainmentOptions = {},
): Promise<boolean> {
  return page.evaluate(
    ({ matchSelector, toolbarPx, tolerancePx }) => {
      const scrollContainer = Array.from(
        document.querySelectorAll('[data-testid="editor-scroll-container"]'),
      ).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      const match = scrollContainer?.querySelector(matchSelector);
      if (!scrollContainer || !(match instanceof HTMLElement)) return false;
      const scrollRect = scrollContainer.getBoundingClientRect();
      const matchRect = match.getBoundingClientRect();
      return (
        matchRect.top >= scrollRect.top + toolbarPx - tolerancePx &&
        matchRect.bottom <= scrollRect.bottom + tolerancePx
      );
    },
    { matchSelector, toolbarPx, tolerancePx },
  );
}
