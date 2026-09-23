import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const DOC_A = `# Doc A Heading\n\nAlpha body paragraph.\n`;
const DOC_B = `# Doc B Heading\n\nBravo body paragraph.\n`;

async function openFromSidebar(page: Page, filename: string) {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  await expect(row).toBeVisible();
  await row.click();
}

test.describe('a wedged document recovers itself', () => {
  test('W1: a first-sync timeout over a healthy transport clears with no user action', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText("Couldn't load document");

    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(errorAlert).toHaveCount(0);
  });

  test('W2: a document that keeps failing stops retrying and leaves its error UI up', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const boundaryLog: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[DocumentErrorBoundary]')) boundaryLog.push(text);
    });

    await page.evaluate(() => {
      const rearm = () => window.__test_armPendingRejection?.('doc-b', 'timeout');
      rearm();
      window.__w2Rearm = window.setInterval(rearm, 100);
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    await expect
      .poll(() => boundaryLog.filter((line) => line.includes('auto-retry budget spent')).length, {
        timeout: 15_000,
        intervals: [200, 400, 800],
      })
      .toBeGreaterThan(0);

    await page.evaluate(() => {
      if (window.__w2Rearm !== undefined) window.clearInterval(window.__w2Rearm);
    });

    const attempts = boundaryLog.filter((line) => /auto-retry \d+\/\d+ for doc-b/.test(line));
    expect(attempts.length).toBe(3);

    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText("Couldn't load document");

    await page.evaluate(() => window.__test_closeActiveWebSocket?.());
    await expect
      .poll(() => page.evaluate(() => window.__activeProvider?.isSynced === true), {
        timeout: 30_000,
        intervals: [200, 400, 800],
      })
      .toBe(true);

    const laterAttempts = boundaryLog.filter((line) => /auto-retry \d+\/\d+ for doc-b/.test(line));
    expect(laterAttempts.length).toBe(3);
    await expect(errorAlert).toBeVisible();
  });
});

declare global {
  interface Window {
    __w2Rearm?: number;
  }
}
