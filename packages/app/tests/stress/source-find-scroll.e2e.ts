
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const TOOLBAR_OVERLAP_PX = 56;

function uniqueDocName(label: string): string {
  return `test-source-find-${label}-${randomUUID().slice(0, 8)}`;
}

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

function visibleScrollContainer(page: Page) {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

async function selectedSearchMatchInScrollport(page: Page): Promise<boolean> {
  return page.evaluate((toolbar) => {
    const scrollContainer = Array.from(
      document.querySelectorAll('[data-testid="editor-scroll-container"]'),
    ).find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.getClientRects().length > 0,
    );
    const match = scrollContainer?.querySelector('.cm-searchMatch-selected');
    if (!scrollContainer || !(match instanceof HTMLElement)) return false;
    const scrollRect = scrollContainer.getBoundingClientRect();
    const matchRect = match.getBoundingClientRect();
    return (
      matchRect.top >= scrollRect.top + toolbar - 2 && matchRect.bottom <= scrollRect.bottom + 2
    );
  }, TOOLBAR_OVERLAP_PX);
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
  await expect(page.locator('.ProseMirror')).toContainText('Source Find Scroll');

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

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
  await expect.poll(() => selectedSearchMatchInScrollport(page)).toBe(true);
});
