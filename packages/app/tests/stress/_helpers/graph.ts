
import type { Page } from '@playwright/test';

export async function waitForGraphSimulationSettled(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(() => window.__graphHarness?.isSimulationSettled() === true, null, {
    timeout: timeoutMs,
  });
}
