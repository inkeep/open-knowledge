import type { Page } from '@playwright/test';

/**
 * Navigator entry-point clicks. The launcher renders the same four cards
 * whether or not the profile has recent projects, so these locators resolve in
 * every launcher state — a fresh tmp home (what smoke tests launch with) and a
 * profile that already has projects alike. Only what sits below the cards
 * varies: the starter-pack line for a brand-new user, the Recent list
 * otherwise (see NavigatorApp.tsx).
 */
export async function clickNavCreateNew(navigator: Page): Promise<void> {
  await navigator.locator('[data-testid="nav-create-new"]').click();
}

export async function clickNavOpen(navigator: Page): Promise<void> {
  await navigator.locator('[data-testid="nav-open"]').click();
}
