/**
 * Slash-command menu helpers.
 *
 * Signals based on `[role="listbox"][aria-label="Slash commands"]` visibility
 * and filtered item content. Replaces the `page.waitForTimeout(N)`
 * pattern that littered `slash-command.e2e.ts`.
 *
 * Menu state changes are synchronous in this product (Tippy + React state
 * update), so no `page.clock` usage — the primitives are auto-retrying
 * Playwright expectations and `expect.poll` against DOM reads.
 */

import { expect, type Locator, type Page } from '@playwright/test';

const MENU_SELECTOR = '[role="listbox"][aria-label="Slash commands"]';

export interface SlashMenuWaitOptions {
  timeout?: number;
}

/** Root locator for the slash-command menu. */
export function slashMenu(page: Page): Locator {
  return page.locator(MENU_SELECTOR);
}

/** Wait for the menu to be visible. */
export async function waitForSlashMenuOpen(
  page: Page,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  await slashMenu(page).waitFor({ state: 'visible', timeout: options.timeout });
}

/** Wait for the menu to be hidden (closed or never opened). */
export async function waitForSlashMenuClosed(
  page: Page,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  await slashMenu(page).waitFor({ state: 'hidden', timeout: options.timeout });
}

/**
 * Wait for the menu to be open AND the first (auto-selected) option's text
 * (lowercased) to contain `textLike.toLowerCase()`. Keystroke-triggered
 * filtering is asynchronous (keystroke → React state → render), so this polls
 * the filtered state rather than assuming it has settled after a magic delay.
 *
 * Matches on the FIRST option because that's the row `Enter` / `Tab` inserts
 * — the signal tests actually care about. The query typed by the user (e.g.
 * `/h2`) may not literally appear in the option label (e.g. `Heading 2`)
 * because the slash-menu matcher is fuzzy; pass the expected label substring
 * (e.g. `'heading 2'`) rather than the raw query.
 */
export async function waitForSlashMenuFirstOption(
  page: Page,
  textLike: string,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  const needle = textLike.toLowerCase();
  await waitForSlashMenuOpen(page, options);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const first = document.querySelector(
            '[role="listbox"][aria-label="Slash commands"] [role="option"]',
          );
          return (first?.textContent ?? '').toLowerCase();
        }),
      { timeout: options.timeout ?? 5_000 },
    )
    .toContain(needle);
}

/**
 * Stricter variant: wait for the menu to be open AND every visible option's
 * text (lowercased) to contain `query.toLowerCase()`. Use when the test is
 * explicitly asserting that the filter narrowed the list homogeneously (e.g.
 * typing `/heading` → every remaining row contains `heading`). For the
 * common "Enter inserts the intended item" case, prefer
 * `waitForSlashMenuFirstOption`.
 */
export async function waitForSlashMenuFilteredBy(
  page: Page,
  query: string,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  const needle = query.toLowerCase();
  await waitForSlashMenuOpen(page, options);
  await expect
    .poll(
      () =>
        page.evaluate((q) => {
          const items = document.querySelectorAll(
            '[role="listbox"][aria-label="Slash commands"] [role="option"]',
          );
          if (items.length === 0) return false;
          return Array.from(items).every((i) => (i.textContent ?? '').toLowerCase().includes(q));
        }, needle),
      { timeout: options.timeout ?? 5_000 },
    )
    .toBe(true);
}

export interface SelectedItemSnapshot {
  /** Index of the option with `data-selected="true"`, or -1 if none. */
  index: number;
  /** Count of rendered options. */
  itemCount: number;
  /** Current `aria-activedescendant` ID on the listbox. */
  adId: string | null;
  /** Current polite live-region text content. */
  liveText: string | null;
}

/**
 * Read the current selection state from the menu. Null-safe: returns
 * sentinel values if the menu is not mounted.
 */
export async function getSelectedItemSnapshot(page: Page): Promise<SelectedItemSnapshot> {
  return page.evaluate(() => {
    const menu = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    if (!menu) return { index: -1, itemCount: 0, adId: null, liveText: null };
    const items = Array.from(menu.querySelectorAll('[role="option"]'));
    const index = items.findIndex((i) => i.getAttribute('data-selected') === 'true');
    const adId = menu.getAttribute('aria-activedescendant');
    const live = menu.querySelector('[aria-live="polite"]');
    return {
      index,
      itemCount: items.length,
      adId,
      liveText: live?.textContent?.trim() ?? null,
    };
  });
}
