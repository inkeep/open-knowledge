/**
 * Source-mode (CodeMirror) find must scroll an off-screen match into view.
 *
 * Regression: in full-page source mode the editor renders at content height and
 * the real scroller is the ancestor ScrollPreservingContainer, so CodeMirror's
 * default search `scrollToMatch` (y:'nearest') no-ops and a found match below
 * the fold stayed off-screen. SourceEditor configures `search({ scrollToMatch })`
 * with y:'start' to force an alignment that drives the ancestor scroller.
 *
 * Each test creates a unique doc; Playwright workers run in parallel.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  matchIsWithinReadableScrollport,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

function uniqueDocName(label: string): string {
  return `test-source-find-${label}-${randomUUID().slice(0, 8)}`;
}

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

function visibleScrollContainer(page: Page) {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

test('source-mode find scrolls an off-screen match into view', async ({ page, api }) => {
  const docName = uniqueDocName('scroll');
  // Long body so the marker sits well below the fold once in source mode.
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

  // Switch to source (CodeMirror) mode and wait for the editor to mount.
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  // Ensure we start at the top so the marker is genuinely off-screen.
  const scrollContainer = visibleScrollContainer(page);
  await expect(scrollContainer).toHaveCount(1);
  await scrollContainer.evaluate((element) => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });
  const scrollTopBefore = await scrollContainer.evaluate((element) =>
    element instanceof HTMLElement ? element.scrollTop : -1,
  );
  expect(scrollTopBefore).toBe(0);

  // Open CodeMirror's native search panel and run the search.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+f');
  const searchField = page.locator('.cm-search input[name="search"]');
  await expect(searchField).toBeVisible();
  // CodeMirror's search field commits the query on `keyup`/`change`, not `input`,
  // so a programmatic fill() would never register the query. Type real keystrokes.
  await searchField.click();
  await searchField.pressSequentially(marker, { delay: 15 });
  await searchField.press('Enter');

  // The viewport must scroll and the selected match must be in view.
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
