import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const PAGES_ROUTE = '**/api/pages';
const PAGES_PATH = '/api/pages';
const LOAD_PAGES_FAILURE = '[PageListContext] Failed to load pages';
const SETTLE_TIMEOUT_MS = 20_000;
const HOLD_LIVENESS_CEILING_MS = 15_000;
const PROVIDER_SYNC_BUDGET_MS = 60_000;
const PROVIDER_SYNC_WAITS_PER_ABANDONMENT_TEST = 2;
const ABANDONMENT_TEST_TIMEOUT_MS =
  4 * SETTLE_TIMEOUT_MS +
  HOLD_LIVENESS_CEILING_MS +
  PROVIDER_SYNC_WAITS_PER_ABANDONMENT_TEST * PROVIDER_SYNC_BUDGET_MS;
const SERVICE_UNAVAILABLE = 503;
const OK_STATUS = 200;
const DOCUMENTS_ROUTE = '**/api/documents';
const DOCUMENTS_PATH = '/api/documents';
const LOAD_ASSETS_FAILURE = '[PageListContext] Failed to load referenced assets';
const WARN_CONSOLE_TYPES = new Set(['warning', 'warn']);

interface ServedPageListsView {
  readonly pagesResponseStatuses: number[];
}

interface ProviderProbe {
  readonly consoleErrors: LogEntry[];
  readonly pagesResponseStatuses: number[];
}

interface AssetsProbe extends ServedPageListsView {
  readonly consoleWarnings: LogEntry[];
  readonly documentsResponseStatuses: number[];
}

// STOP: key every assertion here on console message TEXT, never on filterCriticalErrors or location().url — Vite 8 auto-enables server.forwardConsole under an agent harness (AI_AGENT / CLAUDECODE / CURSOR_* / CODEX_*) and re-attributes every console url to /@vite/client, which _helpers/error-filters.ts classifies as benign for load-failure text, so a url-keyed or guard-keyed assertion passes on unfixed code.
function attachProviderProbe(page: Page): ProviderProbe {
  const consoleErrors: LogEntry[] = [];
  const pagesResponseStatuses: number[] = [];
  page.on('pageerror', (err) => consoleErrors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const location = msg.location();
    consoleErrors.push({
      type: 'error',
      text: msg.text(),
      url: location.url,
      line: location.lineNumber,
    });
  });
  page.on('response', (response) => {
    if (URL.parse(response.url())?.pathname === PAGES_PATH) {
      pagesResponseStatuses.push(response.status());
    }
  });
  return { consoleErrors, pagesResponseStatuses };
}

function attachAssetsProbe(page: Page): AssetsProbe {
  const consoleWarnings: LogEntry[] = [];
  const pagesResponseStatuses: number[] = [];
  const documentsResponseStatuses: number[] = [];
  page.on('console', (msg) => {
    if (!WARN_CONSOLE_TYPES.has(msg.type())) return;
    const location = msg.location();
    consoleWarnings.push({
      type: msg.type(),
      text: msg.text(),
      url: location.url,
      line: location.lineNumber,
    });
  });
  page.on('response', (response) => {
    const pathname = URL.parse(response.url())?.pathname;
    if (pathname === PAGES_PATH) pagesResponseStatuses.push(response.status());
    if (pathname === DOCUMENTS_PATH) documentsResponseStatuses.push(response.status());
  });
  return { consoleWarnings, pagesResponseStatuses, documentsResponseStatuses };
}

function loadPagesFailures(probe: ProviderProbe): LogEntry[] {
  return probe.consoleErrors.filter((entry) => entry.text.includes(LOAD_PAGES_FAILURE));
}

function loadAssetsFailures(probe: AssetsProbe): LogEntry[] {
  return probe.consoleWarnings.filter((entry) => entry.text.includes(LOAD_ASSETS_FAILURE));
}

function servedPageListsSince(probe: ServedPageListsView, mark: number): number {
  return probe.pagesResponseStatuses.slice(mark).filter((status) => status === OK_STATUS).length;
}

function servedDocumentListsSince(probe: AssetsProbe, mark: number): number {
  return probe.documentsResponseStatuses.slice(mark).filter((status) => status === OK_STATUS)
    .length;
}

async function openScratchDocument(page: Page, api: ApiHelpers, suffix: string): Promise<void> {
  await api.createPage(`plr-${suffix}.md`);
  await page.goto(`/#/plr-${suffix}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
}

async function pushAndAwaitServedPageList(
  probe: ServedPageListsView,
  api: ApiHelpers,
  path: string,
  message: string,
): Promise<void> {
  const mark = probe.pagesResponseStatuses.length;
  await api.createPage(path);
  await expect
    .poll(() => servedPageListsSince(probe, mark), { message, timeout: SETTLE_TIMEOUT_MS })
    .toBeGreaterThan(0);
}

test.describe('PageListProvider refresh lifetime', () => {
  test('a document navigation that abandons an in-flight push-refresh is not reported as a failed /api/pages request', async ({
    page,
    api,
  }) => {
    test.setTimeout(ABANDONMENT_TEST_TIMEOUT_MS);

    const probe = attachProviderProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    let handlerEntries = 0;
    let releaseHeldRequests: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeldRequests = resolve;
    });
    await page.route(PAGES_ROUTE, async (route) => {
      handlerEntries += 1;
      await Promise.race([
        held,
        new Promise<void>((resolve) => {
          setTimeout(resolve, HOLD_LIVENESS_CEILING_MS);
        }),
      ]);
      await route.continue().catch(() => undefined);
    });

    try {
      await api.createPage(`plr-push-${suffix}.md`);
      await expect
        .poll(() => handlerEntries, {
          message:
            'the push-refresh /api/pages request must reach the route handler, so the navigation below has a genuinely in-flight request to abandon',
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);
      expect(
        loadPagesFailures(probe),
        'the provider must be quiet before the navigation, so any failure reported afterwards is attributable to it',
      ).toEqual([]);

      await page.reload();
    } finally {
      releaseHeldRequests();
      await page.unroute(PAGES_ROUTE);
    }

    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await pushAndAwaitServedPageList(
      probe,
      api,
      `plr-after-${suffix}.md`,
      'the reloaded document must serve its own push-refresh, proving the provider is live again and the abandoned request has had its chance to settle',
    );

    expect(
      loadPagesFailures(probe),
      'a push-refresh abandoned because its own document was torn down is not a failed request',
    ).toEqual([]);
  });

  test('a genuine network failure of /api/pages on a live document is still reported', async ({
    page,
    api,
  }) => {
    const probe = attachProviderProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    await page.route(PAGES_ROUTE, (route) => route.abort('failed'));
    await api.createPage(`plr-push-${suffix}.md`);

    await expect
      .poll(() => loadPagesFailures(probe).length, {
        message: 'a network-level failure on a live document must still reach the error log',
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const [firstFailure] = loadPagesFailures(probe);
    expect(
      firstFailure?.text,
      'a live network failure carries the same text a navigation-abandoned request carries, so message text can never be the discriminator',
    ).toContain('TypeError: Failed to fetch');
  });

  test('a 5xx from /api/pages on a live document is still reported', async ({ page, api }) => {
    const probe = attachProviderProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    await page.route(PAGES_ROUTE, (route) =>
      route.fulfill({
        status: SERVICE_UNAVAILABLE,
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await api.createPage(`plr-push-${suffix}.md`);

    await expect
      .poll(() => loadPagesFailures(probe).length, {
        message: 'a server error on a live document must still reach the error log',
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const [firstFailure] = loadPagesFailures(probe);
    expect(
      firstFailure?.text,
      'a served error status surfaces as its own message rather than as a fetch rejection',
    ).toContain(`${PAGES_PATH} responded with ${SERVICE_UNAVAILABLE}`);
  });

  test('an undisturbed push-refresh on a live document reports nothing', async ({ page, api }) => {
    const probe = attachProviderProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    await pushAndAwaitServedPageList(
      probe,
      api,
      `plr-push-${suffix}.md`,
      'the push-refresh must actually serve a page list, so the absence asserted below is a measured quiet rather than an unexercised path',
    );

    expect(loadPagesFailures(probe), 'an undisturbed push-refresh must report nothing').toEqual([]);
  });

  test('a document navigation that abandons an in-flight referenced-assets refresh is not reported as a failed /api/documents request', async ({
    page,
    api,
  }) => {
    test.setTimeout(ABANDONMENT_TEST_TIMEOUT_MS);

    const probe = attachAssetsProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    let handlerEntries = 0;
    let releaseHeldRequests: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeldRequests = resolve;
    });
    await page.route(DOCUMENTS_ROUTE, async (route) => {
      handlerEntries += 1;
      await Promise.race([
        held,
        new Promise<void>((resolve) => {
          setTimeout(resolve, HOLD_LIVENESS_CEILING_MS);
        }),
      ]);
      await route.continue().catch(() => undefined);
    });

    try {
      const pagesMark = probe.pagesResponseStatuses.length;
      await api.createPage(`plr-push-${suffix}.md`);
      await expect
        .poll(() => handlerEntries, {
          message:
            'the push-refresh /api/documents request must reach the route handler, so the navigation below has a genuinely in-flight referenced-assets request to abandon',
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => servedPageListsSince(probe, pagesMark), {
          message:
            'the provider must serve its own page list before the navigation, proving the held referenced-assets request belongs to a refresh the provider itself started',
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);
      expect(
        loadAssetsFailures(probe),
        'the provider must be quiet before the navigation, so any referenced-assets failure reported afterwards is attributable to it',
      ).toEqual([]);

      await page.reload();
    } finally {
      releaseHeldRequests();
      await page.unroute(DOCUMENTS_ROUTE);
    }

    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    const documentsMark = probe.documentsResponseStatuses.length;
    await pushAndAwaitServedPageList(
      probe,
      api,
      `plr-after-${suffix}.md`,
      'the reloaded document must serve its own push-refresh, proving the provider is live again and the abandoned request has had its chance to settle',
    );
    await expect
      .poll(() => servedDocumentListsSince(probe, documentsMark), {
        message:
          'the reloaded provider must also serve a referenced-assets request, so the absence asserted below is a measured quiet on the assets leg rather than an unexercised path',
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);

    expect(
      loadAssetsFailures(probe),
      'a referenced-assets refresh abandoned because its own document was torn down is not a failed request',
    ).toEqual([]);
  });

  test('a genuine network failure of /api/documents on a live document is still reported', async ({
    page,
    api,
  }) => {
    const probe = attachAssetsProbe(page);
    const suffix = randomUUID().slice(0, 8);
    await openScratchDocument(page, api, suffix);

    await page.route(DOCUMENTS_ROUTE, (route) => route.abort('failed'));
    await api.createPage(`plr-push-${suffix}.md`);

    await expect
      .poll(() => loadAssetsFailures(probe).length, {
        message:
          'a network-level failure of the referenced-assets request on a live document must still reach the warning log',
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const [firstFailure] = loadAssetsFailures(probe);
    expect(
      firstFailure?.text,
      'a live referenced-assets network failure carries the same text a navigation-abandoned request carries, so message text can never be the discriminator',
    ).toContain('TypeError: Failed to fetch');
  });
});
