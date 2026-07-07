import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test, waitForGraphSimulationSettled } from './_helpers';

type GraphHarness = {
  clickDoc: (docName: string) => boolean;
  clickBackground: () => boolean;
  clickExternal: (url: string) => boolean;
  getNodeVisualState: (docName: string) => string | null;
  getNodeClickPoint: (nodeKey: string) => {
    x: number;
    y: number;
  } | null;
  getLayoutMetrics: () => {
    graphHeight: number;
    containerHeight: number;
    availableHeight: number;
  };
  getLinkClickPoint: (
    sourceDocName: string,
    targetDocName: string,
  ) => { x: number; y: number } | null;
  isSimulationSettled: () => boolean;
};

interface GraphFixtures {
  suffix: string;
  alpha: string;
  beta: string;
  gamma: string;
  zeta: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Seed four per-test unique graph fixtures. Returns the suffix-bearing
 * docNames so tests can thread them through helpers and assertions. We do
 * NOT call `test-reset` here — doing so would reset `test-doc` globally and
 * interfere with parallel tests.
 */
async function seedGraphFixtures(api: ApiHelpers, baseURL: string): Promise<GraphFixtures> {
  const suffix = randomUUID().slice(0, 8);
  const fixtures: GraphFixtures = {
    suffix,
    alpha: `alpha-${suffix}`,
    beta: `beta-${suffix}`,
    gamma: `gamma-${suffix}`,
    zeta: `zeta-${suffix}`,
  };

  for (const docName of [fixtures.alpha, fixtures.beta, fixtures.gamma, fixtures.zeta]) {
    await api.createPage(`${docName}.md`);
  }

  await api.replaceDoc(
    fixtures.alpha,
    `# Alpha\n\n[[${fixtures.beta}#deep-link]]\n\n[Example Docs](https://example.com/docs)`,
  );
  await api.replaceDoc(fixtures.beta, '# Beta');
  await api.replaceDoc(fixtures.gamma, '# Gamma');
  await api.replaceDoc(fixtures.zeta, `# Zeta\n\n[[${fixtures.beta}]]`);

  // Poll until the backlink index reflects our fixtures. We check for our
  // specific docs rather than global orphan/hub state (parallel tests may
  // contribute other orphans or hubs).
  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/orphans?mode=both`);
        const data = (await response.json()) as {
          orphans?: Array<{ docName: string }>;
        };
        const orphans = data.orphans?.map((entry) => entry.docName) ?? [];
        return (
          orphans.includes(fixtures.gamma) &&
          !orphans.includes(fixtures.alpha) &&
          !orphans.includes(fixtures.beta) &&
          !orphans.includes(fixtures.zeta)
        );
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toBe(true);

  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/hubs?limit=50`);
        const data = (await response.json()) as {
          hubs?: Array<{ docName: string; count: number }>;
        };
        const betaHub = data.hubs?.find((h) => h.docName === fixtures.beta);
        return betaHub ? `${betaHub.docName}:${betaHub.count}` : '';
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toBe(`${fixtures.beta}:2`);

  return fixtures;
}

async function openGraph(
  page: Page,
  {
    docName,
    fullscreen = false,
  }: {
    docName: string;
    fullscreen?: boolean;
  },
) {
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.getByRole('tab', { name: 'Graph' }).click();
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as Window &
            typeof globalThis & {
              __graphHarness?: GraphHarness;
            }
        ).__graphHarness,
      ),
    null,
    { timeout: 10_000 },
  );

  if (fullscreen) {
    await page.getByLabel('Full screen').click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement), null, {
      timeout: 5_000,
    });
  }
}

async function waitForGraphNode(page: Page, docName: string) {
  await page.waitForFunction(
    (targetDoc) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.getNodeVisualState(targetDoc) !== null,
    docName,
    { timeout: 10_000 },
  );
}

function getGraphSurface(page: Page) {
  return page.getByRole('img', { name: 'Graph visualization of document links' });
}

async function clickGraphDoc(page: Page, docName: string) {
  return page.evaluate(
    (targetDoc) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.clickDoc(targetDoc) ?? false,
    docName,
  );
}

async function clickGraphBackground(page: Page) {
  return page.evaluate(
    () =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.clickBackground() ?? false,
  );
}

async function clickGraphExternal(page: Page, url: string) {
  return page.evaluate(
    (targetUrl) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.clickExternal(targetUrl) ?? false,
    url,
  );
}

async function getGraphNodeVisualState(page: Page, docName: string) {
  return page.evaluate(
    (targetDoc) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.getNodeVisualState(targetDoc) ?? null,
    docName,
  );
}

async function getGraphNodeClickPoint(page: Page, nodeKey: string) {
  return page.evaluate(
    (targetNode) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.getNodeClickPoint(targetNode) ?? null,
    nodeKey,
  );
}

async function waitForGraphNodeClickPoint(page: Page, nodeKey: string) {
  await expect
    .poll(async () => Boolean(await getGraphNodeClickPoint(page, nodeKey)), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBe(true);
}

async function getGraphLayoutMetrics(page: Page) {
  return page.evaluate(
    () =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.getLayoutMetrics() ?? {
        graphHeight: 0,
        containerHeight: 0,
        availableHeight: 0,
      },
  );
}

async function getGraphLinkClickPoint(page: Page, sourceDocName: string, targetDocName: string) {
  return page.evaluate(
    ({ source, target }) =>
      (
        window as Window &
          typeof globalThis & {
            __graphHarness?: GraphHarness;
          }
      ).__graphHarness?.getLinkClickPoint(source, target) ?? null,
    { source: sourceDocName, target: targetDocName },
  );
}

async function waitForGraphLinkClickPoint(
  page: Page,
  sourceDocName: string,
  targetDocName: string,
) {
  await expect
    .poll(async () => Boolean(await getGraphLinkClickPoint(page, sourceDocName, targetDocName)), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBe(true);
}

async function expectGraphToFillAvailableHeight(page: Page) {
  const metrics = await getGraphLayoutMetrics(page);
  expect(metrics.graphHeight).toBeGreaterThan(0);
  // 16px tolerance absorbs DPI rounding (Retina sub-pixel), scrollbar width
  // reservation, and the 1-2 layout ticks between `requestFullscreen` and the
  // graph canvas's final ResizeObserver callback. A real regression (graph
  // rendering at half-height or missing a flex rule) is orders of magnitude
  // off this threshold; 16px won't hide it.
  expect(Math.abs(metrics.availableHeight - metrics.graphHeight)).toBeLessThanOrEqual(16);
  expect(Math.abs(metrics.containerHeight - metrics.graphHeight)).toBeLessThanOrEqual(16);
}

test('fullscreen graph exposes Explore, Orphans, Hubs, and a visible orphan toggle', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });

  await expect(page.getByRole('radio', { name: 'Explore' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Orphans' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Hubs' })).toBeVisible();

  await page.getByRole('radio', { name: 'Orphans' }).click();

  const orphanPanel = page
    .locator('section')
    .filter({ has: page.getByText('Project-level disconnected pages') });

  await expect(page.getByRole('radio', { name: 'Both' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'No Incoming' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'No Outgoing' })).toBeVisible();

  // Match our per-test fixture names exactly to avoid collisions with any
  // orphans contributed by parallel tests.
  const gammaButton = orphanPanel.getByRole('button', { name: fixtures.gamma });
  const alphaButton = orphanPanel.getByRole('button', { name: fixtures.alpha });
  const betaButton = orphanPanel.getByRole('button', { name: fixtures.beta });
  const zetaButton = orphanPanel.getByRole('button', { name: fixtures.zeta });

  await expect(gammaButton).toBeVisible();
  await expect(alphaButton).toHaveCount(0);
  await expect(betaButton).toHaveCount(0);
  await expect(zetaButton).toHaveCount(0);

  await page.getByRole('radio', { name: 'No Incoming' }).click();
  await expect(orphanPanel.getByRole('button', { name: fixtures.alpha })).toBeVisible();
  await expect(orphanPanel.getByRole('button', { name: fixtures.zeta })).toBeVisible();

  await page.getByRole('radio', { name: 'No Outgoing' }).click();
  await expect(orphanPanel.getByRole('button', { name: fixtures.beta })).toBeVisible();

  await orphanPanel.getByRole('button', { name: fixtures.gamma }).click();
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.gamma)}$`));

  const hubsResponse = page.waitForResponse(
    (response) => response.ok() && response.url().includes('/api/hubs?limit=50'),
  );
  await page.getByRole('radio', { name: 'Hubs' }).click();
  await hubsResponse;

  const hubsPanel = page.locator('section').filter({ has: page.getByText('Top linked pages') });
  await expect(hubsPanel.getByRole('button', { name: fixtures.beta })).toBeVisible();
  await hubsPanel.getByRole('button', { name: fixtures.beta }).click();
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.beta)}$`));
});

test('fullscreen graph selects a document before explicitly opening it', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.alpha);
  await waitForGraphNode(page, fixtures.beta);

  expect(await clickGraphDoc(page, fixtures.beta)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.alpha)}$`));

  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();
  await expect(selectedDoc).toContainText('Beta');
  await expect(selectedDoc).toContainText(fixtures.beta);
  expect(await getGraphNodeVisualState(page, fixtures.alpha)).toBe('active');
  expect(await getGraphNodeVisualState(page, fixtures.beta)).toBe('selected');

  await selectedDoc.getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction(() => !document.fullscreenElement, null, {
    timeout: 5_000,
  });
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.beta)}#deep-link$`));
});

test('fullscreen graph selecting the active document shows the already-open state', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.alpha);

  expect(await clickGraphDoc(page, fixtures.alpha)).toBe(true);

  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();
  await expect(selectedDoc).toContainText('Already open');
  await expect(selectedDoc).toContainText('Alpha');
  expect(await getGraphNodeVisualState(page, fixtures.alpha)).toBe('active-selected');

  await selectedDoc.getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction(() => !document.fullscreenElement, null, {
    timeout: 5_000,
  });
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.alpha)}$`));
});

test('fullscreen graph background click clears selection', async ({ page, api, baseURL }) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.beta);

  expect(await clickGraphDoc(page, fixtures.beta)).toBe(true);
  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();

  expect(await clickGraphBackground(page)).toBe(true);
  await expect(selectedDoc).toHaveCount(0);
});

test('graph canvas fills the available height in docked and fullscreen modes', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha });
  await waitForGraphNode(page, fixtures.alpha);
  await expectGraphToFillAvailableHeight(page);

  await page.getByLabel('Full screen').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement), null, {
    timeout: 5_000,
  });
  await waitForGraphNode(page, fixtures.alpha);
  await expectGraphToFillAvailableHeight(page);
});

test('fullscreen graph edge clicks clear selection on the first try', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.beta);
  await waitForGraphNodeClickPoint(page, fixtures.beta);
  await waitForGraphLinkClickPoint(page, fixtures.alpha, fixtures.beta);
  // Gate canvas-coordinate clicks on simulation settlement per precedent
  // #20(a) category C (physics-sim race). Without this, beta drifts ~24px
  // between `getGraphNodeClickPoint` capture and Playwright's pointerdown —
  // well outside the 8px hit radius — so the click routes to background.
  await waitForGraphSimulationSettled(page);

  const betaPoint = await getGraphNodeClickPoint(page, fixtures.beta);
  expect(betaPoint).not.toBeNull();
  if (!betaPoint) {
    throw new Error('Expected beta click point to be available');
  }

  const linkPoint = await getGraphLinkClickPoint(page, fixtures.alpha, fixtures.beta);
  expect(linkPoint).not.toBeNull();
  if (!linkPoint) {
    throw new Error('Expected an edge click point to be available');
  }

  await getGraphSurface(page).click({
    position: { x: betaPoint.x, y: betaPoint.y },
    force: true,
  });

  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();
  await expect(selectedDoc).toContainText('Beta');

  await getGraphSurface(page).click({
    position: { x: linkPoint.x, y: linkPoint.y },
    force: true,
  });
  await expect(selectedDoc).toHaveCount(0);
});

test('fullscreen graph clicking the selected node toggles selection off', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.beta);
  await waitForGraphNodeClickPoint(page, fixtures.beta);
  // Gate canvas-coordinate clicks on simulation settlement per precedent
  // #20(a) category C (physics-sim race).
  await waitForGraphSimulationSettled(page);

  const betaPoint = await getGraphNodeClickPoint(page, fixtures.beta);
  expect(betaPoint).not.toBeNull();
  if (!betaPoint) {
    throw new Error('Expected beta click point to be available');
  }

  await getGraphSurface(page).click({
    position: { x: betaPoint.x, y: betaPoint.y },
    force: true,
  });

  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();

  await getGraphSurface(page).click({
    position: { x: betaPoint.x, y: betaPoint.y },
    force: true,
  });
  await expect(selectedDoc).toHaveCount(0);
});

test('fullscreen graph external nodes use the same selection affordance', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  // External URL nodes default to hidden (see `GraphPanel.tsx` —
  // `GRAPH_URL_NODES_FULLSCREEN_KEY` loadBoolPref returns false for a fresh
  // context). Toggle them on through the UI so the test exercises the full
  // user journey (enable → click → selection) rather than reaching past the
  // interface to localStorage.
  await page.getByLabel('Show external URL nodes').click();
  expect(await clickGraphExternal(page, 'https://example.com/docs')).toBe(true);

  const selectedNode = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedNode).toBeVisible();
  await expect(selectedNode).toContainText('Example Docs');
  await expect(selectedNode).toContainText('https://example.com/docs');
  await expect(selectedNode.getByRole('button', { name: 'Open link' })).toBeVisible();
});

test('fullscreen graph selection clears when switching modes', async ({ page, api, baseURL }) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.beta);

  expect(await clickGraphDoc(page, fixtures.beta)).toBe(true);
  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();

  await page.getByRole('radio', { name: 'Orphans' }).click();
  await expect(selectedDoc).toHaveCount(0);

  await page.getByRole('radio', { name: 'Explore' }).click();
  await waitForGraphNode(page, fixtures.beta);
  await expect(selectedDoc).toHaveCount(0);
});

test('fullscreen graph selection clears after exiting fullscreen', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha, fullscreen: true });
  await waitForGraphNode(page, fixtures.beta);

  expect(await clickGraphDoc(page, fixtures.beta)).toBe(true);
  const selectedDoc = page.getByRole('status', { name: 'Selected graph item' });
  await expect(selectedDoc).toBeVisible();

  await page.getByLabel('Exit fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement, null, {
    timeout: 5_000,
  });

  await page.getByLabel('Full screen').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement), null, {
    timeout: 5_000,
  });
  await expect(selectedDoc).toHaveCount(0);
});

test('docked graph clicks still navigate immediately with anchor-preserving hashes', async ({
  page,
  api,
  baseURL,
}) => {
  const fixtures = await seedGraphFixtures(api, baseURL ?? '');
  await openGraph(page, { docName: fixtures.alpha });
  await waitForGraphNode(page, fixtures.beta);
  expect(await clickGraphDoc(page, fixtures.beta)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegex(fixtures.beta)}#deep-link$`));
});
