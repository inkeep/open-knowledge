import type { Page } from '@playwright/test';
import { TOOLBAR_OVERLAP_PX } from './landing.ts';

interface ScrollportContainmentOptions {
  toolbarPx?: number;
  tolerancePx?: number;
}

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
