import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const WIDE_VIEWPORT = { width: 2400, height: 900 } as const;
const MIN_EDITOR_PANE_WIDTH = 300;

function testId(): string {
  return randomUUID().slice(0, 8);
}

function paneTabs(page: Page): Locator {
  return page.locator('[data-editor-header-tabs] [data-editor-pane-tabs]');
}

async function paneIds(page: Page): Promise<string[]> {
  return paneTabs(page).evaluateAll((strips) =>
    strips.flatMap((strip) => {
      const paneId = strip.getAttribute('data-editor-pane-tabs');
      return paneId ? [paneId] : [];
    }),
  );
}

function paneRoot(page: Page, paneId: string): Locator {
  return page.locator(`section[data-editor-pane-id="${paneId}"]`);
}

async function paneWidths(page: Page): Promise<number[]> {
  return Promise.all(
    (await paneIds(page)).map(
      async (paneId) => (await paneRoot(page, paneId).boundingBox())?.width ?? 0,
    ),
  );
}

/**
 * Full geometry behind the alignment check. The assertion below reports a
 * single worst-case number, and a bare "91.71875" on a CI machine nobody can
 * attach to says nothing about which pane drifted, in which direction, or
 * whether the two canvases were even the same width. Sampling the whole picture
 * and printing it on failure is what makes a headless-only misalignment
 * diagnosable from the log alone.
 */
interface HeaderAlignmentSample {
  worst: number;
  worstLabel: string;
  scrollLeft: number;
  headerCanvas: { left: number; width: number; transform: string; minWidth: string };
  workspaceCanvas: { left: number; width: number; minWidth: string };
  headerHost: { left: number; width: number; cssVar: string };
  groups: Array<{
    paneId: string;
    groupLeft: number;
    groupRight: number;
    groupWidth: number;
    groupFlexGrow: string;
    paneLeft: number;
    paneRight: number;
    paneWidth: number;
    dLeft: number;
    dRight: number;
    dWidth: number;
  }>;
}

async function sampleHeaderAlignment(page: Page): Promise<HeaderAlignmentSample> {
  return page.evaluate(() => {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-editor-pane-tab-group]'),
    );
    const workspace = document.querySelector<HTMLElement>('[data-editor-workspace]');
    const headerCanvasEl = document.querySelector<HTMLElement>('[data-editor-header-tab-canvas]');
    const workspaceCanvasEl = document.querySelector<HTMLElement>('[data-editor-workspace-canvas]');
    const headerHostEl = document.querySelector<HTMLElement>('[data-editor-header-tabs]');

    const rows = groups.map((group) => {
      const paneId =
        group
          .querySelector<HTMLElement>('[data-editor-pane-tabs]')
          ?.getAttribute('data-editor-pane-tabs') ?? '';
      const pane = paneId
        ? document.querySelector<HTMLElement>(`section[data-editor-pane-id="${paneId}"]`)
        : null;
      const groupRect = group.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      return {
        paneId,
        groupLeft: round(groupRect.left),
        groupRight: round(groupRect.right),
        groupWidth: round(groupRect.width),
        groupFlexGrow: getComputedStyle(group).flexGrow,
        paneLeft: round(paneRect?.left ?? Number.NaN),
        paneRight: round(paneRect?.right ?? Number.NaN),
        paneWidth: round(paneRect?.width ?? Number.NaN),
        dLeft: paneRect
          ? round(Math.abs(groupRect.left - paneRect.left))
          : Number.POSITIVE_INFINITY,
        dRight: paneRect
          ? round(Math.abs(groupRect.right - paneRect.right))
          : Number.POSITIVE_INFINITY,
        dWidth: paneRect
          ? round(Math.abs(groupRect.width - paneRect.width))
          : Number.POSITIVE_INFINITY,
      };
    });

    const tops = groups.map((group) => group.getBoundingClientRect().top);
    const topDelta = tops.length > 0 ? Math.max(...tops) - Math.min(...tops) : 0;

    // No groups at all is a regression, not alignment: every delta below is
    // missing, so `worst` would otherwise bottom out at 0 and report perfect
    // alignment on a header that stopped rendering or an attribute rename.
    let worst = groups.length === 0 ? Number.POSITIVE_INFINITY : round(topDelta);
    let worstLabel = groups.length === 0 ? 'noGroups' : 'topDelta';
    for (const row of rows) {
      for (const key of ['dLeft', 'dRight', 'dWidth'] as const) {
        if (row[key] > worst) {
          worst = row[key];
          worstLabel = `${key}@${row.paneId}`;
        }
      }
    }

    const measure = (element: HTMLElement | null) => ({
      left: round(element?.getBoundingClientRect().left ?? Number.NaN),
      width: round(element?.getBoundingClientRect().width ?? Number.NaN),
    });

    return {
      worst,
      worstLabel,
      scrollLeft: workspace?.scrollLeft ?? Number.NaN,
      headerCanvas: {
        ...measure(headerCanvasEl),
        transform: headerCanvasEl ? getComputedStyle(headerCanvasEl).transform : 'none',
        minWidth: headerCanvasEl ? getComputedStyle(headerCanvasEl).minWidth : '',
      },
      workspaceCanvas: {
        ...measure(workspaceCanvasEl),
        minWidth: workspaceCanvasEl ? getComputedStyle(workspaceCanvasEl).minWidth : '',
      },
      headerHost: {
        ...measure(headerHostEl),
        cssVar: headerHostEl
          ? getComputedStyle(headerHostEl).getPropertyValue('--editor-header-tabs-width')
          : '',
      },
      groups: rows,
    };
  });
}

/**
 * `JSON.stringify` renders every non-finite number as `null`, which is how the
 * sample's own sentinels get erased: a group with no pane at all and a
 * measurement that was simply unavailable print identically, and a header
 * canvas that never mounted logs as one carrying defaults — the exact failure
 * this assertion exists to catch, disguised as a healthy one.
 */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}

async function expectHeaderGroupsAlignedWithPanes(page: Page): Promise<void> {
  // Collected rather than reassigned: a sample that never completed has to be
  // distinguishable from one that did, and a `const` array also keeps the reads
  // below out of the narrowing hole a `let` assigned inside a callback falls in.
  const seen: HeaderAlignmentSample[] = [];
  try {
    await expect
      .poll(async () => {
        const next = await sampleHeaderAlignment(page);
        seen.push(next);
        return next.worst;
      })
      .toBeLessThanOrEqual(1);
  } catch (error) {
    const last = seen.at(-1);
    console.error(
      `[header-alignment] ${last ? JSON.stringify(last, jsonSafe) : '<no sample completed>'}`,
    );
    throw error;
  }
}

function tabInPane(page: Page, paneId: string, tabId: string): Locator {
  return page
    .locator(`[data-editor-pane-tabs="${paneId}"]`)
    .locator(`[data-editor-tab-sortable][data-editor-tab-id="${tabId}"]`);
}

function editorForDoc(page: Page, docName: string): Locator {
  return page
    .locator(`[data-editor-activity-mount][data-doc-name="${docName}"]`)
    .locator('.ProseMirror:not(.composer-prosemirror)');
}

function sourceEditorForDoc(page: Page, docName: string): Locator {
  return page
    .locator(`[data-editor-activity-mount][data-doc-name="${docName}"]`)
    .locator('.cm-content');
}

async function openDocFromSidebar(page: Page, docName: string): Promise<void> {
  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${docName}.md`, exact: true })
    .click();
  await waitForActiveProviderSynced(page);
  const tab = page.locator(
    `[data-editor-pane-focused] [data-editor-tab-sortable][data-editor-tab-id="${docName}"]`,
  );
  if ((await tab.getAttribute('data-preview-tab')) === 'true') {
    await tab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-keep-open').click();
  }
}

async function dragTabToPaneEdge(
  page: Page,
  tab: Locator,
  targetPaneId: string,
  side: 'left' | 'right',
): Promise<void> {
  const tabBox = await tab.boundingBox();
  expect(tabBox).not.toBeNull();
  if (!tabBox) return;

  const startX = tabBox.x + tabBox.width / 2;
  const startY = tabBox.y + tabBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY, { steps: 2 });

  const edge = paneRoot(page, targetPaneId).locator(`[data-pane-edge="${side}"]`);
  await expect(edge).toBeAttached();
  const edgeBox = await edge.boundingBox();
  expect(edgeBox).not.toBeNull();
  if (!edgeBox) {
    await page.mouse.up();
    return;
  }

  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2, {
    steps: 8,
  });
  await expect(edge).toHaveAttribute('data-pane-drop-side', side);
  await expect(edge).toBeVisible();
  await page.mouse.up();
}

async function dragTabToPaneCenter(page: Page, tab: Locator, targetPaneId: string): Promise<void> {
  const tabBox = await tab.boundingBox();
  expect(tabBox).not.toBeNull();
  if (!tabBox) return;

  const startX = tabBox.x + tabBox.width / 2;
  const startY = tabBox.y + tabBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY, { steps: 2 });

  const tabStripBox = await page.locator(`[data-editor-pane-tabs="${targetPaneId}"]`).boundingBox();
  expect(tabStripBox).not.toBeNull();
  if (!tabStripBox) {
    await page.mouse.up();
    return;
  }

  const targetX = tabStripBox.x + tabStripBox.width / 2;
  const targetY = tabStripBox.y + tabStripBox.height / 2;
  await page.mouse.move(targetX - 1, targetY, { steps: 8 });
  await page.mouse.move(targetX, targetY);
  await expect(page.locator('[data-pane-drop-side]')).toHaveCount(0);
  await page.mouse.up();
}

async function readDocument(page: Page, docName: string): Promise<string> {
  const response = await page.request.get(`/api/document?docName=${encodeURIComponent(docName)}`);
  if (!response.ok()) return '';
  const result = (await response.json()) as { content?: string };
  return result.content ?? '';
}

async function portalGeneration(page: Page, docName: string): Promise<string> {
  return page.evaluate((name) => {
    const element = document.querySelector(`[data-ok-editor-portal="${name}"]`);
    if (!element) return 'absent';
    const key = '__okSplitPortalGenerations';
    const testWindow = window as unknown as Record<string, unknown>;
    let generations = testWindow[key] as WeakMap<Element, string> | undefined;
    if (!generations) {
      generations = new WeakMap<Element, string>();
      testWindow[key] = generations;
    }
    const existing = generations.get(element);
    if (existing) return existing;
    const generation = `generation-${Math.random().toString(36).slice(2)}`;
    generations.set(element, generation);
    return generation;
  }, docName);
}

test.describe('vertical editor splits', () => {
  test.afterEach(({ workerServer }) => {
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  test('pointer edge splits create four live, isolated editors and restore their layout', async ({
    page,
    api,
  }) => {
    const suffix = testId();
    const docs = ['alpha', 'bravo', 'charlie', 'delta'].map((label) => ({
      name: `split-${label}-${suffix}`,
      markdown: `# ${label}-${suffix}\n\n${label} body`,
    }));
    await api.seedDocs(docs);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docs[0].name}`);
    await waitForActiveProviderSynced(page);
    await expect(editorForDoc(page, docs[0].name)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share doc' })).toBeVisible();

    for (const doc of docs.slice(1)) {
      await page
        .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
        .getByTestId('editor-new-tab-button')
        .click();
      await openDocFromSidebar(page, doc.name);
      const ids = await paneIds(page);
      const focusedPaneId = ids.at(-1);
      expect(focusedPaneId).toBeTruthy();
      if (!focusedPaneId) return;
      await dragTabToPaneEdge(
        page,
        tabInPane(page, focusedPaneId, doc.name),
        focusedPaneId,
        'right',
      );
      await expect(paneTabs(page)).toHaveCount(ids.length + 1);
    }

    const splitPaneIds = await paneIds(page);
    expect(splitPaneIds).toHaveLength(4);
    await expect(page.locator('[data-editor-workspace-canvas]')).toHaveCSS(
      'min-width',
      /1280px|100%/,
    );
    for (const doc of docs) {
      await expect(editorForDoc(page, doc.name)).toBeVisible();
    }
    await expect(
      page.locator('[data-editor-workspace] [data-editor-pane-resize-handle]'),
    ).toHaveCount(3);
    await expectHeaderGroupsAlignedWithPanes(page);

    const uniqueToken = `isolated-${suffix}`;
    const editedDoc = docs[1];
    await editorForDoc(page, editedDoc.name).locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${uniqueToken}`);
    await expect.poll(() => readDocument(page, editedDoc.name)).toContain(uniqueToken);
    for (const other of docs.filter((doc) => doc.name !== editedDoc.name)) {
      await expect.poll(() => readDocument(page, other.name)).not.toContain(uniqueToken);
    }

    await expect.poll(() => windowHash(page)).toContain(editedDoc.name);
    await expect(
      page.locator('#panel-outline').getByRole('button', {
        name: `${editedDoc.name.split('-')[1]}-${suffix}`,
        exact: true,
      }),
    ).toBeVisible();

    const generationsBefore = Object.fromEntries(
      await Promise.all(
        docs.map(async (doc) => [doc.name, await portalGeneration(page, doc.name)] as const),
      ),
    );
    expect(Object.values(generationsBefore)).not.toContain('absent');

    const firstHandle = page
      .locator('[data-editor-workspace] [data-editor-pane-resize-handle]')
      .first();
    const handleBox = await firstHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (!handleBox) return;
    const widthsBefore = await paneWidths(page);
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 110, handleBox.y + handleBox.height / 2, { steps: 8 });
    await expectHeaderGroupsAlignedWithPanes(page);
    await page.mouse.up();
    await expect
      .poll(async () => {
        const widths = await paneWidths(page);
        return Math.round(widths[0] - widthsBefore[0]);
      })
      .toBeGreaterThan(30);
    await expectHeaderGroupsAlignedWithPanes(page);

    const widthsAfterResize = await paneWidths(page);
    for (const doc of docs) {
      expect(await portalGeneration(page, doc.name)).toBe(generationsBefore[doc.name]);
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem(`ok-editor-tabs-v1:${window.location.origin}`);
          if (!raw) return 0;
          const session = JSON.parse(raw) as { panes?: unknown[] };
          return session.panes?.length ?? 0;
        }),
      )
      .toBe(4);

    await page.reload();
    await waitForActiveProviderSynced(page);
    await expect(paneTabs(page)).toHaveCount(4);
    await expectHeaderGroupsAlignedWithPanes(page);
    const widthsAfterReload = await paneWidths(page);
    expect(Math.abs(widthsAfterReload[0] - widthsAfterResize[0])).toBeLessThan(40);
    await expect.poll(() => windowHash(page)).toContain(editedDoc.name);
    for (const doc of docs) {
      // Polled, unlike the pre-reload generation-stability reads: the four
      // portals remount asynchronously after a reload, and pane-tab count
      // reaching 4 only means the tab strip restored, not that every pane's
      // editor portal is in the DOM. A one-shot read here races the slowest
      // remount.
      await expect.poll(() => portalGeneration(page, doc.name)).not.toBe('absent');
    }

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('[data-editor-workspace]').evaluate((workspace) => {
      workspace.scrollLeft = 96;
      workspace.dispatchEvent(new Event('scroll'));
    });
    await expectHeaderGroupsAlignedWithPanes(page);
  });

  test('diagonal pointer movement keeps the dragged tab visible before an edge split', async ({
    page,
    api,
  }) => {
    const docName = `split-vertical-drag-${testId()}`;
    await api.seedDocs([{ name: docName, markdown: '# Vertical drag' }]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);

    const [paneId] = await paneIds(page);
    expect(paneId).toBeTruthy();
    if (!paneId) return;

    const tab = tabInPane(page, paneId, docName);
    const tabBox = await tab.boundingBox();
    expect(tabBox).not.toBeNull();
    if (!tabBox) return;

    const startX = tabBox.x + tabBox.width / 2;
    const startY = tabBox.y + tabBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    try {
      await page.mouse.move(startX + 12, startY, { steps: 2 });
      await page.mouse.move(startX + 500, startY + 180, { steps: 8 });

      const dragOverlay = page.getByTestId('editor-tab-drag-overlay');
      await expect(dragOverlay).toBeVisible();
      const draggedTabBox = await dragOverlay.boundingBox();
      expect(draggedTabBox).not.toBeNull();
      if (!draggedTabBox) return;
      expect(draggedTabBox.y).toBeGreaterThan(tabBox.y + 100);

      const edge = paneRoot(page, paneId).locator('[data-pane-edge="right"]');
      const edgeBox = await edge.boundingBox();
      expect(edgeBox).not.toBeNull();
      if (!edgeBox) return;

      await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2, {
        steps: 8,
      });
      await expect(edge).toHaveAttribute('data-pane-drop-side', 'right');
      await expect(edge).toBeVisible();
    } finally {
      await page.mouse.up();
    }
  });

  test('tabs retain a usable minimum width and scroll within a narrow pane', async ({
    page,
    api,
  }) => {
    const suffix = testId();
    const docs = Array.from({ length: 6 }, (_, index) => ({
      name: `shrink-tab-${index}-${suffix}`,
      markdown: `# Shrink tab ${index}`,
    }));
    await api.seedDocs(docs);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docs[0].name}`);
    await waitForActiveProviderSynced(page);

    for (const doc of docs.slice(1)) {
      await page
        .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
        .getByTestId('editor-new-tab-button')
        .click();
      await openDocFromSidebar(page, doc.name);
    }

    await page.setViewportSize({ width: 900, height: 800 });
    const paneStrip = paneTabs(page).first();
    await expect(paneStrip.locator('[data-editor-tab-sortable]')).toHaveCount(docs.length);
    const scrollViewport = paneStrip.locator('[data-editor-tab-scroll]');
    const geometry = await scrollViewport.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      tabWidths: Array.from(
        element.querySelectorAll<HTMLElement>('[data-editor-tab-sortable]'),
        (tab) => tab.getBoundingClientRect().width,
      ),
    }));

    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth + 1);
    expect(Math.min(...geometry.tabWidths)).toBeGreaterThanOrEqual(128);

    const scrolled = await scrollViewport.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      const lastTab = element.querySelector<HTMLElement>('[data-editor-tab-sortable]:last-child');
      return {
        scrollLeft: element.scrollLeft,
        stripRight: element.getBoundingClientRect().right,
        lastTabRight: lastTab?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(scrolled.scrollLeft).toBeGreaterThan(0);
    expect(scrolled.lastTabRight).toBeLessThanOrEqual(scrolled.stripRight + 1);
  });

  test('pane resizing stops before the unified header becomes unusable', async ({ page, api }) => {
    const suffix = testId();
    const [left, right] = [`minimum-left-${suffix}`, `minimum-right-${suffix}`];
    await api.seedDocs([
      { name: left, markdown: '# Left pane' },
      { name: right, markdown: '# Right pane' },
    ]);
    await page.setViewportSize({ width: 2000, height: 800 });
    await page.goto(`/#/${left}`);
    await waitForActiveProviderSynced(page);

    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, right);

    const [initialPaneId] = await paneIds(page);
    expect(initialPaneId).toBeTruthy();
    if (!initialPaneId) return;
    await dragTabToPaneEdge(page, tabInPane(page, initialPaneId, right), initialPaneId, 'right');
    await expect(paneTabs(page)).toHaveCount(2);

    const handle = page.locator('[data-editor-workspace] [data-editor-pane-resize-handle]').first();
    const handleBox = await handle.boundingBox();
    const widthsBefore = await paneWidths(page);
    expect(handleBox).not.toBeNull();
    if (!handleBox) return;

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 500, handleBox.y + handleBox.height / 2, { steps: 12 });
    await page.mouse.up();

    const widths = await paneWidths(page);
    expect(widths[0] - widthsBefore[0]).toBeGreaterThan(200);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(MIN_EDITOR_PANE_WIDTH - 1);
    await expectHeaderGroupsAlignedWithPanes(page);
    expect(
      await paneRoot(page, initialPaneId).evaluate(
        (element) => !element.getAttribute('class')?.includes('ring-'),
      ),
    ).toBe(true);
  });

  test('pointer drag moves a tab between existing panes without creating a split', async ({
    page,
    api,
  }) => {
    const suffix = testId();
    const [first, second, third] = ['alpha', 'bravo', 'charlie'].map(
      (label) => `move-${label}-${suffix}`,
    );
    await api.seedDocs([
      { name: first, markdown: `# First ${suffix}` },
      { name: second, markdown: `# Second ${suffix}` },
      { name: third, markdown: `# Third ${suffix}` },
    ]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${first}`);
    await waitForActiveProviderSynced(page);
    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, second);

    const [initialPaneId] = await paneIds(page);
    expect(initialPaneId).toBeTruthy();
    if (!initialPaneId) return;
    await dragTabToPaneEdge(page, tabInPane(page, initialPaneId, second), initialPaneId, 'right');
    await expect(paneTabs(page)).toHaveCount(2);

    const [leftPaneId, rightPaneId] = await paneIds(page);
    expect(leftPaneId).toBeTruthy();
    expect(rightPaneId).toBeTruthy();
    if (!leftPaneId || !rightPaneId) return;
    await editorForDoc(page, first).click();
    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, third);
    await expect(tabInPane(page, leftPaneId, third)).toBeVisible();

    await dragTabToPaneCenter(page, tabInPane(page, leftPaneId, third), rightPaneId);

    await expect(paneTabs(page)).toHaveCount(2);
    await expect(tabInPane(page, leftPaneId, third)).toHaveCount(0);
    await expect(tabInPane(page, rightPaneId, third)).toBeVisible();
    await expect(paneRoot(page, rightPaneId)).toHaveAttribute('data-editor-pane-focused', 'true');
    await expect(editorForDoc(page, first)).toBeVisible();
    await expect(editorForDoc(page, third)).toBeVisible();
    await expect.poll(() => windowHash(page)).toContain(third);
  });

  test('keyboard split isolates source navigation and closing every tab leaves the empty state', async ({
    page,
    api,
    workerServer,
  }) => {
    const suffix = testId();
    const first = `split-keyboard-a-${suffix}`;
    const second = `split-keyboard-b-${suffix}`;
    mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
    writeFileSync(
      join(workerServer.contentDir, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
    await api.seedDocs([
      { name: first, markdown: `# First ${suffix}\n\nfirst body` },
      { name: second, markdown: `# Second ${suffix}\n\n\tindented with a hard tab` },
    ]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${first}`);
    await waitForActiveProviderSynced(page);
    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, second);

    const [initialPaneId] = await paneIds(page);
    expect(initialPaneId).toBeTruthy();
    if (!initialPaneId) return;
    const secondTab = tabInPane(page, initialPaneId, second);
    await secondTab.focus();
    await secondTab.press('Shift+F10');
    await page.getByTestId('editor-tab-context-split-right').click();
    await expect(paneTabs(page)).toHaveCount(2);

    await page.evaluate(() => {
      localStorage.setItem('ok-editor-mode-v1', 'source');
    });
    await page.reload();
    await waitForActiveProviderSynced(page);
    await expect(sourceEditorForDoc(page, first)).toBeVisible();
    await expect(sourceEditorForDoc(page, second)).toBeVisible();

    await sourceEditorForDoc(page, second).click();
    await expect.poll(() => windowHash(page)).toContain(second);
    const firstActiveLineBefore = await sourceEditorForDoc(page, first)
      .locator('xpath=ancestor::*[contains(@class,"cm-editor")][1]')
      .locator('.cm-activeLine')
      .textContent();

    await page.locator('#tab-problems').click();
    const firstProblem = page.locator('#panel-problems ul li button').first();
    await expect(firstProblem).toBeVisible();
    await firstProblem.click();
    await expect
      .poll(() =>
        sourceEditorForDoc(page, second)
          .locator('xpath=ancestor::*[contains(@class,"cm-editor")][1]')
          .locator('.cm-activeLine')
          .textContent(),
      )
      .toContain('indented with a hard tab');
    expect(
      await sourceEditorForDoc(page, first)
        .locator('xpath=ancestor::*[contains(@class,"cm-editor")][1]')
        .locator('.cm-activeLine')
        .textContent(),
    ).toBe(firstActiveLineBefore);

    const ids = await paneIds(page);
    const secondClose = page
      .locator(`[data-editor-pane-tabs="${ids[1]}"]`)
      .getByTestId('editor-tab-close-button');
    await secondClose.click();
    await expect(paneTabs(page)).toHaveCount(1);

    const onlyPaneId = (await paneIds(page))[0];
    await page
      .locator(`[data-editor-pane-tabs="${onlyPaneId}"]`)
      .getByTestId('editor-tab-close-button')
      .click();
    // The last close collapses to a single pane holding no tabs at all. It used
    // to synthesize a blank "home" tab here; that placeholder renders exactly
    // what the empty state renders, so closing the last tab looked like it
    // reopened one.
    await expect(paneTabs(page)).toHaveCount(1);
    const remainingTabs = page.locator(
      `[data-editor-pane-tabs="${onlyPaneId}"] [data-editor-tab-sortable]`,
    );
    await expect(remainingTabs).toHaveCount(0);
    await expect(page.getByTestId('empty-editor-state')).toBeVisible();
  });

  // A restored session can carry pane percentages that the pane minimum
  // overrides: the panel group raises every undersized pane to
  // MIN_EDITOR_PANE_WIDTH and reclaims the shortfall from the panes in index
  // order, so the geometry it renders is not the geometry the percentages
  // describe. The header tab groups mirror the same workspace and have no
  // minimum of their own, so they only stay aligned if they are driven by the
  // layout the panel group resolved rather than by the persisted percentages.
  test('restored pane sizes below the pane minimum keep header groups aligned', async ({
    page,
    api,
  }) => {
    const suffix = testId();
    const docs = ['alpha', 'bravo', 'charlie', 'delta'].map((label) => ({
      name: `minclamp-${label}-${suffix}`,
      markdown: `# ${label}-${suffix}\n\n${label} body`,
    }));
    await api.seedDocs(docs);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docs[0].name}`);
    await waitForActiveProviderSynced(page);
    await expect(editorForDoc(page, docs[0].name)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share doc' })).toBeVisible();

    for (const doc of docs.slice(1)) {
      await page
        .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
        .getByTestId('editor-new-tab-button')
        .click();
      await openDocFromSidebar(page, doc.name);
      const ids = await paneIds(page);
      const focusedPaneId = ids.at(-1);
      expect(focusedPaneId).toBeTruthy();
      if (!focusedPaneId) return;
      await dragTabToPaneEdge(
        page,
        tabInPane(page, focusedPaneId, doc.name),
        focusedPaneId,
        'right',
      );
      await expect(paneTabs(page)).toHaveCount(ids.length + 1);
    }
    await expect(paneTabs(page)).toHaveCount(4);

    // Percentages a real drag can persist, and which the pane minimum then
    // overrides on the next restore: the last two panes resolve well under
    // MIN_EDITOR_PANE_WIDTH at this viewport.
    const skewed = [55, 20, 12.5, 12.5];
    await page.evaluate((sizes) => {
      const key = `ok-editor-tabs-v1:${window.location.origin}`;
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error('no persisted editor session');
      const session = JSON.parse(raw) as { panes?: Array<{ size?: number }> };
      if (session.panes?.length !== sizes.length) {
        throw new Error(`expected ${sizes.length} persisted panes`);
      }
      session.panes.forEach((pane, index) => {
        pane.size = sizes[index];
      });
      localStorage.setItem(key, JSON.stringify(session));
    }, skewed);

    await page.reload();
    await waitForActiveProviderSynced(page);
    await expect(paneTabs(page)).toHaveCount(4);
    await expectHeaderGroupsAlignedWithPanes(page);

    // The clamp really did engage. A lower bound alone cannot show that: it
    // holds just as well when every pane was already above the minimum and
    // there was never anything to diverge from. Pinning the smallest pane AT
    // the minimum is what proves the resolved layout left the persisted one,
    // so the day a wider viewport or a retuned fixture stops reproducing the
    // clamp this fails instead of passing vacuously.
    const widths = await paneWidths(page);
    const smallest = Math.min(...widths);
    expect(smallest).toBeGreaterThanOrEqual(MIN_EDITOR_PANE_WIDTH - 1);
    expect(smallest).toBeLessThanOrEqual(MIN_EDITOR_PANE_WIDTH + 1);
    // ...and the persisted share it was raised from really was smaller.
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    expect(smallest).toBeGreaterThan((Math.min(...skewed) / 100) * totalWidth + 1);
  });
});

async function windowHash(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash);
}
