import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const labels = ['alpha', 'bravo', 'charlie', 'delta'];

function paneTabs(page: Page): Locator {
  return page.locator('[data-editor-header-tabs] [data-editor-pane-tabs]');
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

async function dragTabToRightEdge(page: Page, tab: Locator, paneId: string): Promise<void> {
  const tabBox = await tab.boundingBox();
  if (!tabBox) throw new Error('tab has no box');
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tabBox.x + tabBox.width / 2 + 12, tabBox.y + tabBox.height / 2, {
    steps: 2,
  });
  const edge = page.locator(`section[data-editor-pane-id="${paneId}"] [data-pane-edge="right"]`);
  await expect(edge).toBeAttached();
  const edgeBox = await edge.boundingBox();
  if (!edgeBox) throw new Error('pane edge has no box');
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2, {
    steps: 8,
  });
  await expect(edge).toHaveAttribute('data-pane-drop-side', 'right');
  await page.mouse.up();
}

test.use({ video: 'off', trace: 'off' });

test('dismissed information covers do not accumulate while four live editors survive responsive cycles', async ({
  page,
  api,
}) => {
  const runId = randomUUID().slice(0, 8);
  const docs = labels.map((label) => ({
    name: `cover-retention-${label}-${runId}`,
    markdown: `# ${label}-${runId}\n\n${label} retained body\n`,
  }));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await api.seedDocs(docs);
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto(`/#/${docs[0].name}`);
  await waitForActiveProviderSynced(page);
  for (const doc of docs.slice(1)) {
    await page
      .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
      .getByTestId('editor-new-tab-button')
      .click();
    await openDocFromSidebar(page, doc.name);
    const ids = await paneTabs(page).evaluateAll((strips) =>
      strips.map((strip) => strip.getAttribute('data-editor-pane-tabs')).filter((id) => id != null),
    );
    const paneId = ids.at(-1);
    if (!paneId) throw new Error('focused pane is missing');
    const tab = page.locator(
      `[data-editor-pane-tabs="${paneId}"] [data-editor-tab-sortable][data-editor-tab-id="${doc.name}"]`,
    );
    await dragTabToRightEdge(page, tab, paneId);
    await expect(paneTabs(page)).toHaveCount(ids.length + 1);
  }

  await expect(page.locator('[data-editor-activity-mount]')).toHaveCount(4);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toHaveCount(4);

  const cdp = await page.context().newCDPSession(page);
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      await page.setViewportSize({ width: 390, height: 800 });
      const selector = page.getByRole('combobox', { name: 'Editor pane' });
      await expect(selector).toBeVisible();
      await selector.click();
      await page.getByRole('option', { name: `Pane ${cycle + 1}` }).click();
      await expect(
        page.locator(`[data-editor-activity-mount][data-doc-name="${docs[cycle].name}"]`),
      ).toBeVisible();
      await page.locator('[data-sidebar="trigger"]').click();
      await expect(page.locator('[data-files-cover]')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Alt+KeyB');
      await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
      await page.locator('[data-doc-panel-back]').click();
      await expect(page.locator('[data-doc-panel-cover]')).toHaveCount(0);
      await page.setViewportSize({ width: 2400, height: 900 });
      await expect(paneTabs(page)).toHaveCount(4);
      await expect(page.locator('#doc-panel')).toBeVisible();
      await expect(page.locator('[data-editor-activity-mount]')).toHaveCount(4);
      await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toHaveCount(4);
    }

    for (const doc of docs) {
      const response = await page.request.get(
        `/api/document?docName=${encodeURIComponent(doc.name)}`,
      );
      expect(response.ok()).toBe(true);
      expect((await response.json()) as { content: string }).toMatchObject({
        content: expect.stringContaining(`${doc.name.split('-')[2]} retained body`),
      });
    }
    expect(pageErrors).toEqual([]);

    await cdp.send('HeapProfiler.collectGarbage');
    const result = (await cdp.send('DOM.getDetachedDomNodes')) as {
      detachedNodes: Array<{ treeNode: { nodeName: string; attributes?: string[] } }>;
    };
    const detachedInformationCovers = result.detachedNodes.filter(({ treeNode }) => {
      const attributes = treeNode.attributes ?? [];
      return (
        treeNode.nodeName === 'SECTION' &&
        attributes.some(
          (attribute, index) => attribute === 'data-doc-panel-cover' && index % 2 === 0,
        )
      );
    }).length;
    await test.info().attach('cover-retention.json', {
      body: JSON.stringify({ coverTransitions: 4, detachedInformationCovers }),
      contentType: 'application/json',
    });
    expect(detachedInformationCovers).toBeLessThanOrEqual(1);
  } finally {
    await cdp.detach();
  }
});
