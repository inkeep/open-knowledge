import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  landingMarkCount,
  matchIsWithinReadableScrollport,
  test,
  toggleMode,
  waitForActiveProviderSynced,
  waitForLandingSettled,
} from './_helpers';

function uniqueDocName(label: string): string {
  return `test-source-find-${label}-${randomUUID().slice(0, 8)}`;
}

function visibleScrollContainer(page: Page) {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

test('source-mode find scrolls an off-screen match into view', async ({ page, api }) => {
  const docName = uniqueDocName('scroll');
  const filler = Array.from(
    { length: 120 },
    (_, index) => `Filler line ${index + 1} with enough plain text to create real scroll distance.`,
  ).join('\n\n');
  const marker = 'zqxmarkerzqx';

  await api.seedDocs([
    {
      name: docName,
      markdown: `# Source Find Scroll\n\n${filler}\n\nThe ${marker} token lives near the bottom.`,
    },
  ]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
    'Source Find Scroll',
  );

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  await waitForLandingSettled(page, { since: before, timeout: 6_000 });

  const scrollContainer = visibleScrollContainer(page);
  await expect(scrollContainer).toHaveCount(1);
  await scrollContainer.evaluate((element) => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });
  const scrollTopBefore = await scrollContainer.evaluate((element) =>
    element instanceof HTMLElement ? element.scrollTop : -1,
  );
  expect(scrollTopBefore).toBe(0);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+f');
  const searchField = page.locator('.cm-search input[name="search"]');
  await expect(searchField).toBeVisible();
  await searchField.click();
  await searchField.pressSequentially(marker, { delay: 15 });
  await searchField.press('Enter');

  await expect
    .poll(() =>
      scrollContainer.evaluate((element) =>
        element instanceof HTMLElement ? element.scrollTop : 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() => matchIsWithinReadableScrollport(page, '.cm-searchMatch-selected'))
    .toBe(true);
});
