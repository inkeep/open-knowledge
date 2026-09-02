import { expect, type Locator, type Page } from '@playwright/test';

const MENU_SELECTOR = '[role="listbox"][aria-label="Slash commands"]';

export interface SlashMenuWaitOptions {
  timeout?: number;
}

export function slashMenu(page: Page): Locator {
  return page.locator(MENU_SELECTOR);
}

export async function waitForSlashMenuOpen(
  page: Page,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  await slashMenu(page).waitFor({ state: 'visible', timeout: options.timeout });
}

export async function waitForSlashMenuClosed(
  page: Page,
  options: SlashMenuWaitOptions = {},
): Promise<void> {
  await slashMenu(page).waitFor({ state: 'hidden', timeout: options.timeout });
}

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
  index: number;
  itemCount: number;
  adId: string | null;
  liveText: string | null;
}

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
