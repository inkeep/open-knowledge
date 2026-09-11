import type { SemanticIndexStatus } from '@inkeep/open-knowledge-core';
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
const noResultsNotice = (page: Page) =>
  page.locator('[data-testid="command-palette-semantic-no-results"]');
const resultsGroup = (page: Page) =>
  page.locator('[data-testid="command-palette-semantic-results"]');
const coverageBanner = (page: Page) =>
  page.locator('[data-testid="command-palette-semantic-coverage"]');

const CAPABLE_STATUS: SemanticIndexStatus = {
  enabled: true,
  keyPresent: true,
  keyNotRequired: false,
  keySource: 'file',
  keyHint: 'a1b2',
  ready: true,
  capable: true,
  embedded: 3,
  total: 3,
};

const KEYLESS_LOOPBACK_UNINDEXED_STATUS: SemanticIndexStatus = {
  enabled: true,
  keyPresent: false,
  keyNotRequired: true,
  keySource: null,
  keyHint: null,
  ready: false,
  capable: false,
  embedded: 0,
  total: 3,
};

async function fakeCapability(page: Page, status: SemanticIndexStatus = CAPABLE_STATUS) {
  await page.route('**/api/semantic-status', async (route) => {
    await route.fulfill({ json: status });
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

  test('pill is offered for a keyless loopback endpoint before the first index pass', async ({
    page,
    api,
  }) => {
    await fakeCapability(page, KEYLESS_LOOPBACK_UNINDEXED_STATUS);
    await api.seedDocs([{ name: 's001k', markdown: '# s001k\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s001k');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);

    await expect(semanticPill(page)).toBeVisible();
    await semanticPill(page).click();
    await expect(semanticPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(coverageBanner(page)).toBeVisible();
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
          semantic: {
            capable: true,
            applied: true,
            outcome: 'applied',
            coverage: { embedded: 3, total: 3 },
          },
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
          semantic: {
            capable: true,
            applied: true,
            outcome: 'applied',
            coverage: { embedded: 3, total: 3 },
          },
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

  test('explains indexing on search and refreshes coverage until complete', async ({
    page,
    api,
  }) => {
    let embedded = 0;
    await page.route('**/api/semantic-status', async (route) => {
      await route.fulfill({ json: { ...CAPABLE_STATUS, embedded, total: 4 } });
    });
    await api.seedDocs([{ name: 's007', markdown: '# s007\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s007');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await expect(coverageBanner(page)).toHaveText(
      'Pages indexed: 0 of 4. Missing pages are indexed when you search. Search again for fuller results.',
    );
    await expect(coverageBanner(page).getByRole('status')).toHaveText('Pages indexed: 0 of 4.');
    await expect(coverageBanner(page).getByLabel('Loading')).toHaveCount(0);
    embedded = 1;
    await expect(coverageBanner(page)).toContainText('Pages indexed: 1 of 4.');
    await expect(coverageBanner(page).getByRole('status')).toHaveText('Pages indexed: 1 of 4.');
    embedded = 4;
    await expect(coverageBanner(page)).toBeHidden();
  });

  test('a fully embedded search with no vector match shows no results', async ({ page, api }) => {
    await fakeCapability(page);
    await page.route('**/api/search', async (route) => {
      await route.fulfill({
        json: {
          results: [
            {
              kind: 'page',
              path: 'lexical-only',
              title: 'Lexical only',
              score: 1,
            },
          ],
          semantic: {
            capable: true,
            applied: false,
            outcome: 'no_match',
            coverage: { embedded: 3, total: 3 },
          },
        },
      });
    });
    await api.seedDocs([{ name: 's008', markdown: '# s008\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s008');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await expect(emptyNotice(page)).toBeVisible();
    await expect(coverageBanner(page)).toBeHidden();
    await page.keyboard.type('missing concept');
    await page.keyboard.press('Enter');
    await expect(noResultsNotice(page)).toContainText(
      'No pages matched "missing concept" by meaning.',
    );
    await expect(resultsGroup(page)).toHaveCount(0);
  });

  test('a warming search keeps the coverage banner and polling active', async ({ page, api }) => {
    let statusRequests = 0;
    await page.route('**/api/semantic-status', async (route) => {
      statusRequests += 1;
      await route.fulfill({ json: KEYLESS_LOOPBACK_UNINDEXED_STATUS });
    });
    await page.route('**/api/search', async (route) => {
      await route.fulfill({
        json: {
          results: [
            {
              kind: 'page',
              path: 'lexical-only',
              title: 'Lexical only',
              score: 1,
            },
          ],
          semantic: {
            capable: true,
            applied: false,
            outcome: 'warming',
            coverage: { embedded: 0, total: 3 },
          },
        },
      });
    });
    await api.seedDocs([{ name: 's009', markdown: '# s009\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s009');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await page.keyboard.type('auth retries');
    await page.keyboard.press('Enter');

    await expect(submitRow(page)).toContainText('Search "auth retries" by meaning');
    await expect(resultsGroup(page)).toHaveCount(0);
    await expect(coverageBanner(page)).toBeVisible();
    const settledStatusRequests = statusRequests;
    await expect
      .poll(() => statusRequests, { timeout: 4_000 })
      .toBeGreaterThan(settledStatusRequests);
  });

  test('an explicit provider failure shows retry and stops coverage polling', async ({
    page,
    api,
  }) => {
    let statusRequests = 0;
    await page.route('**/api/semantic-status', async (route) => {
      statusRequests += 1;
      await route.fulfill({
        json: {
          ...KEYLESS_LOOPBACK_UNINDEXED_STATUS,
          providerError: statusRequests > 1,
          providerErrorReason: statusRequests > 1 ? 'warm' : null,
        },
      });
    });
    await page.route('**/api/search', async (route) => {
      await route.fulfill({
        json: {
          results: [],
          semantic: {
            capable: true,
            applied: false,
            outcome: 'warming',
            coverage: { embedded: 0, total: 3 },
          },
        },
      });
    });
    await api.seedDocs([{ name: 's010', markdown: '# s010\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s010');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await page.keyboard.type('auth retries');
    await page.keyboard.press('Enter');

    await expect(submitRow(page)).toContainText("Couldn't reach the embeddings provider", {
      timeout: 5_000,
    });
    await expect(resultsGroup(page)).toHaveCount(0);
    await expect(coverageBanner(page)).toBeHidden();
    const settledStatusRequests = statusRequests;
    await page.waitForRequest('**/api/semantic-status', { timeout: 3_000 }).catch(() => undefined);
    expect(statusRequests).toBe(settledStatusRequests);
  });

  test('a corpus indexing failure does not override successful semantic results', async ({
    page,
    api,
  }) => {
    let statusRequests = 0;
    await page.route('**/api/semantic-status', async (route) => {
      statusRequests += 1;
      await route.fulfill({
        json: {
          ...CAPABLE_STATUS,
          providerError: true,
          providerErrorReason: 'corpus',
          embedded: 2,
        },
      });
    });
    await page.route('**/api/search', async (route) => {
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
          semantic: {
            capable: true,
            applied: true,
            outcome: 'applied',
            providerErrorReason: 'corpus',
            coverage: { embedded: 2, total: 3 },
          },
        },
      });
    });
    await api.seedDocs([{ name: 's010c', markdown: '# s010c\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s010c');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();
    await page.keyboard.type('auth retries');
    await page.keyboard.press('Enter');

    await expect(resultsGroup(page).getByText('Session Token Refresh')).toBeVisible();
    await expect(submitRow(page)).toHaveCount(0);
    await expect(coverageBanner(page)).toContainText('Pages indexed: 2 of 3.');
    const settledStatusRequests = statusRequests;
    await expect
      .poll(() => statusRequests, { timeout: 4_000 })
      .toBeGreaterThan(settledStatusRequests);
  });

  test('terminal dimension drift asks for restart without offering retry', async ({
    page,
    api,
  }) => {
    await page.route('**/api/semantic-status', async (route) => {
      await route.fulfill({
        json: {
          ...KEYLESS_LOOPBACK_UNINDEXED_STATUS,
          ready: true,
          providerError: true,
          providerErrorReason: 'dimensions',
        },
      });
    });
    await api.seedDocs([{ name: 's011', markdown: '# s011\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/s011');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);
    await semanticPill(page).click();

    await expect(page.getByTestId('command-palette-semantic-restart-required')).toContainText(
      "The provider's vector size kept changing. Restart OpenKnowledge",
    );
    await expect(submitRow(page)).toHaveCount(0);
    await expect(coverageBanner(page)).toBeHidden();
  });
});
