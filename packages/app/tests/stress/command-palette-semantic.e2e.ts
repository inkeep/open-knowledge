import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

const cmdkRoot = (page: Page) => page.locator('[cmdk-root]');
const cmdkInput = (page: Page) => page.locator('[data-slot="command-input"]');
const semanticPill = (page: Page) =>
  page.locator('[data-testid="command-palette-filter-semantic"]');
const tagPill = (page: Page) => page.locator('[data-testid="command-palette-filter-tag"]');
const submitRow = (page: Page) => page.locator('[data-testid="command-palette-semantic-submit"]');
const emptyNotice = (page: Page) => page.locator('[data-testid="command-palette-semantic-empty"]');
const resultsGroup = (page: Page) =>
  page.locator('[data-testid="command-palette-semantic-results"]');
const indexingBanner = (page: Page) =>
  page.locator('[data-testid="command-palette-semantic-indexing"]');

const CAPABLE_STATUS = {
  enabled: true,
  keyPresent: true,
  keySource: 'file',
  keyHint: 'a1b2', // redacted last-4, matching the real /api/semantic-status shape
  ready: true,
  capable: true,
  embedded: 3,
  total: 3,
} as const;

async function fakeCapability(page: Page) {
  await page.route('**/api/semantic-status', async (route) => {
    await route.fulfill({ json: CAPABLE_STATUS });
  });
}

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
}

test.describe('command-palette semantic mode — gate, pill, submit, sticky, escape', () => {
  test('pill is hidden when semantic search is not set up (byte-identical gate)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 's001', markdown: '# s001\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s001');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    const statusResolved = page.waitForResponse((r) => r.url().includes('/api/semantic-status'), {
      timeout: 15_000,
    });
    await openPalette(page);
    await statusResolved;
    await expect(tagPill(page)).toBeVisible();
    await expect(semanticPill(page)).toHaveCount(0);
  });

  test('with capability the pill enters an exclusive mode showing the type-to-search prompt', async ({
    page,
    api,
  }) => {
    await fakeCapability(page);
    await api.seedDocs([{ name: 's002', markdown: '# s002\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s002');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);

    await expect(semanticPill(page)).toBeVisible();
    await semanticPill(page).click();

    await expect(semanticPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(cmdkInput(page)).toHaveAttribute('placeholder', 'Search by meaning');
    await expect(emptyNotice(page)).toBeVisible();
  });

  test('typing never fires; Enter fires ONE /api/search with semantic:true + source:omnibar', async ({
    page,
    api,
  }) => {
    await fakeCapability(page);
    const searchBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/search', async (route) => {
      searchBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          results: [
            {
              kind: 'page',
              path: 'session-token-refresh',
              title: 'Session Token Refresh',
              score: 9,
              signals: { vector: 0.82 },
            },
          ],
        },
      });
    });
    await api.seedDocs([{ name: 's003', markdown: '# s003\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s003');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();

    await page.keyboard.type('auth retries');
    await expect(submitRow(page)).toBeVisible();
    expect(searchBodies.length).toBe(0);

    await page.keyboard.press('Enter');
    await expect(resultsGroup(page)).toBeVisible({ timeout: 5_000 });
    await expect(resultsGroup(page).getByText('Session Token Refresh')).toBeVisible();
    expect(searchBodies.length).toBe(1);
    expect(searchBodies[0]).toMatchObject({
      semantic: true,
      source: 'omnibar',
      intent: 'full_text',
      query: 'auth retries',
      limit: 30,
    });
  });

  test('editing after a fire holds the results (disabled + dimmed), arms the submit row, and re-fires on ↵', async ({
    page,
    api,
  }) => {
    await fakeCapability(page);
    const searchBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/search', async (route) => {
      searchBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          results: [
            {
              kind: 'page',
              path: 'session-token-refresh',
              title: 'Session Token Refresh',
              score: 9,
            },
          ],
        },
      });
    });
    await api.seedDocs([{ name: 's004', markdown: '# s004\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s004');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await page.keyboard.type('auth');
    await page.keyboard.press('Enter');

    const resultRow = page.locator(
      '[data-testid="command-palette-nav-file-session-token-refresh"]',
    );
    await expect(resultsGroup(page)).toBeVisible({ timeout: 5_000 });
    await expect(resultsGroup(page)).toHaveAttribute('data-dimmed', 'false');
    await expect(resultRow).toHaveAttribute('aria-disabled', 'false');
    await expect(submitRow(page)).toHaveCount(0);
    expect(searchBodies.length).toBe(1);

    await page.keyboard.type(' retries');
    await expect(submitRow(page)).toBeVisible();
    await expect(submitRow(page)).toHaveAttribute('data-selected', 'true');
    await expect(resultsGroup(page)).toHaveAttribute('data-dimmed', 'true');
    await expect(resultRow).toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Enter');
    await expect.poll(() => searchBodies.length).toBe(2);
    expect(searchBodies[1]).toMatchObject({
      semantic: true,
      source: 'omnibar',
      query: 'auth retries',
    });
  });

  test('Escape exits semantic mode first (palette stays open); a second Escape closes it', async ({
    page,
    api,
  }) => {
    await fakeCapability(page);
    await api.seedDocs([{ name: 's005', markdown: '# s005\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s005');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await expect(semanticPill(page)).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Escape');
    await expect(cmdkRoot(page)).toBeVisible();
    await expect(semanticPill(page)).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('Escape');
    await expect(cmdkRoot(page)).toBeHidden({ timeout: 2_000 });
  });

  test('typed text carries into "By meaning" mode when the pill is clicked (not cleared)', async ({
    page,
    api,
  }) => {
    await fakeCapability(page);
    await api.seedDocs([{ name: 's006', markdown: '# s006\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s006');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await page.keyboard.type('auth retries');
    await semanticPill(page).click();
    await expect(semanticPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(cmdkInput(page)).toHaveValue('auth retries');
    await expect(submitRow(page)).toBeVisible();
  });

  test('shows an indexing banner with coverage while the corpus is not fully embedded', async ({
    page,
    api,
  }) => {
    await page.route('**/api/semantic-status', async (route) => {
      await route.fulfill({ json: { ...CAPABLE_STATUS, embedded: 1, total: 4 } });
    });
    await api.seedDocs([{ name: 's007', markdown: '# s007\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s007');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await expect(indexingBanner(page)).toBeVisible();
    await expect(indexingBanner(page)).toContainText('1 of 4');
  });

  test('no indexing banner when the corpus is fully embedded', async ({ page, api }) => {
    await fakeCapability(page);
    await api.seedDocs([{ name: 's008', markdown: '# s008\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s008');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await expect(emptyNotice(page)).toBeVisible(); // in semantic mode...
    await expect(indexingBanner(page)).toBeHidden(); // ...but fully indexed, no banner
  });
});
