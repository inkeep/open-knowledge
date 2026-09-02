import type { Page } from '@playwright/test';

export async function clickNavCreateNew(navigator: Page): Promise<void> {
  await navigator.locator('[data-testid="nav-create-new"]').click();
}

export async function clickNavOpen(navigator: Page): Promise<void> {
  await navigator.locator('[data-testid="nav-open"]').click();
}
