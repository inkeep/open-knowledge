import type { Page } from '@playwright/test';

export interface WaitForProviderOptions {
  timeout?: number;
}

export async function waitForActiveProviderSynced(
  page: Page,
  options: WaitForProviderOptions = {},
): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: options.timeout ?? 60_000,
  });
}

export async function installClockAfterSync(page: Page): Promise<void> {
  await waitForActiveProviderSynced(page);
  await page.clock.install();
}
