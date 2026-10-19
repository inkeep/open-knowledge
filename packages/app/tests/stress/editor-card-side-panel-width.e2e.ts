import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { saveInMemoryCheckpoint } from '@inkeep/open-knowledge-server';
import { chromium, type Locator, type Page } from '@playwright/test';
import { acpCatalogBody, expect, test, waitForActiveProviderSynced } from './_helpers';

const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_HEADER_BUTTON = 'header-pane-button-agents';
const BOOT_TIMEOUT_MS = 30_000;
const DRAG_PX = 150;
const WIDTH_TOLERANCE_PX = 1;
const BESIDE_DIVIDER_GRAB_PX = 3;
const GRABS = [
  { label: 'on the divider', offsetPx: 0 },
  { label: 'beside the divider on the editor side', offsetPx: -BESIDE_DIVIDER_GRAB_PX },
  { label: 'beside the divider on the chat side', offsetPx: BESIDE_DIVIDER_GRAB_PX },
] as const;

const DOC_MARKDOWN = `---
title: "Side panel width"
description: "Fixture doc for the editor card side panel width law"
---

# Side panel width

Body text so the document column renders real content while the dividers are dragged.`;

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});
test('narrow document panes reclaim gutters while properties keep their gutter and heading and composer stay centered', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `editor-compact-gutters-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '600');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.route('**/api/installed-agents', (route) => route.fulfill({ json: { claude: true } }));
  await page.route('**/api/acp/catalog', (route) =>
    route.fulfill({ json: acpCatalogBody([{ id: 'gutter-agent', name: 'Gutter Agent' }]) }),
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const column = page.locator('[data-editor-workspace-column]');
  const editor = column.locator('.ProseMirror:not(.composer-prosemirror)').first();
  const properties = column.locator('.property-panel').first();
  const composer = column.getByTestId('bottom-composer');
  const heading = column.getByTestId('editor-toolbar').locator('.editor-content-aligned');
  await expect(editor).toBeVisible();
  await expect(properties).toBeVisible();
  await expect(composer).toBeVisible();
  await page.setViewportSize({ width: 1300, height: 900 });
  const information = page.locator('#doc-panel');
  await expect(information).toBeVisible();
  const divider = page.locator('[data-doc-panel-handle]');
  await divider.hover();
  const dividerBox = await divider.boundingBox();
  if (!dividerBox) throw new Error('the information divider has no bounds');
  const x = dividerBox.x + dividerBox.width / 2;
  const y = dividerBox.y + dividerBox.height / 2;
  await page.mouse.down();
  await expect(divider).toHaveAttribute('data-separator', 'active');
  await page.mouse.move(x - 600, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => widthOf(information)).toBeGreaterThanOrEqual(599);
  for (const viewport of [1300, 1800, 1300]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    const compact = viewport === 1300;
    await expect(page.locator('#doc-panel')).toBeVisible();
    await expect.poll(async () => (await widthOf(column)) < 640).toBe(compact);
    await expect
      .poll(() =>
        editor.evaluate((element, narrow) => {
          const grid = element.closest('.tiptap-editor');
          if (!grid) return false;
          const box = grid.getBoundingClientRect();
          const style = getComputedStyle(element);
          const body = element.getBoundingClientRect();
          const left = body.left + Number.parseFloat(style.paddingLeft) - box.left;
          const right = box.right - body.right + Number.parseFloat(style.paddingRight);
          return narrow
            ? Math.abs(left - 60) <= 1 && Math.abs(right - 16) <= 1
            : left >= 63 && right >= 63 && Math.abs(left - right) <= 1;
        }, compact),
      )
      .toBe(true);
    await expect
      .poll(() =>
        properties.evaluate((element) => {
          const body = element
            .closest('[data-editor-workspace-column]')
            ?.querySelector('.ProseMirror:not(.composer-prosemirror)');
          if (!body || !element.firstElementChild) return Number.POSITIVE_INFINITY;
          const bodyLeft =
            body.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(body).paddingLeft);
          return Math.abs(element.firstElementChild.getBoundingClientRect().left - bodyLeft);
        }),
      )
      .toBeLessThanOrEqual(1);
    for (const aligned of [heading, composer]) {
      await expect
        .poll(() =>
          aligned.evaluate((element, narrow) => {
            if (!element.firstElementChild) return false;
            const pane = element.getBoundingClientRect();
            const content = element.firstElementChild.getBoundingClientRect();
            const left = content.left - pane.left;
            const right = pane.right - content.right;
            return Math.abs(left - right) <= 1 && (narrow ? Math.abs(left - 16) <= 1 : left >= 63);
          }, compact),
        )
        .toBe(true);
    }
    await expect
      .poll(() =>
        editor.evaluate((element) => {
          const scroll = element.closest('.editor-doc-scroll');
          const workspace = element.closest('[data-editor-workspace-column]');
          if (!scroll || !workspace) return Number.POSITIVE_INFINITY;
          return Math.max(
            scroll.scrollWidth - scroll.clientWidth,
            workspace.scrollWidth - workspace.clientWidth,
          );
        }),
      )
      .toBeLessThanOrEqual(1);
  }
  for (const direction of ['ltr', 'rtl']) {
    await page.evaluate((value) => {
      document.documentElement.dir = value;
    }, direction);
    await expect
      .poll(() =>
        editor.evaluate((element) => {
          const grid = element.closest('.tiptap-editor')?.getBoundingClientRect();
          if (!grid) return null;
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return [
            Math.round(box.left + Number.parseFloat(style.paddingLeft) - grid.left),
            Math.round(grid.right - box.right + Number.parseFloat(style.paddingRight)),
          ];
        }),
      )
      .toEqual([60, 16]);
    await expect
      .poll(() =>
        properties.evaluate((element) => {
          if (!element.firstElementChild) return null;
          const pane = element.getBoundingClientRect();
          const content = element.firstElementChild.getBoundingClientRect();
          return [Math.round(content.left - pane.left), Math.round(pane.right - content.right)];
        }),
      )
      .toEqual([60, 16]);
    const propertyGrip = properties.getByRole('button', { name: 'Drag title to reorder' });
    await propertyGrip.hover();
    expect(
      await propertyGrip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const pane = element.closest('[data-editor-workspace-column]')?.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return (
          pane != null && box.left - pane.left >= 16 && (hit === element || element.contains(hit))
        );
      }),
    ).toBe(true);
    for (const aligned of [heading, composer]) {
      await expect
        .poll(() =>
          aligned.evaluate((element) => {
            if (!element.firstElementChild) return null;
            const pane = element.getBoundingClientRect();
            const card = element.firstElementChild.getBoundingClientRect();
            return [Math.round(card.left - pane.left), Math.round(pane.right - card.right)];
          }),
        )
        .toEqual([16, 16]);
    }
    const paragraph = editor.locator(':scope > p').first();
    await paragraph.hover();
    const add = column.locator('.ok-add-block-btn:visible');
    const grip = column.locator('.ok-drag-grip:visible');
    for (const control of [add, grip]) {
      await expect(control).toBeVisible();
      expect(
        await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const point = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          const pane = element.closest('[data-editor-workspace-column]')?.getBoundingClientRect();
          return (
            pane != null && box.left >= pane.left && (point === element || element.contains(point))
          );
        }),
      ).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath(`compact-editor-gutters-${direction}.png`),
    });
    await add.click();
    await expect(editor.locator(':scope > p').last()).toHaveText('/');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-suggestion-popup="slash-command"]')).toHaveCount(0);
  }
});

test.describe('touch document gutters', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('compact desktop spacing preserves the existing phone gutters', async ({
    page,
    api,
    baseURL,
  }) => {
    const docName = `editor-touch-gutters-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.context().addCookies([{ name: 'sidebar_state', value: 'false', url: baseURL }]);
    await page.addInitScript(() => {
      localStorage.setItem(
        'ok-sidebar-pins-v2',
        JSON.stringify({
          left: { above: 'closed', below: 'closed', embedded: 'closed' },
          right: { above: 'closed', below: 'closed', embedded: 'closed' },
        }),
      );
    });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(editor).toBeVisible();
    for (const direction of ['ltr', 'rtl']) {
      await page.evaluate((value) => {
        document.documentElement.dir = value;
      }, direction);
      await expect
        .poll(() =>
          editor.evaluate((element) => {
            const style = getComputedStyle(element);
            const grid = element.closest('.tiptap-editor')?.getBoundingClientRect();
            if (!grid) return null;
            const box = element.getBoundingClientRect();
            return [
              Math.round(box.left + Number.parseFloat(style.paddingLeft) - grid.left),
              Math.round(grid.right - box.right + Number.parseFloat(style.paddingRight)),
            ];
          }),
        )
        .toEqual([16, 16]);
    }
  });
});

async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

function ownsItsCentre(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit != null && element.contains(hit);
  });
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function openChat(page: Page): Promise<void> {
  const agentsButton = page.getByTestId(AGENTS_HEADER_BUTTON);
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'false', { timeout: BOOT_TIMEOUT_MS });
  await agentsButton.click();
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await settleFrames(page);
}

async function dragChatDivider(
  page: Page,
  grabOffsetPx: number,
  deltaPx: number,
  readMidDrag: () => Promise<void>,
): Promise<void> {
  const chatPanel = page
    .locator(AGENTS_PANEL_MOUNT)
    .locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
  const handle = chatPanel.locator('xpath=preceding-sibling::*[1]');
  await expect(handle).toHaveAttribute('data-slot', 'resizable-handle');
  const bounds = await handle.boundingBox();
  if (bounds == null) throw new Error('the chat divider has no bounds');
  const x = bounds.x + bounds.width / 2 + grabOffsetPx;
  const y = bounds.y + bounds.height / 2;
  if (grabOffsetPx !== 0) {
    expect(
      await page.evaluate(
        ([px, py]) => {
          const hit = document.elementFromPoint(px, py);
          return {
            onDragBand: hit?.closest('[data-slot="resizable-handle"]') != null,
            onCard: hit?.closest('[data-slot="pane-card"]') != null,
          };
        },
        [x, y] as const,
      ),
      'the grab point is in the gap beside the divider line: on its drag band, on no card',
    ).toEqual({ onDragBand: true, onCard: false });
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(handle).toHaveAttribute('data-separator', 'active');
  await page.mouse.move(x + deltaPx, y, { steps: 8 });
  await readMidDrag();
  await page.mouse.up();
  await expect(handle).not.toHaveAttribute('data-separator', 'active');
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
  await settleFrames(page);
}

for (const grab of GRABS) {
  test(`the side panel keeps its width while the chat divider is dragged from ${grab.label}`, async ({
    page,
    api,
  }) => {
    const docName = `editor-card-side-panel-width-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect
      .poll(() => page.locator('[data-doc-panel-toggle]').getAttribute('aria-expanded'), {
        timeout: 10_000,
      })
      .toBe('true');

    const sidePanel = page.locator('#doc-panel');
    const documentColumn = page.locator('[data-editor-workspace-column]');
    const editorCard = page.locator('[data-slot="pane-card"][data-pane="editor"]');
    await expect(editorCard).toBeVisible();
    await expect(
      editorCard.locator('#doc-panel'),
      'the side panel lives in the editor card',
    ).toHaveCount(1);
    const sidePanelBefore = await widthOf(sidePanel);
    expect(sidePanelBefore).toBeGreaterThanOrEqual(300);

    await openChat(page);
    await expect(sidePanel).not.toBeVisible();
    const chatPanel = page
      .locator(AGENTS_PANEL_MOUNT)
      .locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
    const chatBefore = await widthOf(chatPanel);
    const columnBefore = await widthOf(documentColumn);

    await dragChatDivider(page, grab.offsetPx, -DRAG_PX, async () => {
      await expect(sidePanel).not.toBeVisible();
      expect(
        await widthOf(documentColumn),
        'mid-drag the document column yields to Chat without the information rail',
      ).toBeLessThan(columnBefore - DRAG_PX / 2);
    });

    await expect(sidePanel).not.toBeVisible();
    expect(await widthOf(documentColumn)).toBeGreaterThanOrEqual(300);
    expect(await widthOf(chatPanel)).toBeGreaterThan(chatBefore + DRAG_PX / 2);
    expect(await widthOf(documentColumn)).toBeLessThan(columnBefore - DRAG_PX / 2);

    await dragChatDivider(page, grab.offsetPx, DRAG_PX / 2, async () => {
      await expect(sidePanel).not.toBeVisible();
    });

    expect(await widthOf(documentColumn)).toBeGreaterThan(columnBefore - DRAG_PX);
    await page.getByTestId(AGENTS_HEADER_BUTTON).click();
    await expect(sidePanel).toBeVisible();
    expect(Math.abs((await widthOf(sidePanel)) - sidePanelBefore)).toBeLessThanOrEqual(
      WIDTH_TOLERANCE_PX,
    );
  });
}

test('restored wide sidebars never squeeze the document or cover its information toggle', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `editor-min-width-restored-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '600');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const information = page.locator('#doc-panel');
  const column = page.locator('[data-editor-workspace-column]');
  const toggle = page.locator('[data-doc-panel-toggle]');
  await expect(information).toBeVisible();
  for (const width of [1200, 1100, 1000, 900, 768, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    await settleFrames(page);
    await expect.poll(() => widthOf(column)).toBeGreaterThanOrEqual(300);
    await expect(toggle).toBeVisible();
    await expect
      .poll(() =>
        toggle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await expect(information).toBeVisible();
  await toggle.click();
  await expect(information).toBeHidden();
});

for (const input of ['pointer', 'keyboard']) {
  test(`resizing information with ${input} keeps the document and its toggle usable`, async ({
    page,
    api,
  }) => {
    const docName = `editor-min-width-${input}-${test.info().workerIndex}`;
    await page.addInitScript(() => {
      localStorage.setItem(
        'ok-sidebar-pins-v2',
        JSON.stringify({
          left: { above: 'open', below: 'open', embedded: 'open' },
          right: { above: 'open', below: 'open', embedded: 'open' },
        }),
      );
    });
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const information = page.locator('#doc-panel');
    const column = page.locator('[data-editor-workspace-column]');
    const toggle = page.locator('[data-doc-panel-toggle]');
    await expect(information).toBeVisible();
    const handle = page.locator('[data-doc-panel-handle]');
    if (input === 'pointer') {
      const bounds = await handle.boundingBox();
      if (!bounds) throw new Error('missing information divider bounds');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x - 200, bounds.y + bounds.height / 2, { steps: 12 });
      await settleFrames(page);
      await expect.poll(() => widthOf(column)).toBeGreaterThanOrEqual(300);
      await expect(toggle).toBeVisible();
      await page.mouse.up();
    } else {
      await handle.focus();
      await page.keyboard.press('End');
    }
    await expect.poll(() => widthOf(column)).toBeGreaterThanOrEqual(300);
    await expect(toggle).toBeVisible();
    await expect
      .poll(() =>
        toggle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      )
      .toBe(true);
    await expect(information).toBeVisible();
    await toggle.click();
    await expect(information).toBeHidden();
  });
}

test('constrained docking swaps sidebars, restores both, and preserves explicit hiding and widths', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `editor-sidebar-switch-${crypto.randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '600');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const files = page.locator('[data-sidebar="trigger"]');
  const informationToggle = page.locator('[data-doc-panel-toggle]');
  const information = page.locator('#doc-panel');
  const documentColumn = page.locator('[data-editor-workspace-column]');
  await expect(information).toBeVisible();
  await expect(files).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(files).toHaveAttribute('aria-expanded', 'true');
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await informationToggle.click();
  await expect(information).toBeVisible();
  await expect(files).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-doc-panel-cover]')).toHaveCount(0);
  await expect.poll(() => widthOf(documentColumn)).toBeGreaterThanOrEqual(300);
  await expect.poll(() => widthOf(information)).toBeGreaterThanOrEqual(599);
  await expect
    .poll(async () => {
      const documentBox = await documentColumn.boundingBox();
      const informationBox = await information.boundingBox();
      return documentBox != null && informationBox != null
        ? documentBox.x + documentBox.width - informationBox.x
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
  await informationToggle.press('ControlOrMeta+Alt+KeyS');
  await expect(files).toHaveAttribute('aria-expanded', 'true');
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => widthOf(documentColumn)).toBeGreaterThanOrEqual(300);
  await informationToggle.click();
  await expect(information).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(files).toHaveAttribute('aria-expanded', 'true');
  await expect(information).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(files).toHaveAttribute('aria-expanded', 'true');
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await files.click();
  await expect(information).toBeVisible();
  await expect(files).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(information).toBeVisible();
  await expect(files).toHaveAttribute('aria-expanded', 'false');
  await informationToggle.click();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'sidebar_width')?.value,
  ).toBe('288px');
});

test('asymmetric remembered sidebar widths use one cover regime without replacing their widths', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `editor-sidebar-shared-cover-${crypto.randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '600');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('#doc-panel')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 800 });
  const filesTrigger = page.locator('[data-sidebar="trigger"]');
  const informationToggle = page.locator('[data-doc-panel-toggle]');
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await filesTrigger.click();
  const filesCover = page.locator('[data-files-cover]');
  const card = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  await expect(filesCover).toBeVisible();
  await expect
    .poll(async () => Math.abs((await widthOf(filesCover)) - (await widthOf(card))))
    .toBeLessThanOrEqual(1);
  await page.locator('[data-files-back]').click();
  await expect(filesTrigger).toBeVisible();
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
  await informationToggle.click();
  const informationCover = page.locator('[data-doc-panel-cover]');
  await expect(informationCover).toBeVisible();
  await expect(filesCover).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await widthOf(informationCover)) - (await widthOf(card))))
    .toBeLessThanOrEqual(1);
  await page.locator('[data-doc-panel-back]').press('ControlOrMeta+Alt+KeyS');
  await expect(filesCover).toBeVisible();
  await expect(informationCover).toHaveCount(0);
  await page.locator('[data-files-back]').click();
  await expect(informationToggle).toBeVisible();
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect.poll(() => widthOf(page.locator('#doc-panel'))).toBeGreaterThanOrEqual(599);
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'sidebar_width')?.value,
  ).toBe('288px');
});

test('resized Files and information widths survive reload and shared cover boundaries', async ({
  page,
  api,
}) => {
  const docName = `editor-resized-sidebar-history-${crypto.randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const files = page.locator('[data-slot="sidebar-gap"]');
  const information = page.locator('#doc-panel');
  const filesTrigger = page.locator('[data-sidebar="trigger"]');
  const informationToggle = page.locator('[data-doc-panel-toggle]');
  await expect(page.locator('#app-file-sidebar')).toBeVisible();
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(information).toBeVisible();
  const initialFilesWidth = await widthOf(files);
  const initialInformationWidth = await widthOf(information);

  const filesRail = page.locator('[data-sidebar="rail"]');
  const filesRailBounds = await filesRail.boundingBox();
  if (!filesRailBounds) throw new Error('Files resize rail has no bounds');
  const filesRailX = filesRailBounds.x + filesRailBounds.width / 2;
  const filesRailY = filesRailBounds.y + filesRailBounds.height / 2;
  await page.mouse.move(filesRailX, filesRailY);
  await page.mouse.down();
  await page.mouse.move(filesRailX + 60, filesRailY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => widthOf(files)).toBeGreaterThan(initialFilesWidth + 40);

  const informationHandle = page.locator('[data-doc-panel-handle]');
  const informationHandleBounds = await informationHandle.boundingBox();
  if (!informationHandleBounds) throw new Error('information resize handle has no bounds');
  const informationHandleX = informationHandleBounds.x + informationHandleBounds.width / 2;
  const informationHandleY = informationHandleBounds.y + informationHandleBounds.height / 2;
  await page.mouse.move(informationHandleX, informationHandleY);
  await page.mouse.down();
  await page.mouse.move(informationHandleX - 140, informationHandleY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => widthOf(information)).toBeGreaterThan(initialInformationWidth + 100);

  const rememberedFilesWidth = await widthOf(files);
  const rememberedInformationWidth = await widthOf(information);
  const persistedFilesWidth = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'sidebar_width',
  )?.value;
  expect(persistedFilesWidth).toBeDefined();
  const persistedFilesWidthPx = await page.evaluate((savedWidth) => {
    const parsed = /^(\d+(?:\.\d+)?)(rem|px)$/.exec(savedWidth);
    if (!parsed) throw new Error(`Invalid persisted Files width: ${savedWidth}`);
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number(parsed[1]) * (parsed[2] === 'rem' ? rootFontSize : 1);
  }, persistedFilesWidth ?? '');
  expect(Math.abs(persistedFilesWidthPx - rememberedFilesWidth)).toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const storedWidth = await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'));
      return storedWidth == null
        ? Number.POSITIVE_INFINITY
        : Math.abs(Number.parseFloat(storedWidth) - rememberedInformationWidth);
    })
    .toBeLessThanOrEqual(1);

  await page.reload();
  await waitForActiveProviderSynced(page);
  await expect(page.locator('#app-file-sidebar')).toBeVisible();
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(information).toBeVisible();
  await expect.poll(() => widthOf(files)).toBeCloseTo(rememberedFilesWidth, 0);
  await expect.poll(() => widthOf(information)).toBeCloseTo(rememberedInformationWidth, 0);

  for (const width of [1200, 1000, 800, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await settleFrames(page);
    await expect
      .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
      .toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(informationToggle).toHaveAttribute('aria-expanded', 'false');
  await filesTrigger.click();
  const filesCover = page.locator('[data-files-cover]');
  const card = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  await expect(filesCover).toBeVisible();
  await expect
    .poll(async () => Math.abs((await widthOf(filesCover)) - (await widthOf(card))))
    .toBeLessThanOrEqual(1);
  await page.locator('[data-files-back]').click();
  await informationToggle.click();
  const informationCover = page.locator('[data-doc-panel-cover]');
  await expect(informationCover).toBeVisible();
  await expect(filesCover).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await widthOf(informationCover)) - (await widthOf(card))))
    .toBeLessThanOrEqual(1);
  await page.locator('[data-doc-panel-back]').click();

  for (const width of [800, 1000, 1200, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    await settleFrames(page);
    await expect
      .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
      .toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(information).toBeVisible();
  await expect.poll(() => widthOf(files)).toBeCloseTo(rememberedFilesWidth, 0);
  await expect.poll(() => widthOf(information)).toBeCloseTo(rememberedInformationWidth, 0);
  for (const toggle of [filesTrigger, informationToggle]) {
    await expect
      .poll(() =>
        toggle.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        }),
      )
      .toBe(true);
  }
  const settledWidths = await Promise.all([widthOf(files), widthOf(information)]);
  await settleFrames(page);
  const afterSettling = await Promise.all([widthOf(files), widthOf(information)]);
  expect(Math.abs(afterSettling[0] - settledWidths[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(afterSettling[1] - settledWidths[1])).toBeLessThanOrEqual(1);
});

test('editor covers suppress body-portaled comment and selection controls', async ({
  page,
  api,
}) => {
  const docName = `editor-covered-portals-${crypto.randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: '# Covered portals\n\nA quoted body passage.' }]);
  const created = await page.request.post('/api/comments', {
    data: { docName, quote: 'A quoted body passage.', body: 'A visible comment marker.' },
  });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const marker = page.locator('button[data-comment-thread]');
  const bubble = page.getByTestId('bubble-menu-bar');
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await expect(marker).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await expect(bubble).toBeVisible();
  await page.locator('[data-sidebar="trigger"]').click();
  await expect(page.locator('[data-files-cover]')).toBeVisible();
  await expect(marker).toHaveCount(0);
  await expect(bubble).toBeHidden();
  await page.locator('[data-files-back]').click();
  await expect(marker).toBeVisible();
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await expect(marker).toHaveCount(0);
  await expect(bubble).toBeHidden();
  await page.locator('[data-doc-panel-back]').click();
  await expect(marker).toBeVisible();
});

test('information yields before Files when only the editor card becomes narrow', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-fit-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('#doc-panel')).toBeVisible();
  await openChat(page);
  await expect(page.locator('#doc-panel')).toBeVisible();
  const initialEditorWidth = await widthOf(
    page.locator('[data-slot="pane-card"][data-pane="editor"]'),
  );

  await dragChatDivider(page, 0, -400, async () => {
    expect(await widthOf(page.locator('[data-slot="pane-card"][data-pane="editor"]'))).toBeLessThan(
      900,
    );
  });

  await expect(page.locator('#doc-panel')).not.toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  await expect
    .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
    .toBeGreaterThanOrEqual(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1800);

  await dragChatDivider(page, 0, -320, async () => {});
  const filesTrigger = page.locator('[data-sidebar="trigger"]');
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
  await filesTrigger.click();
  await expect(page.locator('[data-files-cover]')).toBeVisible();
  await expect(page.locator('[data-doc-panel-cover]')).not.toBeVisible();
  await page.locator('[data-files-back]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1800);
  await dragChatDivider(page, 0, 320, async () => {});
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#doc-panel')).not.toBeVisible();
  await dragChatDivider(page, 0, 400, async () => {});
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => widthOf(page.locator('[data-slot="pane-card"][data-pane="editor"]')))
    .toBeGreaterThanOrEqual(initialEditorWidth - 2);
});

test('Escape outside either cover beside Chat leaves it open and focus in place', async ({
  page,
  api,
}) => {
  const docName = `editor-card-cover-escape-scope-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await openChat(page);
  await dragChatDivider(page, 0, -400, async () => {});
  await dragChatDivider(page, 0, -320, async () => {});
  const filesTrigger = page.locator('[data-sidebar="trigger"]');
  await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
  await filesTrigger.click();
  const cover = page.locator('[data-files-cover]');
  await expect(cover).toBeVisible();
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();

  const outside = page
    .locator(`${AGENTS_PANEL_MOUNT} button:not([data-slot="tooltip-trigger"]):visible`)
    .first();
  await outside.focus();
  await expect(outside).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cover).toBeVisible();
  await expect(outside).toBeFocused();

  await page.locator('[data-files-back]').focus();
  await page.keyboard.press('Escape');
  await expect(cover).toBeHidden();

  await page.locator('[data-doc-panel-toggle]').click();
  const informationCover = page.locator('[data-doc-panel-cover]');
  await expect(informationCover).toBeVisible();
  const coverBox = await informationCover.boundingBox();
  if (coverBox == null) throw new Error('information cover has no box');
  await page.mouse.move(coverBox.x + coverBox.width / 2, coverBox.y + coverBox.height / 2);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await outside.focus();
  await expect(outside).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(informationCover).toBeVisible();
  await expect(outside).toBeFocused();

  await page.locator('[data-doc-panel-back]').focus();
  await page.keyboard.press('Escape');
  await expect(informationCover).toBeHidden();
});

test('Files opens as a full editor cover and Back preserves docking intent', async ({
  page,
  api,
}) => {
  const docName = `editor-card-files-cover-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const editorCard = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  const trigger = page.locator('[data-sidebar="trigger"]');
  await trigger.click();
  const cover = page.locator('[data-files-cover]');
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('button', { name: 'Back to editor', exact: true })).toBeFocused();
  await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute('inert', '');
  const cardBounds = await editorCard.boundingBox();
  const coverBounds = await cover.boundingBox();
  expect(Math.abs((cardBounds?.x ?? 0) - (coverBounds?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((cardBounds?.width ?? 0) - (coverBounds?.width ?? 0))).toBeLessThanOrEqual(1);
  for (const width of [320, 360, 430]) {
    await page.setViewportSize({ width, height: 560 });
    await expect(cover.getByRole('button', { name: 'Back to editor', exact: true })).toBeVisible();
    await cover.getByRole('button', { name: 'Tree view options' }).click();
    await expect(page.getByRole('menuitem', { name: 'Hide Files', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(cover).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await cover.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await expect(cover).not.toBeVisible();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-sidebar-project-row]')).toBeVisible();
  await expect(page.locator('[data-files-cover]')).toHaveCount(0);
  await expect(page.locator('[data-files-back]')).toHaveCount(0);
});

test('Files cover keeps Back in view when its sidebar scrolls in a short window', async ({
  page,
  api,
}) => {
  const docName = `editor-card-files-cover-short-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 390, height: 240 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  await page.locator('[data-sidebar="trigger"]').click();
  const cover = page.locator('[data-files-cover]');
  await expect(cover).toBeVisible();
  await cover.getByText('Skills Studio', { exact: true }).click();
  const content = cover.locator('[data-sidebar="content"]');
  await expect
    .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  const rowHeight = await cover
    .locator('[data-sidebar-project-row]')
    .evaluate((element) => element.getBoundingClientRect().height);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(rowHeight);
  const back = cover.getByRole('button', { name: 'Back to editor', exact: true });
  await expect.poll(() => ownsItsCentre(back)).toBe(true);
  await back.click();
  await expect(cover).toHaveCount(0);
});

test('Files cover keeps Back as its first row when there are conflicts', async ({ page, api }) => {
  await page.route('**/api/sync/conflicts', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conflicts: Array.from({ length: 25 }, (_, i) => ({
          file: `folder/conflicted-doc-number-${i}.md`,
          detectedAt: '2026-08-05T00:00:00.000Z',
          conflict: 'merge-native',
          docName: `folder/conflicted-doc-number-${i}`,
          revision: `reviewed-revision-${i}`,
        })),
      }),
    });
  });
  const docName = `editor-card-files-cover-conflicts-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  await page.locator('[data-sidebar="trigger"]').click();
  const cover = page.locator('[data-files-cover]');
  await expect(cover).toBeVisible();
  const conflicts = cover.getByTestId('conflicts-section');
  await expect(conflicts).toBeVisible();
  const row = cover.locator('[data-sidebar-project-row]');
  const back = cover.getByRole('button', { name: 'Back to editor', exact: true });
  const content = cover.locator('[data-sidebar="content"]');
  const [contentBox, rowBox, conflictsBox] = await Promise.all([
    content.boundingBox(),
    row.boundingBox(),
    conflicts.boundingBox(),
  ]);
  expect(Math.abs((rowBox?.y ?? -1) - (contentBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(conflictsBox?.y ?? 0).toBeGreaterThan((rowBox?.y ?? 0) + (rowBox?.height ?? 0) - 1);
  await expect.poll(() => ownsItsCentre(back)).toBe(true);

  const pinnedScroll = (rowBox?.height ?? 0) * 2;
  await content.evaluate((element, top) => {
    element.scrollTop = top;
  }, pinnedScroll);
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(pinnedScroll);
  await expect.poll(() => ownsItsCentre(back)).toBe(true);
});

for (const panel of ['Files', 'information'] as const) {
  test(`${panel} cover replaces the editor header and returns through its own Back control`, async ({
    page,
    api,
  }) => {
    const docName = `editor-cover-header-${panel}-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);

    const editorCard = page.locator('[data-slot="pane-card"][data-pane="editor"]');
    const header = editorCard.locator('[data-editor-area-header]');
    const trigger = page.locator(
      panel === 'Files' ? '[data-sidebar="trigger"]' : '[data-doc-panel-toggle]',
    );
    const cover = page.locator(panel === 'Files' ? '[data-files-cover]' : '[data-doc-panel-cover]');
    await expect(header).toBeVisible();
    await trigger.click();
    await expect(cover).toBeVisible();
    await expect(header).toBeHidden();
    const back = cover.getByRole('button', { name: 'Back to editor', exact: true });
    await expect(back).toBeVisible();
    await expect(back).toBeFocused();
    if (panel === 'Files') {
      await expect(cover.getByRole('heading')).toHaveCount(0);
      const backBox = await back.boundingBox();
      const toolbarBox = await cover.getByRole('group', { name: 'Files toolbar' }).boundingBox();
      expect(backBox).not.toBeNull();
      expect(toolbarBox).not.toBeNull();
      expect(
        Math.abs(
          (backBox?.y ?? 0) +
            (backBox?.height ?? 0) / 2 -
            ((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(1);
    } else {
      await expect(cover.getByRole('heading', { name: docName })).toBeVisible();
    }
    const cardBounds = await editorCard.boundingBox();
    const coverBounds = await cover.boundingBox();
    expect(cardBounds).not.toBeNull();
    expect(coverBounds).not.toBeNull();
    for (const axis of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((cardBounds?.[axis] ?? 0) - (coverBounds?.[axis] ?? 0))).toBeLessThanOrEqual(
        1,
      );
    }
    const screenshotPath = test.info().outputPath(`${panel}-full-editor-cover.png`);
    await editorCard.screenshot({ path: screenshotPath });
    await test.info().attach(`${panel}-full-editor-cover`, {
      path: screenshotPath,
      contentType: 'image/png',
    });
    await back.click();
    await expect(cover).toBeHidden();
    await expect(header).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'Side panel width',
    );
    await trigger.click();
    await expect(cover).toBeVisible();
    await expect(back).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(cover).toBeHidden();
    await expect(header).toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

test('dock and cover moves keep the document panel and Files scroll positions', async ({
  page,
  api,
}) => {
  const index = test.info().workerIndex;
  const docName = `editor-card-scroll-keep-${index}`;
  const headings = Array.from({ length: 80 }, (_, n) => `## Heading ${n}\n\nBody ${n}.`).join(
    '\n\n',
  );
  await api.seedDocs([
    { name: docName, markdown: `# Scroll keep\n\n${headings}` },
    ...Array.from({ length: 60 }, (_, n) => ({
      name: `editor-card-scroll-file-${String(n).padStart(2, '0')}-${index}`,
      markdown: `# File ${n}\n`,
    })),
  ]);
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('#doc-panel').getByRole('tab', { name: 'Outline' }).click();
  const markScroller = (rootSelector: string, marker: string, top: number) =>
    page.evaluate(
      ({ rootSelector, marker, top }) => {
        const root = document.querySelector<HTMLElement>(rootSelector);
        const ancestors: HTMLElement[] = [];
        for (let element = root?.parentElement ?? null; element; element = element.parentElement) {
          ancestors.push(element);
        }
        const scroller = [
          ...Array.from(root?.querySelectorAll<HTMLElement>('*') ?? []),
          ...ancestors,
        ].find(
          (element) =>
            element.scrollHeight > element.clientHeight + 100 &&
            /auto|scroll/.test(getComputedStyle(element).overflowY),
        );
        if (!scroller) return false;
        scroller.setAttribute(marker, '');
        scroller.scrollTo({ top, behavior: 'instant' });
        return true;
      },
      { rootSelector, marker, top },
    );
  const scrollOf = (marker: string) =>
    page.evaluate((marker) => document.querySelector(`[${marker}]`)?.scrollTop ?? -1, marker);
  await expect.poll(() => markScroller('#doc-panel', 'data-test-doc-scroller', 400)).toBe(true);
  await expect.poll(() => scrollOf('data-test-doc-scroller')).toBe(400);
  const trigger = page.locator('[data-sidebar="trigger"]');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const filesTree = page
    .getByRole('tree')
    .filter({ has: page.getByRole('treeitem', { name: /editor-card-scroll-file-/ }) })
    .first();
  await expect(filesTree).toBeVisible();
  const filesScroll = (top?: number) =>
    filesTree.evaluate((tree, top) => {
      const candidates = [
        tree as HTMLElement,
        ...Array.from(tree.querySelectorAll<HTMLElement>('*')),
      ];
      for (let parent = tree.parentElement; parent; parent = parent.parentElement) {
        candidates.push(parent);
      }
      const element = candidates.find(
        (candidate) =>
          candidate.scrollHeight > candidate.clientHeight + 100 &&
          /auto|scroll/.test(getComputedStyle(candidate).overflowY),
      );
      if (!element) return -1;
      if (top !== undefined) element.scrollTo({ top, behavior: 'instant' });
      return element.scrollTop;
    }, top);
  await expect.poll(() => filesScroll(300)).toBe(300);
  await expect.poll(() => filesScroll()).toBe(300);

  await page.setViewportSize({ width: 430, height: 700 });
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await expect.poll(() => scrollOf('data-test-doc-scroller')).toBe(400);
  await page.locator('[data-doc-panel-back]').click();
  await page.locator('[data-sidebar="trigger"]').click();
  await expect(page.locator('[data-files-cover]')).toBeVisible();
  await expect.poll(() => filesScroll()).toBe(300);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-files-cover]')).not.toBeVisible();

  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect.poll(() => scrollOf('data-test-doc-scroller')).toBe(400);
  await expect.poll(() => filesScroll()).toBe(300);
});

test('Files cover folder and asset picks leave focus on a usable control', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `editor-card-files-focus-${test.info().workerIndex}`;
  const folder = `editor-card-files-folder-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: docName, markdown: '# Files focus\n' },
    { name: `${folder}/inside`, markdown: '# Inside folder\n' },
  ]);
  const asset = `editor-card-files-asset-${test.info().workerIndex}.png`;
  writeFileSync(
    join(workerServer.contentDir, asset),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const trigger = page.locator('[data-sidebar="trigger"]');
  const cover = page.locator('[data-files-cover]');
  const focusIsUsable = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return (
        active !== null &&
        active !== document.body &&
        active.closest('[inert]') === null &&
        active.getClientRects().length > 0
      );
    });
  for (const name of [folder, asset]) {
    await trigger.click();
    await expect(cover).toBeVisible();
    await cover.getByRole('treeitem', { name, exact: true }).click();
    await expect(cover).not.toBeVisible();
    await expect.poll(focusIsUsable).toBe(true);
  }
});

test('Escape during text composition does not dismiss either cover', async ({ page, api }) => {
  const docName = `editor-card-ime-escape-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Composition\n' }]);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const composingEscape = () =>
    page.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
      );
    });
  await page.locator('[data-sidebar="trigger"]').click();
  const filesCover = page.locator('[data-files-cover]');
  await expect(filesCover).toBeVisible();
  await composingEscape();
  await expect(filesCover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filesCover).not.toBeVisible();

  await page.locator('[data-doc-panel-toggle]').click();
  const docCover = page.locator('[data-doc-panel-cover]');
  await expect(docCover).toBeVisible();
  await composingEscape();
  await expect(docCover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(docCover).not.toBeVisible();
});

test('Files cover selection reveals its document while Hide keeps Files off after widening', async ({
  page,
  api,
}) => {
  const first = `editor-card-files-first-${test.info().workerIndex}`;
  const second = `editor-card-files-second-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: first, markdown: DOC_MARKDOWN },
    { name: second, markdown: '# Second file\n\nSelected from the Files cover.' },
  ]);
  const readServerDocument = async (name: string) => {
    const response = await page.request.get(`/api/document?docName=${encodeURIComponent(name)}`);
    expect(response.ok()).toBe(true);
    const document = (await response.json()) as { content: string };
    return document.content;
  };
  const originalBytes = await Promise.all([readServerDocument(first), readServerDocument(second)]);
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.goto(`/#/${first}`);
  await waitForActiveProviderSynced(page);

  const trigger = page.locator('[data-sidebar="trigger"]');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => widthOf(page.locator('[data-slot="sidebar-gap"]'))).toBeGreaterThan(200);
  const rememberedWidth = await widthOf(page.locator('[data-slot="sidebar-gap"]'));
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  const cover = page.locator('[data-files-cover]');
  await expect(cover).toBeVisible();
  await cover.getByRole('treeitem', { name: `${second}.md`, exact: true }).click();
  await expect(cover).not.toBeVisible();
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await expect(editor).toContainText('Selected from the Files cover.');
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((element) => element.contains(window.getSelection()?.anchorNode ?? null)),
  ).toBe(true);
  await trigger.click();
  await expect(cover).toBeVisible();
  await cover.getByRole('treeitem', { name: `${second}.md`, exact: true }).click();
  await expect(cover).not.toBeVisible();
  await expect(editor).toContainText('Selected from the Files cover.');
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((element) => element.contains(window.getSelection()?.anchorNode ?? null)),
  ).toBe(true);
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => widthOf(page.locator('[data-slot="sidebar-gap"]')))
    .toBeCloseTo(rememberedWidth, 0);
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('button', { name: /^Hide/ })).toHaveCount(0);
  await cover.getByRole('button', { name: 'Tree view options' }).click();
  await page.getByRole('menuitem', { name: 'Hide Files', exact: true }).click();
  await expect(cover).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#app-file-sidebar')).toHaveAttribute('inert', '');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#app-file-sidebar')).toBeVisible();
  await expect
    .poll(() => widthOf(page.locator('[data-slot="sidebar-gap"]')))
    .toBeCloseTo(rememberedWidth, 0);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Selected from the Files cover.',
  );
  expect(await Promise.all([readServerDocument(first), readServerDocument(second)])).toEqual(
    originalBytes,
  );
});

test('Files menu Hide is reachable by touch and keyboard without a second cover header button', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `editor-files-hide-menu-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    viewport: { width: 320, height: 560 },
  });
  const page = await context.newPage();
  try {
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const trigger = page.locator('[data-sidebar="trigger"]');
    const cover = page.locator('[data-files-cover]');
    await trigger.tap();
    await expect(cover).toBeVisible();
    await expect(cover.getByRole('button', { name: /^Hide/ })).toHaveCount(0);
    await cover.getByRole('button', { name: 'Tree view options' }).tap();
    await page.getByRole('menuitem', { name: 'Hide Files', exact: true }).tap();
    await expect(cover).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await expect(cover.getByRole('button', { name: 'Back to editor', exact: true })).toBeFocused();
    await cover.getByRole('button', { name: 'Tree view options' }).press('Enter');
    const hide = page.getByRole('menuitem', { name: 'Hide Files', exact: true });
    await expect(hide).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByTestId('tree-options-menu')
          .evaluate((menu) => menu.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('End');
    await expect(hide).toBeFocused();
    await hide.press('Enter');
    await expect(cover).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#app-file-sidebar')).toHaveAttribute('inert', '');
  } finally {
    await context.close();
  }
});

test('Files and information covers replace one another without stacking', async ({ page, api }) => {
  const pageErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const failingResponses: Array<{ status: number; path: string }> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      consoleWarnings.push(message.text());
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failingResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
    }
  });
  const docName = `editor-card-cover-switch-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const files = page.locator('[data-files-cover]');
  const information = page.locator('[data-doc-panel-cover]');
  const filesTrigger = page.locator('[data-sidebar="trigger"]');
  const informationToggle = page.locator('[data-doc-panel-toggle]');
  const filesBack = files.locator('[data-files-back]');
  const informationBack = information.locator('[data-doc-panel-back]');
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  const editorHeader = page.locator('[data-editor-area-header]');
  const visibleCovers = page.locator('[data-files-cover]:visible, [data-doc-panel-cover]:visible');

  await filesTrigger.click();
  await expect(files).toBeVisible();
  await expect(visibleCovers).toHaveCount(1);
  await expect(filesBack).toBeFocused();
  await page.keyboard.press('Alt+Meta+B');
  await expect(files).not.toBeVisible();
  await expect(information).toBeVisible();
  await expect(visibleCovers).toHaveCount(1);
  await expect(informationBack).toBeFocused();
  await page.keyboard.press('Alt+Meta+S');
  await expect(information).not.toBeVisible();
  await expect(files).toBeVisible();
  await expect(visibleCovers).toHaveCount(1);
  await expect(filesBack).toBeFocused();

  await filesBack.click();
  await expect(visibleCovers).toHaveCount(0);
  await expect(editorHeader).toBeVisible();
  await expect(filesTrigger).toBeFocused();

  await informationToggle.click();
  await expect(information).toBeVisible();
  await expect(informationBack).toBeFocused();
  await informationBack.click();
  await expect(visibleCovers).toHaveCount(0);
  await expect(editorHeader).toBeVisible();
  await expect(informationToggle).toBeFocused();

  await informationToggle.click();
  await expect(information).toBeVisible();
  await expect(informationBack).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(visibleCovers).toHaveCount(0);
  await expect(editorHeader).toBeVisible();
  await expect(informationToggle).toBeFocused();

  await filesTrigger.click();
  await expect(files).toBeVisible();
  await expect(filesBack).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(visibleCovers).toHaveCount(0);
  await expect(editorHeader).toBeVisible();
  await expect(filesTrigger).toBeFocused();

  await editor.locator('p').last().click();
  await expect(editor).toBeFocused();
  await page.keyboard.type(' Cover dismissed.');
  await expect(editor).toContainText('Cover dismissed.');
  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(
    await editor.evaluate((element, bounds) => {
      const hit = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      return hit !== null && element.contains(hit);
    }, editorBounds),
  ).toBe(true);

  const screenshotPath = test.info().outputPath('Files-information-cover-switching.png');
  await page.screenshot({ path: screenshotPath });
  await test.info().attach('Files-information-cover-switching', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  const signalsPath = test.info().outputPath('Files-information-runtime-signals.json');
  writeFileSync(signalsPath, JSON.stringify({ pageErrors, consoleWarnings, failingResponses }));
  await test.info().attach('Files-information-runtime-signals', {
    path: signalsPath,
    contentType: 'application/json',
  });
  expect(pageErrors).toEqual([]);
});

for (const rememberedFilesWidth of [234, 288, 512]) {
  test(`Files fitting retains its ${rememberedFilesWidth}px remembered dock width`, async ({
    page,
    api,
    baseURL,
  }) => {
    const docName = `editor-card-files-width-${rememberedFilesWidth}-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page
      .context()
      .addCookies([{ name: 'sidebar_width', value: `${rememberedFilesWidth}px`, url: baseURL }]);
    await page.addInitScript(() => {
      localStorage.setItem(
        'ok-sidebar-pins-v2',
        JSON.stringify({ left: { above: 'open', below: 'open', embedded: 'open' } }),
      );
    });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const trigger = page.locator('[data-sidebar="trigger"]');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const dockedWidth = await widthOf(page.locator('[data-slot="sidebar-gap"]'));
    expect(Math.abs(dockedWidth - rememberedFilesWidth)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 650, height: 700 });
    if (rememberedFilesWidth === 512) {
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.click();
      await expect(page.locator('[data-files-cover]')).toBeVisible();
      await page.locator('[data-files-back]').click();
    } else {
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
        .toBeGreaterThanOrEqual(300);
    }
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(async () =>
        Math.abs((await widthOf(page.locator('[data-slot="sidebar-gap"]'))) - dockedWidth),
      )
      .toBeLessThanOrEqual(1);
    expect(
      (await page.context().cookies(baseURL)).find((cookie) => cookie.name === 'sidebar_width')
        ?.value,
    ).toBe(`${rememberedFilesWidth}px`);
  });
}

test('information cover Back restores docking while Hide keeps it closed', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-cover-${crypto.randomUUID()}`;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const information = page.locator('#doc-panel');
  await expect(information).toBeVisible();
  await information.getByRole('tab', { name: 'Links' }).click();
  await expect(information.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
  const dockedInformationWidth = await widthOf(information);
  await openChat(page);
  await expect(information).toBeVisible();
  await dragChatDivider(page, 0, -400, async () => {});
  await dragChatDivider(page, 0, -320, async () => {});
  await expect(information).not.toBeVisible();

  const editorCard = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  const toggle = page.locator('[data-doc-panel-toggle]');
  const constrainedEditorWidth = await widthOf(editorCard);
  expect(constrainedEditorWidth).toBeLessThan(620);
  const savedWidthBefore = await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'));
  await toggle.click();
  const cover = page.locator('[data-doc-panel-cover]');
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
  await expect(page.locator('[data-doc-panel-back]')).toBeFocused();
  await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-doc-panel-handle]')).not.toBeVisible();
  const cardBounds = await editorCard.boundingBox();
  const coverBounds = await cover.boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(coverBounds).not.toBeNull();
  expect(Math.abs((cardBounds?.x ?? 0) - (coverBounds?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((cardBounds?.width ?? 0) - (coverBounds?.width ?? 0))).toBeLessThanOrEqual(1);
  const coverScreenshot = test.info().outputPath('qa-020-information-cover.png');
  await page.screenshot({ path: coverScreenshot, fullPage: true });
  await test.info().attach('qa-020-information-cover', {
    path: coverScreenshot,
    contentType: 'image/png',
  });

  await page.locator('[data-doc-panel-back]').click();
  await expect(cover).not.toBeVisible();
  await expect(toggle).toBeFocused();
  await dragChatDivider(page, 0, 320, async () => {});
  await dragChatDivider(page, 0, 400, async () => {});
  await expect(information).toBeVisible();
  await expect(information.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
  await expect
    .poll(async () => Math.abs((await widthOf(information)) - dockedInformationWidth))
    .toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe(
    savedWidthBefore,
  );

  await dragChatDivider(page, 0, -400, async () => {});
  await dragChatDivider(page, 0, -320, async () => {});
  await expect(information).not.toBeVisible();
  await toggle.click();
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
  await page.locator('[data-doc-panel-hide]').click();
  await expect(cover).not.toBeVisible();
  await dragChatDivider(page, 0, 320, async () => {});
  await dragChatDivider(page, 0, 400, async () => {});
  await expect(information).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const hiddenScreenshot = test.info().outputPath('qa-020-information-hidden.png');
  await page.screenshot({ path: hiddenScreenshot, fullPage: true });
  await test.info().attach('qa-020-information-hidden', {
    path: hiddenScreenshot,
    contentType: 'image/png',
  });
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe(
    savedWidthBefore,
  );
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  console.log(
    JSON.stringify({
      scenario: 'QA-020',
      constrainedEditorWidth,
      dockedInformationWidth,
      selectedTab: 'Links',
      backRestoredInformation: true,
      hideKeptInformationClosed: true,
      savedWidthBefore,
      savedWidthAfter: await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1')),
      pageErrors,
      consoleErrors,
    }),
  );
});

test('navigating from an information cover to a folder releases the Editor inset', async ({
  page,
  api,
}) => {
  const folder = `editor-card-cover-folder-${test.info().workerIndex}`;
  await api.seedDocs([{ name: `${folder}/document`, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${folder}/document`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await page.evaluate((nextFolder) => {
    window.location.hash = `#/${nextFolder}`;
  }, folder);
  await expect(page.locator('[data-doc-panel-cover]')).not.toBeVisible();
  await expect(page.locator('[data-slot="sidebar-inset"]')).not.toHaveAttribute('inert', '');
  await expect(page.getByTestId('header-pane-button-editor')).toBeFocused();
});

test('resize docking preserves focus in the Files and information panels', async ({
  page,
  api,
}) => {
  const docName = `editor-card-cover-focus-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  await page.locator('[data-sidebar="trigger"]').click();
  const filesCover = page.locator('[data-files-cover]');
  const file = filesCover.getByRole('treeitem', { name: `${docName}.md`, exact: true });
  await file.focus();
  await expect(file).toBeFocused();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(filesCover).not.toBeVisible();
  await expect(page.getByRole('treeitem', { name: `${docName}.md`, exact: true })).toBeFocused();

  await page.setViewportSize({ width: 430, height: 700 });
  await page.locator('[data-doc-panel-toggle]').click();
  const infoCover = page.locator('[data-doc-panel-cover]');
  const outline = infoCover.getByRole('tab', { name: 'Outline' });
  await outline.focus();
  await expect(outline).toBeFocused();
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(infoCover).not.toBeVisible();
  await expect(page.locator('#doc-panel').getByRole('tab', { name: 'Outline' })).toBeFocused();
});

test.describe('information cover on a short touch viewport', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 480 } });

  test('Hide remains reachable with long labels and keeps information closed after widening', async ({
    page,
    api,
  }) => {
    const docName = `editor-card-info-touch-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?lang=pseudo#/${docName}`);
    await waitForActiveProviderSynced(page);

    const toggle = page.locator('[data-doc-panel-toggle]');
    await expect(toggle).toBeVisible();
    await toggle.tap();
    const cover = page.locator('[data-doc-panel-cover]');
    const back = cover.locator('[data-doc-panel-back]');
    const hide = cover.locator('[data-doc-panel-hide]');
    await expect(cover).toBeVisible();
    await expect(back).toBeFocused();
    await expect(hide).toHaveAccessibleName('Ĥĩďē ƥàńēĺ');
    await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute('inert', '');
    const controlsFit = await page.evaluate(() => {
      const cover = document.querySelector('[data-doc-panel-cover]');
      const back = document.querySelector('[data-doc-panel-back]');
      const hide = document.querySelector('[data-doc-panel-hide]');
      if (!cover || !back || !hide) return false;
      const bounds = [cover, back, hide].map((element) => element.getBoundingClientRect());
      return bounds.every(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight,
      );
    });
    expect(controlsFit).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );

    await hide.tap();
    await expect(cover).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await page.setViewportSize({ width: 1000, height: 480 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#doc-panel')).not.toBeVisible();
  });

  test('Back remains reachable and returns focus in a right-to-left interface', async ({
    page,
    api,
  }) => {
    const docName = `editor-card-info-rtl-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ok-language-v1')))
      .not.toBeNull();
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const toggle = page.locator('[data-doc-panel-toggle]');
    await toggle.tap();
    const cover = page.locator('[data-doc-panel-cover]');
    const back = cover.locator('[data-doc-panel-back]');
    const hide = cover.locator('[data-doc-panel-hide]');
    await expect(cover).toBeVisible();
    await expect(back).toBeFocused();
    for (const control of [back, hide]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
    }
    await back.tap();
    await expect(cover).not.toBeVisible();
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  });
});

test('information cover Back returns focus to the visible header when its opener detaches', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-detached-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const toggle = page.locator('[data-doc-panel-toggle]');
  await toggle.click();
  const cover = page.locator('[data-doc-panel-cover]');
  await expect(cover).toBeVisible();
  await toggle.evaluate((element) => element.remove());
  await cover.locator('[data-doc-panel-back]').click();
  await expect(cover).not.toBeVisible();
  await expect(page.getByTestId('header-pane-button-editor')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.closest('[inert]'))).toBeNull();
});

test('information cover keeps every document tab usable at narrow browser widths', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-tabs-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('#doc-panel')).not.toBeVisible();

  const toggle = page.locator('[data-doc-panel-toggle]');
  await toggle.click();
  const cover = page.locator('[data-doc-panel-cover]');
  await expect(cover).toBeVisible();
  for (const label of ['Outline', 'Links', 'Graph', 'Timeline', 'Problems', 'Comments']) {
    const tab = cover.getByRole('tab', { name: label });
    await tab.click();
    await expect(tab).toHaveAttribute('data-state', 'on');
    await expect(cover).toBeVisible();
  }
  await cover.getByRole('tab', { name: 'Graph' }).click();
  await cover.getByRole('button', { name: 'Expand graph' }).click();
  await expect(page.getByRole('button', { name: 'Collapse graph' })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('button', { name: 'Expand graph' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cover).not.toBeVisible();
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);

  await page.setViewportSize({ width: 320, height: 480 });
  await expect(toggle).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await page.setViewportSize({ width: 650, height: 700 });
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect
    .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
    .toBeGreaterThanOrEqual(300);
  expect(await widthOf(page.locator('[data-editor-workspace-column]'))).toBeLessThan(350);
  await expect(toggle).toBeVisible();
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(' editor fit');
  await expect(editor).toContainText('editor fit');
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.querySelector('[data-editor-workspace-column]')?.getBoundingClientRect()
      .width,
    information: document.querySelector('#doc-panel')?.getBoundingClientRect().width,
    page: document.documentElement.scrollWidth,
  }));
  await test.info().attach('information-fit.json', {
    body: JSON.stringify(geometry),
    contentType: 'application/json',
  });
  await test.info().attach('information-fit.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  for (const [width, docked] of [
    [620, false],
    [650, true],
    [620, false],
    [650, true],
  ] as const) {
    await page.setViewportSize({ width, height: 700 });
    if (docked) await expect(page.locator('#doc-panel')).toBeVisible();
    else await expect(page.locator('#doc-panel')).not.toBeVisible();
    await settleFrames(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('editor mode controls remain usable beside information at the document fit budget', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-control-fit-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('#doc-panel')).toBeVisible();
  await page.setViewportSize({ width: 650, height: 700 });
  await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#doc-panel')).not.toBeVisible();
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
    .toBeGreaterThanOrEqual(300);
  expect(await widthOf(page.locator('[data-editor-workspace-column]'))).toBeLessThan(350);

  const sourceMode = page.getByRole('radio', { name: 'Markdown source' });
  await expect(sourceMode).toBeInViewport();
  await sourceMode.click();
  const sourceEditor = page.locator('.cm-editor').first();
  await expect(sourceEditor).toBeVisible();
  await sourceEditor.locator('.cm-content').click();
  await page.keyboard.type('source fit');
  await expect(sourceEditor).toContainText('source fit');
  await page.getByRole('radio', { name: 'Visual editor' }).click();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'source fit',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(650);
});

test('browser zoom keeps the information cover and editor controls usable', async ({
  api,
  baseURL,
}) => {
  const docName = `editor-card-browser-zoom-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  const extensionDir = test.info().outputPath('browser-zoom-extension');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Open Knowledge browser zoom test',
      version: '1.0.0',
      permissions: ['tabs'],
      background: { service_worker: 'background.js' },
    }),
  );
  writeFileSync(
    join(extensionDir, 'background.js'),
    'chrome.runtime.onInstalled.addListener(() => {});\n',
  );

  const browserContext = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 720 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  try {
    const zoomPage = await browserContext.newPage();
    await zoomPage.goto(`${baseURL}/#/${docName}`);
    await waitForActiveProviderSynced(zoomPage);
    const editor = zoomPage.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(editor).toBeVisible();
    await expect(zoomPage.locator('#doc-panel')).toBeVisible();
    await expect(zoomPage.locator('[data-sidebar="sidebar"]')).toBeVisible();
    const before = await zoomPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      visualScale: window.visualViewport?.scale,
    }));
    const serviceWorker =
      browserContext.serviceWorkers()[0] ?? (await browserContext.waitForEvent('serviceworker'));
    const browserZoom = await serviceWorker.evaluate(
      async ({ origin, factor }) => {
        const tabs = (
          globalThis as typeof globalThis & {
            chrome: {
              tabs: {
                query(queryInfo: object): Promise<Array<{ id?: number; url?: string }>>;
                getZoom(tabId: number): Promise<number>;
                getZoomSettings(tabId: number): Promise<{ mode?: string; scope?: string }>;
                setZoomSettings(
                  tabId: number,
                  settings: { mode: string; scope: string },
                ): Promise<void>;
                setZoom(tabId: number, factor: number): Promise<void>;
              };
            };
          }
        ).chrome.tabs;
        const tab = (await tabs.query({})).find((candidate) => candidate.url?.startsWith(origin));
        if (tab?.id === undefined) throw new Error('the app tab is unavailable for browser zoom');
        const initialFactor = await tabs.getZoom(tab.id);
        await tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
        await tabs.setZoom(tab.id, factor);
        return {
          initialFactor,
          factor: await tabs.getZoom(tab.id),
          settings: await tabs.getZoomSettings(tab.id),
        };
      },
      { origin: baseURL, factor: 2.25 },
    );
    expect(browserZoom.initialFactor).toBe(1);
    expect(browserZoom.factor).toBe(2.25);
    expect(browserZoom.settings).toMatchObject({ mode: 'automatic', scope: 'per-tab' });
    const after = await zoomPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      visualScale: window.visualViewport?.scale,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(zoomPage.viewportSize()).toEqual({ width: 1400, height: 720 });
    expect(after.innerWidth).toBeLessThan(before.innerWidth);
    expect(after.devicePixelRatio).toBeGreaterThan(before.devicePixelRatio);
    expect(after.visualScale).toBe(1);
    await expect(zoomPage.locator('#doc-panel')).not.toBeVisible();
    const toggle = zoomPage.locator('[data-doc-panel-toggle]');
    await expect(toggle).toBeInViewport();
    await toggle.click();
    const cover = zoomPage.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    await expect(cover.locator('[data-doc-panel-back]')).toBeInViewport();
    await expect(cover.locator('[data-doc-panel-hide]')).toBeInViewport();
    await expect(zoomPage.locator('[data-slot="sidebar-inset"]')).toHaveAttribute('inert', '');
    await cover.locator('[data-doc-panel-back]').click();
    await expect(cover).not.toBeVisible();
    const sourceMode = zoomPage.getByRole('radio', { name: 'Markdown source' });
    await expect(sourceMode).toBeInViewport();
    await sourceMode.click();
    const sourceEditor = zoomPage.locator('.cm-editor').first();
    await expect(sourceEditor).toBeVisible();
    await sourceEditor.locator('.cm-content').click();
    await zoomPage.keyboard.type('browser zoom fit');
    await expect(sourceEditor).toContainText('browser zoom fit');
    await expect
      .poll(() => widthOf(zoomPage.locator('[data-editor-workspace-column]')))
      .toBeGreaterThanOrEqual(300);
    const finalGeometry = await zoomPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      documentWidth: document
        .querySelector('[data-editor-workspace-column]')
        ?.getBoundingClientRect().width,
    }));
    expect(finalGeometry.scrollWidth).toBeLessThanOrEqual(finalGeometry.innerWidth);
    const geometryPath = test.info().outputPath('browser-zoom-fit.json');
    writeFileSync(geometryPath, JSON.stringify({ before, browserZoom, after, finalGeometry }));
    await test.info().attach('browser-zoom-fit.json', {
      path: geometryPath,
      contentType: 'application/json',
    });
    await test.info().attach('browser-zoom-fit.png', {
      body: await zoomPage.screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await browserContext.close();
  }
});

test('each selected information tab survives automatic suppression and temporary cover dismissal', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-selected-tabs-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const panel = page.locator('#doc-panel');
  const cover = page.locator('[data-doc-panel-cover]');
  const toggle = page.locator('[data-doc-panel-toggle]');
  await expect(panel).toBeVisible();

  for (const label of ['Outline', 'Links', 'Graph', 'Timeline', 'Problems', 'Comments']) {
    const tab = panel.getByRole('tab', { name: label });
    await tab.click();
    await expect(tab).toHaveAttribute('data-state', 'on');
    await page.setViewportSize({ width: 430, height: 700 });
    await expect(panel).not.toBeVisible();
    await toggle.click();
    await expect(cover).toBeVisible();
    await expect(cover.getByRole('tab', { name: label })).toHaveAttribute('data-state', 'on');
    await cover.locator('[data-doc-panel-back]').click();
    await expect(cover).not.toBeVisible();
    await page.setViewportSize({ width: 1400, height: 700 });
    await expect(panel).toBeVisible();
    await expect(tab).toHaveAttribute('data-state', 'on');
  }
});

test('selected Activity yields with the information panel and returns after widening', async ({
  page,
  api,
}) => {
  const docName = `editor-card-activity-fit-${test.info().workerIndex}`;
  const agentName = 'Activity Fit Agent';
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const panel = page.locator('#doc-panel');
  await expect(panel).toBeVisible();
  await api.writeAsAgent(docName, `${DOC_MARKDOWN}\n\nActivity update`, {
    agentId: `activity-fit-${crypto.randomUUID().slice(0, 8)}`,
    agentName,
    clientName: 'claude-code',
  });
  const avatar = page
    .locator(`[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="${agentName}"]`)
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  await expect(panel.getByTestId('activity-panel')).toBeVisible();

  await page.setViewportSize({ width: 620, height: 700 });
  await expect(panel).not.toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  await expect
    .poll(() => widthOf(page.locator('[data-editor-workspace-column]')))
    .toBeGreaterThanOrEqual(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(620);

  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await expect(cover.getByTestId('activity-panel')).toBeVisible();
  await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute('inert', '');
  await cover.locator('[data-doc-panel-back]').click();
  await expect(cover).not.toBeVisible();
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(panel.getByTestId('activity-panel')).toBeVisible();
});

test('Outline destination reveals its heading from the information cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-outline-destination-${test.info().workerIndex}`;
  await api.seedDocs([
    {
      name: docName,
      markdown: `# First heading\n\n${'Long paragraph. '.repeat(180)}\n\n## Destination heading\n\nTarget body.\n\n## Following heading\n\nMore body.`,
    },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  const mountedEditor = await editor.elementHandle();
  if (!mountedEditor) throw new Error('active editor has no mounted element');
  await expect(cover).toBeVisible();
  await cover.getByRole('button', { name: 'Destination heading' }).click();
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror h2', { hasText: 'Destination heading' })).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate(
      (element, mounted) => element === mounted && mounted.isConnected,
      mountedEditor,
    ),
  ).toBe(true);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('[data-doc-panel-toggle]').click();
  await cover.getByRole('button', { name: 'Destination heading' }).click();
  await expect(cover).not.toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
  await expect(page.locator('.ProseMirror h2', { hasText: 'Destination heading' })).toBeVisible();
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate(
      (element, mounted) => element === mounted && mounted.isConnected,
      mountedEditor,
    ),
  ).toBe(true);
});

test('Links backlink reveals its document from the information cover', async ({ page, api }) => {
  const source = `editor-card-backlink-source-${test.info().workerIndex}`;
  const target = `editor-card-backlink-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: `# Source\n\n[[${target}]]` },
    { name: target, markdown: '# Target\n\nBacklink destination.' },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${target}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  await cover.getByRole('link', { name: 'Source' }).click();
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${source}$`));
  await expect(page.locator('.ProseMirror h1', { hasText: 'Source' })).toBeVisible();
  await expect(page.locator('.ProseMirror h1', { hasText: 'Target' })).toBeHidden();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
});

for (const order of ['destination first', 'resize first'] as const) {
  test(`a Links destination racing a narrowing resize settles on the destination (${order})`, async ({
    page,
    api,
  }) => {
    const source = `editor-card-race-source-${order.split(' ')[0]}-${test.info().workerIndex}`;
    const target = `editor-card-race-target-${order.split(' ')[0]}-${test.info().workerIndex}`;
    await api.seedDocs([
      { name: source, markdown: `# Race source\n\n[[${target}]]` },
      { name: target, markdown: '# Race target\n\nRace destination.' },
    ]);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/#/${target}`);
    await waitForActiveProviderSynced(page);
    const agentsButton = page.getByTestId(AGENTS_HEADER_BUTTON);
    await agentsButton.click();
    await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
    await page.locator('[data-doc-panel-toggle]').click();
    const cover = page.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    await cover.getByRole('tab', { name: 'Links' }).click();
    const backlink = cover.getByRole('link', { name: 'Race source' });
    await expect(backlink).toBeVisible();
    if (order === 'destination first') {
      await backlink.click();
      await page.setViewportSize({ width: 700, height: 700 });
    } else {
      await page.setViewportSize({ width: 700, height: 700 });
      await page
        .locator('[data-doc-panel-cover], #doc-panel')
        .getByRole('link', { name: 'Race source' })
        .click();
    }
    await expect(page).toHaveURL(new RegExp(`#/${source}$`));
    await expect(cover).not.toBeVisible();
    await expect(page.locator('[data-slot="pane-card"][data-pane="editor"]')).toBeVisible();
    await expect(page.locator('[data-slot="pane-card"][data-pane="agents"]')).toBeHidden();
    await expect(page.locator('.ProseMirror h1', { hasText: 'Race source' })).toBeVisible();
    if (order === 'destination first') {
      await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
    }
    await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
}

test('Links forward destination reveals its document from the information cover', async ({
  page,
  api,
}) => {
  const source = `editor-card-forward-source-${test.info().workerIndex}`;
  const target = `editor-card-forward-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: `# Source\n\n[[${target}]]` },
    { name: target, markdown: '# Forward destination\n\nTarget body.' },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  const sourceHeading = page.locator('.ProseMirror h1', { hasText: 'Source' });
  const targetHeading = page.locator('.ProseMirror h1', { hasText: 'Forward destination' });
  for (let visit = 0; visit < 2; visit += 1) {
    await cover.getByRole('link', { name: 'Forward destination' }).click();
    await expect(cover).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/${target}$`));
    await expect(targetHeading).toBeVisible();
    await expect(sourceHeading).toBeHidden();
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
    if (visit === 1) break;
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(cover.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
    await cover.getByRole('link', { name: 'Source' }).click();
    await expect(cover).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/${source}$`));
    await expect(sourceHeading).toBeVisible();
    await expect(targetHeading).toBeHidden();
    await page.locator('[data-doc-panel-toggle]').click();
  }
});

test('Links successful page creation reveals its document from the information cover', async ({
  page,
  api,
  workerServer,
}) => {
  const source = `editor-card-create-source-${test.info().workerIndex}`;
  const target = `editor-card-created-${test.info().workerIndex}`;
  await api.seedDocs([{ name: source, markdown: `# Source\n\n[[${target}]]` }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  await cover.getByRole('button', { name: /Missing page:.*Click to create/ }).click();
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    target,
  );
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible();
  await expect(page.locator('[data-slot="document-error-boundary"]')).toHaveCount(0);
  expect(readdirSync(workerServer.contentDir).filter((name) => name.startsWith(target))).toEqual([
    `${target}.md`,
  ]);
});

test('Links page creation cannot be activated twice while its delayed request is pending', async ({
  page,
  api,
  workerServer,
}) => {
  const source = `editor-card-double-create-source-${test.info().workerIndex}`;
  const target = `editor-card-double-created-${test.info().workerIndex}`;
  await api.seedDocs([{ name: source, markdown: `# Source\n\n[[${target}]]` }]);
  let createRequests = 0;
  let releaseCreate: () => void = () => {};
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route('**/api/create-page', async (route) => {
    createRequests += 1;
    await createHeld;
    await route.continue();
  });
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  const create = cover.getByRole('button', { name: /Missing page:.*Click to create/ });
  await create.click();
  await expect.poll(() => createRequests).toBe(1);
  expect((await create.isVisible()) && (await create.isEnabled())).toBe(false);
  releaseCreate();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(cover).not.toBeVisible();
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    target,
  );
  await expect
    .poll(() =>
      readdirSync(workerServer.contentDir)
        .filter((name) => name.startsWith(target))
        .sort(),
    )
    .toEqual([`${target}.md`]);
  expect(readdirSync(workerServer.contentDir).filter((name) => /^untitled/i.test(name))).toEqual(
    [],
  );
  expect(createRequests).toBe(1);
});

test('compact Graph destination reveals its document from the information cover', async ({
  page,
  api,
}) => {
  const source = `editor-card-graph-source-${test.info().workerIndex}`;
  const target = `editor-card-graph-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: `# Source\n\n[[${target}]]` },
    { name: target, markdown: '# Graph destination\n\nTarget body.' },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Graph' }).click();
  await page.waitForFunction(
    (docName) =>
      window.__graphHarness?.getNodeVisualState(docName) !== null &&
      window.__graphHarness?.getNodeVisualState(docName) !== undefined,
    target,
  );
  expect(await page.evaluate((docName) => window.__graphHarness?.clickDoc(docName), target)).toBe(
    true,
  );
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(page.locator('.ProseMirror h1', { hasText: 'Graph destination' })).toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
});

test('Links local reference reveals its source location from the information cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-local-reference-${test.info().workerIndex}`;
  await api.seedDocs([
    {
      name: docName,
      markdown: `# Local reference\n\n${'Long paragraph. '.repeat(180)}\n\n[Attachment](missing.pdf)`,
    },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  await cover.getByRole('button', { name: /Missing file.*Go to reference/ }).click();
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
  await expect(
    page.locator('.ProseMirror').getByText('Attachment', { exact: true }),
  ).toBeInViewport();
  await expect(
    page.locator('.ProseMirror h1', { hasText: 'Local reference' }),
  ).not.toBeInViewport();
});

test('expanded Graph inspection stays in its cover until Open reveals a document', async ({
  page,
  api,
}) => {
  const source = `editor-card-expanded-graph-source-${test.info().workerIndex}`;
  const target = `editor-card-expanded-graph-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: `# Source\n\n[[${target}]]` },
    { name: target, markdown: '# Expanded destination\n\nTarget body.' },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Graph' }).click();
  await cover.getByRole('button', { name: 'Expand graph' }).click();
  await page.waitForFunction(
    (docName) => window.__graphHarness?.getNodeVisualState(docName) != null,
    target,
  );
  await page.getByRole('radio', { name: 'Hubs' }).click();
  await expect(page.getByRole('radio', { name: 'Hubs' })).toBeChecked();
  await expect(cover).toBeVisible();
  await page.getByRole('radio', { name: 'Explore' }).click();
  await expect(cover).toBeVisible();
  await page.waitForFunction(
    (docName) => window.__graphHarness?.getNodeVisualState(docName) != null,
    target,
  );
  expect(await page.evaluate((docName) => window.__graphHarness?.clickDoc(docName), target)).toBe(
    true,
  );
  await expect(cover).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${source}$`));
  const selected = page.getByRole('status', { name: 'Selected graph item' });
  await selected.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(page.locator('.ProseMirror h1', { hasText: 'Expanded destination' })).toBeVisible();
});

test('expanded Graph Create reveals a missing document from the information cover', async ({
  page,
  api,
  workerServer,
}) => {
  const source = `editor-card-graph-create-source-${test.info().workerIndex}`;
  const target = `editor-card-graph-create-target-${test.info().workerIndex}`;
  await api.seedDocs([{ name: source, markdown: `# Source\n\n[[${target}]]` }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Graph' }).click();
  await cover.getByRole('button', { name: 'Expand graph' }).click();
  await page.waitForFunction(
    (docName) => window.__graphHarness?.getNodeVisualState(docName) != null,
    target,
  );
  expect(await page.evaluate((docName) => window.__graphHarness?.clickDoc(docName), target)).toBe(
    true,
  );
  await expect(cover).toBeVisible();
  const selected = page.getByRole('status', { name: 'Selected graph item' });
  await selected.getByRole('button', { name: 'Create page' }).click();
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(page.locator('[data-slot="document-error-boundary"]')).toHaveCount(0);
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    target,
  );
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('Created from the graph');
  await expect
    .poll(() => readdirSync(workerServer.contentDir).filter((name) => name.startsWith(target)))
    .toEqual([`${target}.md`]);
  await expect
    .poll(() => readFileSync(join(workerServer.contentDir, `${target}.md`), 'utf-8'))
    .toContain('Created from the graph');
});

test('failed expanded Graph destination keeps its inspection in the information cover', async ({
  page,
  context,
  api,
}) => {
  const source = `editor-card-graph-failed-source-${test.info().workerIndex}`;
  const target = `editor-card-graph-failed-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: `# Source\n\n[[${target}]]` },
    { name: target, markdown: '# Unavailable destination\n' },
  ]);
  let disconnectDestination = false;
  await context.routeWebSocket(/collab/, (socket) => {
    if (disconnectDestination) {
      socket.close();
      return;
    }
    socket.connectToServer();
  });
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Graph' }).click();
  await cover.getByRole('button', { name: 'Expand graph' }).click();
  await page.waitForFunction(
    (docName) => window.__graphHarness?.getNodeVisualState(docName) != null,
    target,
  );
  expect(await page.evaluate((docName) => window.__graphHarness?.clickDoc(docName), target)).toBe(
    true,
  );
  disconnectDestination = true;
  const selected = page.getByRole('status', { name: 'Selected graph item' });
  await selected.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('button', { name: 'Back to editor', exact: true })).toBeVisible();
  await expect(selected).toBeVisible();
  await expect(selected).toContainText('Selected in graph');
  await expect(selected).not.toContainText('Already open');
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Connection lost' }),
  ).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active !== document.body && active.closest('[inert]') === null;
    }),
  ).toBe(true);
});

test('failed Links page creation keeps the information cover usable', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `editor-card-failed-link-create-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Source\n\n[[missing-target]]' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Links' }).click();
  await page.route('**/api/create-page', (route) =>
    route.fulfill({
      status: 507,
      contentType: 'application/problem+json',
      json: { title: 'Not enough storage to create the page' },
    }),
  );
  const create = cover.getByRole('button', { name: /Missing page:.*Click to create/ });
  await create.click();
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Not enough storage to create the page' }),
  ).toBeVisible();
  await expect(cover).toBeVisible();
  await expect(cover.getByRole('button', { name: 'Back to editor', exact: true })).toBeVisible();
  await expect(cover.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
  await expect(page).toHaveURL(new RegExp(`#/${docName}$`));
  expect(existsSync(join(workerServer.contentDir, 'missing-target.md'))).toBe(false);
  await expect(create).toBeEnabled();
  await page.unroute('**/api/create-page');
  await create.click();
  await expect(cover).not.toBeVisible();
  await expect(page).toHaveURL(/#\/missing-target$/);
  await expect
    .poll(() => existsSync(join(workerServer.contentDir, 'missing-target.md')))
    .toBe(true);
});

test('Problems location reveals the editor from the information cover', async ({ page, api }) => {
  const docName = `editor-card-problem-location-${test.info().workerIndex}`;
  await api.seedDocs([
    {
      name: docName,
      markdown: `# Problem location\n\n${'Context paragraph. '.repeat(180)}\n\n[Attachment](missing.pdf)`,
    },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Problems' }).click();
  const location = cover.getByRole('list', { name: 'Problems' }).getByRole('button').first();
  await expect(location).toBeVisible();
  await location.click();
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
  await expect(
    page.locator('.ProseMirror').getByText('Attachment', { exact: true }),
  ).toBeInViewport();
});

test('Comments quote reveals its passage while comment editing stays in the cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-comment-quote-${test.info().workerIndex}`;
  const passage = 'the hidden passage near the end';
  await api.seedDocs([
    {
      name: docName,
      markdown: `# Comment destination\n\n${'Context paragraph. '.repeat(180)}\n\nFind ${passage} here.`,
    },
  ]);
  const created = await page.request.post('/api/comments', {
    data: { docName, quote: passage, body: 'Keep this comment visible while editing.' },
  });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Comments' }).click();
  await expect(cover.getByTestId('thread-comment-body')).toHaveText(
    'Keep this comment visible while editing.',
  );
  await cover.getByTestId('thread-comment-body').hover();
  const editComment = cover.getByRole('button', { name: 'Edit this comment' });
  await editComment.click({ timeout: 5000 });
  const editField = cover.getByRole('textbox', { name: 'Edit this comment' });
  await expect(editField).toBeVisible();
  await expect(editField).toBeFocused();
  await editField.fill('An unsaved change stays with this comment.');
  await expect(editField).toHaveText('An unsaved change stays with this comment.');
  await expect(cover).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${docName}$`));
  await cover.getByRole('button', { name: 'Cancel' }).click();
  await expect(cover.getByTestId('thread-comment-body')).toHaveText(
    'Keep this comment visible while editing.',
  );
  await cover.getByRole('button', { name: 'Edit this comment' }).focus();
  await page.keyboard.press('Enter');
  await expect(cover.getByRole('textbox', { name: 'Edit this comment' })).toBeVisible();
  await expect(cover).toBeVisible();
  await cover.getByRole('textbox', { name: 'Edit this comment' }).fill('Saved from the cover.');
  await cover.getByRole('button', { name: 'Save' }).click();
  await expect(cover.getByTestId('thread-comment-body')).toHaveText('Saved from the cover.');
  await expect(cover).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/${docName}$`));
  await cover.getByRole('button', { name: `“${passage}”` }).click();
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
  await expect(page.locator('.ProseMirror p', { hasText: passage })).toBeInViewport();
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(cover.getByRole('tab', { name: 'Comments' })).toHaveAttribute('data-state', 'on');
  await expect(cover.getByTestId('thread-comment-body')).toHaveText('Saved from the cover.');
});

test.describe('Comments cover on a touch pointer', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 700 } });

  test('comment editing opens by touch and stays in the information cover', async ({
    page,
    api,
  }) => {
    const docName = `editor-card-comment-touch-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: '# Touch comment\n\nA passage to annotate.' }]);
    const created = await page.request.post('/api/comments', {
      data: { docName, quote: 'A passage to annotate.', body: 'Keep this draft in the cover.' },
    });
    expect(created.ok()).toBe(true);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').tap();
    const cover = page.locator('[data-doc-panel-cover]');
    await cover.getByRole('tab', { name: 'Comments' }).tap();
    await expect(cover.getByTestId('thread-comment-body')).toHaveText(
      'Keep this draft in the cover.',
    );
    expect(await page.evaluate(() => window.matchMedia('(hover: none)').matches)).toBe(true);
    const edit = cover.getByRole('button', { name: 'Edit this comment' });
    const reachable = async () =>
      edit.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit !== null && button.contains(hit);
      });
    expect(await reachable()).toBe(true);
    await edit.tap({ timeout: 5000 });
    const field = cover.getByRole('textbox', { name: 'Edit this comment' });
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(cover).toBeVisible();
    await cover.getByRole('button', { name: 'Cancel' }).tap();
    await expect(cover.getByTestId('thread-comment-body')).toHaveText(
      'Keep this draft in the cover.',
    );
    expect(await reachable()).toBe(true);
    await edit.tap();
    await field.fill('Saved by touch.');
    await cover.getByRole('button', { name: 'Save' }).tap();
    await expect(cover.getByTestId('thread-comment-body')).toHaveText('Saved by touch.');
    await expect(cover).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/${docName}$`));
  });
});

test('project Comments quote reveals its other document from the information cover', async ({
  page,
  api,
}) => {
  const source = `editor-card-comment-source-${test.info().workerIndex}`;
  const target = `editor-card-comment-target-${test.info().workerIndex}`;
  const passage = 'other document passage';
  await api.seedDocs([
    { name: source, markdown: '# Source\n\nOpen the project comments.' },
    { name: target, markdown: `# Target\n\nFind the ${passage} here.` },
  ]);
  const created = await page.request.post('/api/comments', {
    data: { docName: target, quote: passage, body: 'Navigate to this other document.' },
  });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Comments' }).click();
  await cover.getByTestId('panel-scope-project').click();
  await cover.getByRole('button', { name: `“${passage}”` }).click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror h1', { hasText: 'Target' })).toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
});

test('failed Comments passage keeps the information cover and error context', async ({
  page,
  context,
  api,
}) => {
  const source = `editor-card-comment-failed-source-${test.info().workerIndex}`;
  const target = `editor-card-comment-failed-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Source\n\nOpen the project comments.' },
    { name: target, markdown: '# Target\n\na passage that is no longer here' },
  ]);
  const created = await page.request.post('/api/comments', {
    data: {
      docName: target,
      quote: 'a passage that is no longer here',
      body: 'Find the old quote.',
    },
  });
  expect(created.ok()).toBe(true);
  let disconnectDestination = false;
  await context.routeWebSocket(/collab/, (socket) => {
    if (disconnectDestination) {
      socket.close();
      return;
    }
    socket.connectToServer();
  });
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Comments' }).click();
  await cover.getByTestId('panel-scope-project').click();
  disconnectDestination = true;
  await cover.getByRole('button', { name: '“a passage that is no longer here”' }).click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await expect(cover).toBeVisible();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: "That document didn't open in time" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(cover.getByText('Find the old quote.')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active !== document.body && active.closest('[inert]') === null;
    }),
  ).toBe(true);
});

test('Problems Fix keeps information work in the cover', async ({ page, api, workerServer }) => {
  const docName = `editor-card-problem-fix-${test.info().workerIndex}`;
  const configPath = join(workerServer.contentDir, '.ok', 'config.yml');
  const originalConfig = existsSync(configPath) ? readFileSync(configPath) : null;
  mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
  writeFileSync(configPath, 'contentRules:\n  markdownlint:\n    enabled: true\n', 'utf-8');
  try {
    await api.seedDocs([
      { name: docName, markdown: '# Problem fix\n\nParagraph with trailing spaces.   \n' },
    ]);
    await page.setViewportSize({ width: 430, height: 700 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    const cover = page.locator('[data-doc-panel-cover]');
    await cover.getByRole('tab', { name: 'Problems' }).click();
    await expect(cover.getByText('MD009')).toBeVisible();
    await cover.getByTestId('problems-fix').first().click();
    await expect(cover.getByText('MD009')).toHaveCount(0);
    await expect(cover).toBeVisible();
    await expect(cover.getByRole('tab', { name: 'Problems' })).toHaveAttribute('data-state', 'on');
    await expect(page).toHaveURL(new RegExp(`#/${docName}$`));
  } finally {
    if (originalConfig) writeFileSync(configPath, originalConfig);
    else unlinkSync(configPath);
  }
});

test('project Problems location reveals another document from the information cover', async ({
  page,
  api,
}) => {
  const source = `editor-card-project-problem-source-${test.info().workerIndex}`;
  const target = `editor-card-project-problem-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Source\n\nOpen project problems.' },
    {
      name: target,
      markdown: `# Target\n\n${'Context paragraph. '.repeat(180)}\n\n[Attachment](missing.pdf)`,
    },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Problems' }).click();
  await cover.getByTestId('panel-scope-project').click();
  const group = cover.getByTestId('problems-audit-group').filter({ hasText: target });
  await expect(group).toBeVisible();
  await group.getByRole('button').first().click();
  await group.getByRole('list').getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await waitForActiveProviderSynced(page);
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror h1', { hasText: 'Target' })).toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator('[data-testid="editor-scroll-container"]')
        .first()
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(50);
});

test('Comments property anchor reveals its value from the information cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-comment-property-${test.info().workerIndex}`;
  const quote = 'Initial';
  await api.seedDocs([
    { name: docName, markdown: '---\ntitle: Initial\n---\n\n# Body\n\nProperty comment.' },
  ]);
  const created = await page.request.post('/api/comments', {
    data: { docName, propertyKey: 'title', quote, body: 'Check the title property.' },
  });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Comments' }).click();
  const property = page.locator('[data-testid="property-row"][data-key="title"] textarea');
  await expect(property).toHaveValue(quote);
  await cover.getByRole('button', { name: `title: “${quote}”` }).click();
  await expect(property).toHaveAttribute('data-comment-reveal', 'true');
  await expect(cover).not.toBeVisible();
  await expect(property).toBeFocused();
  await expect(property).toHaveJSProperty('selectionStart', 0);
  await expect(property).toHaveJSProperty('selectionEnd', quote.length);
});

test('project Comments property anchor reveals its other document', async ({ page, api }) => {
  const source = `editor-card-property-source-${test.info().workerIndex}`;
  const target = `editor-card-property-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Source\n\nOpen project comments.' },
    { name: target, markdown: '---\ntitle: Initial\n---\n\n# Target\n\nProperty comment.' },
  ]);
  const created = await page.request.post('/api/comments', {
    data: { docName: target, propertyKey: 'title', quote: 'Initial', body: 'Open this property.' },
  });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Comments' }).click();
  await cover.getByTestId('panel-scope-project').click();
  await cover.getByRole('button', { name: 'title: “Initial”' }).click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await waitForActiveProviderSynced(page);
  const property = page.locator('[data-testid="property-row"][data-key="title"] textarea');
  await expect(property).toHaveAttribute('data-comment-reveal', 'true');
  await expect(cover).not.toBeVisible();
  await expect(property).toBeFocused();
});

test('agent Activity opens the whole information panel as a cover', async ({ page, api }) => {
  const docName = `editor-card-info-activity-${test.info().workerIndex}`;
  const agentId = `responsive-activity-${crypto.randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, `${DOC_MARKDOWN}\n\nAgent update`, {
    agentId,
    agentName: 'Responsive Activity',
    clientName: 'claude-code',
  });

  const avatar = page
    .locator(
      '[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Responsive Activity"]',
    )
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
  await expect(
    page
      .locator('[data-doc-panel-cover] [data-testid="activity-panel-file-row"]')
      .filter({ hasText: docName }),
  ).toBeVisible();
  await expect(page.locator('[data-doc-panel-back]')).toBeFocused();
  await page.locator('[data-doc-panel-back]').click();
  await expect(page.locator('[data-doc-panel-cover]')).not.toBeVisible();
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    docName,
  );
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Agent update',
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
  await avatar.click();
  await expect(page.locator('[data-testid="activity-panel"]')).toBeHidden();
  await page.setViewportSize({ width: 430, height: 700 });
  await avatar.click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
  await page.locator('[data-doc-panel-back]').click();
  await avatar.click();
  await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
  await expect(page.locator('[data-testid="activity-panel"]')).toBeVisible();
});

test('Timeline version selection reveals its diff from the information cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-timeline-diff-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Timeline before\n\nInitial body.' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# Timeline after\n\nChanged body.', {
    agentId: `timeline-cover-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Timeline Cover',
    clientName: 'claude-code',
  });
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Timeline' }).click();
  const entry = cover.getByTestId('timeline-entry-open').first();
  await expect(entry).toBeVisible();
  const before = page.url();
  await entry.click();
  await expect(page.getByTestId('timeline-diff-pane')).toBeVisible();
  await expect(page.getByTestId('timeline-diff-pane')).toContainText('Changed body.');
  await expect(cover).not.toBeVisible();
  await expect(page.getByTestId('timeline-diff-close')).toBeFocused();
  expect(page.url()).toBe(before);
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(cover).toBeVisible();
  await cover.getByTestId('timeline-entry-open').first().click();
  await expect(cover).not.toBeVisible();
  await expect(page.getByTestId('timeline-diff-pane')).toContainText('Changed body.');
  await page.getByTestId('timeline-diff-close').click();
  await expect(page.getByTestId('timeline-diff-pane')).toHaveCount(0);
  expect(page.url()).toBe(before);
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(cover.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('data-state', 'on');
  await expect(cover.getByTestId('timeline-entry-open').first()).toBeVisible();
});

test('failed Timeline diff loading keeps the information cover and its selected version available', async ({
  page,
  api,
}) => {
  const docName = `editor-card-timeline-diff-failure-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Timeline before\n\nInitial body.' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# Timeline after\n\nChanged body.', {
    agentId: `timeline-diff-failure-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Timeline Diff Failure',
    clientName: 'claude-code',
  });
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Timeline' }).click();
  const entry = cover.getByTestId('timeline-entry-open').first();
  await expect(entry).toBeVisible();
  const before = page.url();
  let failedFetchObserved = false;
  await page.route(/\/api\/history\/[^?]+\?docName=/, (route) => {
    failedFetchObserved = true;
    return route.fulfill({ status: 503 });
  });

  await entry.click();
  await expect.poll(() => failedFetchObserved).toBe(true);
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Diff unavailable' }),
  ).toBeVisible();
  await expect(cover).toBeVisible();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('header-pane-button-editor')).toBeVisible();
  expect(page.url()).toBe(before);
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    docName,
  );
  await page.unroute(/\/api\/history\/[^?]+\?docName=/);
  await cover.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await page.getByTestId('timeline-diff-close').click();
  await page.locator('[data-doc-panel-toggle]').click();
  await expect(cover.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('data-state', 'on');
  await cover.getByTestId('timeline-entry-open').first().click();
  await expect(page.getByTestId('timeline-diff-pane')).toContainText('Changed body.');
  expect(page.url()).toBe(before);
});

test('Timeline Restore confirmation and failure keep the information cover available', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `editor-card-timeline-restore-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Before restore\n\nOriginal body.' }]);
  await saveInMemoryCheckpoint(
    { gitDir: resolveShadowDir(workerServer.contentDir), workTree: workerServer.contentDir },
    '',
    {
      kind: 'bridge-merge-loss',
      docName,
      contents: '# Before restore\n\nOriginal body.',
      branch: 'main',
      label: 'Before later edit',
      metadata: { lostSubstrings: ['Original body.'] },
    },
  );
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# After restore\n\nCurrent body.', {
    agentId: `timeline-restore-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Timeline Restore',
    clientName: 'claude-code',
  });
  await page.locator('[data-doc-panel-toggle]').click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByRole('tab', { name: 'Timeline' }).click();
  const older = cover.getByTestId('timeline-entry-open').last();
  await expect(older).toBeVisible();
  await older.getByTestId('timeline-entry-restore').click();
  await expect(page.getByTestId('timeline-entry-restore-confirm')).toBeVisible();
  await page.getByTestId('timeline-entry-restore-cancel').click();
  await expect(cover).toBeVisible();
  await expect(page.getByText('Current body.')).toBeVisible();
  const docPath = join(workerServer.contentDir, `${docName}.md`);
  await expect.poll(() => readFileSync(docPath, 'utf-8')).toContain('Current body.');
  expect(readFileSync(docPath, 'utf-8')).not.toContain('Original body.');
  await page.route('**/api/rollback', (route) => route.fulfill({ status: 503 }));
  await older.getByTestId('timeline-entry-restore').click();
  await page.getByTestId('timeline-entry-restore-confirm').click();
  await expect(page.getByText('Restore failed', { exact: true })).toBeVisible();
  await expect(cover).toBeVisible();
  await expect(page.getByText('Current body.')).toBeVisible();
  expect(readFileSync(docPath, 'utf-8')).not.toContain('Original body.');
  await page.unroute('**/api/rollback');
  await page.getByTestId('timeline-entry-restore-confirm').click();
  await expect(page.getByText('Original body.')).toBeVisible();
  await expect(cover).toBeVisible();
  await expect.poll(() => readFileSync(docPath, 'utf-8')).toContain('Original body.');
  expect(readFileSync(docPath, 'utf-8')).not.toContain('Current body.');
  await cover.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await expect(cover).not.toBeVisible();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Original body.',
  );
});

test('Activity version selection reveals its diff from the information cover', async ({
  page,
  api,
}) => {
  const docName = `editor-card-activity-diff-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Activity before\n\nInitial body.' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# Activity after\n\nChanged body.', {
    agentId: `activity-cover-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Activity Cover',
    clientName: 'claude-code',
  });
  const avatar = page
    .locator(
      '[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Activity Cover"]',
    )
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  const cover = page.locator('[data-doc-panel-cover]');
  const version = cover.getByTestId('activity-panel-burst-open').first();
  await expect(version).toBeVisible();
  const before = page.url();
  await version.click();
  await expect(page.getByTestId('agent-diff-pane')).toBeVisible();
  await expect(page.getByTestId('agent-diff-pane')).toContainText('Changed body.');
  await expect(cover).not.toBeVisible();
  await expect(page.getByTestId('agent-diff-close')).toBeFocused();
  expect(page.url()).toBe(before);
  await page.getByTestId('agent-diff-close').click();
  await expect(page.getByTestId('agent-diff-pane')).toHaveCount(0);
  expect(page.url()).toBe(before);
  await avatar.click();
  await expect(cover.getByTestId('activity-panel')).toBeVisible();
  await expect(cover.getByTestId('activity-panel-burst-open').first()).toBeVisible();
});

test('failed Activity diff loading keeps the information cover and burst available', async ({
  page,
  api,
}) => {
  const docName = `editor-card-activity-diff-failure-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Activity before\n\nInitial body.' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# Activity after\n\nChanged body.', {
    agentId: `activity-diff-failure-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Activity Diff Failure',
    clientName: 'claude-code',
  });
  const avatar = page
    .locator(
      '[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Activity Diff Failure"]',
    )
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  const cover = page.locator('[data-doc-panel-cover]');
  const burst = cover.getByTestId('activity-panel-burst-open').first();
  await expect(burst).toBeVisible();
  const before = page.url();
  let failedFetchObserved = false;
  await page.route(/\/api\/agent-burst-diff\?/, (route) => {
    failedFetchObserved = true;
    return route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:ok:error:internal-server-error',
        title: 'Activity diff unavailable',
        status: 503,
      }),
    });
  });

  await burst.click();
  await expect.poll(() => failedFetchObserved).toBe(true);
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Diff unavailable' }),
  ).toBeVisible();
  await expect(cover).toBeVisible();
  await expect(burst).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('header-pane-button-editor')).toBeVisible();
  expect(page.url()).toBe(before);
  await page.unroute(/\/api\/agent-burst-diff\?/);
  await cover.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await page.getByTestId('agent-diff-close').click();
  await avatar.click();
  await cover.getByTestId('activity-panel-burst-open').first().click();
  await expect(page.getByTestId('agent-diff-pane')).toContainText('Changed body.');
  expect(page.url()).toBe(before);
});

test('Activity Undo retains the cover during inspection and restores the selected edit', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `editor-card-activity-undo-${test.info().workerIndex}`;
  const agentId = `activity-undo-${crypto.randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: '# Before activity\n\nOriginal body.' }]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(docName, '# First edit\n\nFirst body.', {
    agentId,
    agentName: 'Activity Undo',
    clientName: 'claude-code',
  });
  await wait(600);
  await api.writeAsAgent(docName, '# Second edit\n\nSecond body.', {
    agentId,
    agentName: 'Activity Undo',
    clientName: 'claude-code',
  });
  const avatar = page
    .locator(
      '[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Activity Undo"]',
    )
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  const cover = page.locator('[data-doc-panel-cover]');
  const activity = cover.getByTestId('activity-panel');
  const file = activity.getByTestId('activity-panel-file-row').filter({ hasText: docName });
  const bursts = file.getByTestId('activity-panel-burst-open');
  await expect(bursts).toHaveCount(2);
  await expect(cover).toBeVisible();
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(bursts.first()).toBeVisible();
  await expect(bursts.last()).toBeVisible();

  await file.getByTestId('activity-panel-burst-restore').last().click();
  await expect(page.getByTestId('activity-panel-burst-restore-confirm')).toBeVisible();
  await page.getByTestId('activity-panel-burst-restore-cancel').click();
  await expect(cover).toBeVisible();
  await expect(bursts).toHaveCount(2);

  const undoResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/agent-undo') && response.request().method() === 'POST',
  );
  await file.getByTestId('activity-panel-burst-restore').last().click();
  await page.getByTestId('activity-panel-burst-restore-confirm').click();
  expect((await undoResponse).ok()).toBe(true);
  await expect(cover).toBeVisible();
  await expect(bursts).toHaveCount(1);
  const docPath = join(workerServer.contentDir, `${docName}.md`);
  await expect
    .poll(() => readFileSync(docPath, 'utf-8').trim())
    .toBe('# First edit\n\nFirst body.');
  await cover.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await expect(page.getByText('First body.', { exact: true })).toBeVisible();
});

test('Activity file selection reveals its other document from the information cover', async ({
  page,
  api,
}) => {
  const source = `editor-card-activity-source-${test.info().workerIndex}`;
  const target = `editor-card-activity-target-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Current document' },
    { name: target, markdown: '# Activity destination' },
  ]);
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await api.writeAsAgent(target, '# Activity destination\n\nChanged elsewhere.', {
    agentId: `activity-file-${crypto.randomUUID().slice(0, 8)}`,
    agentName: 'Activity File',
    clientName: 'claude-code',
  });
  const avatar = page
    .locator(
      '[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Activity File"]',
    )
    .first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  const cover = page.locator('[data-doc-panel-cover]');
  await cover.getByTestId('activity-panel-file-row-filename').filter({ hasText: target }).click();
  await expect(page).toHaveURL(new RegExp(`#/${target}$`));
  await waitForActiveProviderSynced(page);
  await expect(cover).not.toBeVisible();
  await expect(
    page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)'),
  ).toBeFocused();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Changed elsewhere.',
  );
  await avatar.click();
  await expect(cover.getByTestId('activity-panel')).toBeVisible();
  await expect(
    cover.getByTestId('activity-panel-file-row-filename').filter({ hasText: target }),
  ).toBeVisible();
});

for (const rememberedWidth of [300, 600]) {
  test(`information cover retains a ${rememberedWidth}px remembered dock width`, async ({
    page,
    api,
  }) => {
    const docName = `editor-card-info-remembered-${rememberedWidth}-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.addInitScript((width) => {
      localStorage.setItem('ok-doc-panel-width-v1', String(width));
      localStorage.setItem(
        'ok-sidebar-pins-v2',
        JSON.stringify({ right: { above: 'open', below: 'open', embedded: 'open' } }),
      );
    }, rememberedWidth);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const panel = page.locator('#doc-panel');
    await expect(panel).toBeVisible();
    expect(Math.abs((await widthOf(panel)) - rememberedWidth)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 500, height: 700 });
    await expect(panel).not.toBeVisible();
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-cover]')).toBeVisible();
    await page.locator('[data-doc-panel-back]').click();
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(panel).toBeVisible();
    expect(Math.abs((await widthOf(panel)) - rememberedWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe(
      String(rememberedWidth),
    );
  });
}

test('information intent survives viewport partition changes without a new toggle', async ({
  page,
  api,
}) => {
  const docName = `editor-card-info-partition-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const panel = page.locator('#doc-panel');
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 500, height: 700 });
  await expect(panel).not.toBeVisible();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(panel).toBeVisible();
});

test('closed wide information reopens as a cover after editor and window resizing without clipping', async ({
  page,
  api,
  baseURL,
}) => {
  const resizeErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('ResizeObserver loop')) resizeErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.text().includes('rail-layout-retry-exhausted')) resizeErrors.push(message.text());
  });
  const docName = `outline-reopen-${test.info().workerIndex}`;
  await api.seedDocs([
    {
      name: docName,
      markdown: `---\ntitle: Albus Dumbledore\n---\n\n# Summary\n\n${('Grindelwald in **1945**, and in doing so became master of the **Elder Wand**. ').repeat(12)}\n\n## Headmaster and public offices\n\nBeyond Hogwarts, Dumbledore held office in wizarding government.`,
    },
  ]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '320');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await expect(editor).toBeVisible();
  const info = page.locator('#doc-panel');
  const toggle = page.locator('[data-doc-panel-toggle]');
  const infoDivider = page.locator('[data-doc-panel-handle]');
  await infoDivider.hover();
  const ib = await infoDivider.boundingBox();
  if (!ib) throw new Error('information divider has no bounds');
  await page.mouse.down();
  await page.mouse.move(ib.x - 600, ib.y + ib.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => info.evaluate((e) => e.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(599);
  await page.getByTestId('header-pane-button-agents').click();
  await expect(page.locator('[data-agents-panel-mount]')).toBeVisible();
  await expect(info).toBeVisible();
  await toggle.click();
  await expect(info).toBeHidden();
  const card = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  const chatDivider = page.locator('[data-agents-panel-resize-handle]');
  for (const target of [900, 650, 450, 270]) {
    await chatDivider.hover();
    const cb = await chatDivider.boundingBox();
    const before = await card.evaluate((e) => e.getBoundingClientRect().width);
    if (!cb) throw new Error('Chat divider has no bounds');
    await page.mouse.down();
    await expect(chatDivider).toHaveAttribute('data-separator', 'active');
    await page.mouse.move(cb.x + cb.width / 2 + (target - before), cb.y + cb.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(chatDivider).not.toHaveAttribute('data-separator', 'active');
    await page.screenshot({ path: test.info().outputPath(`closed-${target}.png`) });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await page.screenshot({ path: test.info().outputPath(`reopened-${target}.png`) });
    const cover = page.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    const coverBox = await cover.boundingBox();
    const cardBox = await card.boundingBox();
    if (!coverBox || !cardBox) throw new Error('the editor cover has no bounds');
    expect(Math.abs(coverBox.width - cardBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(coverBox.x - cardBox.x)).toBeLessThanOrEqual(1);
    await page.locator('[data-doc-panel-back]').click();
    await expect
      .poll(() =>
        page.locator('[data-editor-workspace]').evaluate((e) => e.scrollWidth - e.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
  }
  await dragChatDivider(page, 0, 1400 - (await widthOf(card)), async () => {});
  await expect(info).toBeVisible();
  await expect.poll(() => widthOf(info)).toBeGreaterThanOrEqual(599);
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  await toggle.click();
  await expect(info).toBeHidden();
  for (const width of [1400, 1200, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await settleFrames(page);
    await expect(toggle).toBeVisible();
    await toggle.click();
    const cover = page.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    const bounds = await cover.boundingBox();
    const cardBounds = await card.boundingBox();
    if (!bounds || !cardBounds) throw new Error('the editor cover has no bounds');
    expect(Math.abs(bounds.width - cardBounds.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.x - cardBounds.x)).toBeLessThanOrEqual(1);
    await page.locator('[data-doc-panel-back]').click();
    expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
    await expect
      .poll(() =>
        page.locator('[data-editor-workspace]').evaluate((e) => e.scrollWidth - e.clientWidth),
      )
      .toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 2000, height: 900 });
  await expect(info).toBeVisible();
  await settleFrames(page);
  await expect.poll(() => widthOf(info)).toBeGreaterThanOrEqual(599);
  await toggle.click();
  await expect(info).toBeHidden();
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.setViewportSize({ width: 2000, height: 900 });
  await expect(info).toBeHidden();
  expect(resizeErrors).toEqual([]);
});

test('information yields after resizing the editor beside Chat below its docking budget', async ({
  page,
  api,
  baseURL,
}) => {
  const resizeErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('ResizeObserver loop')) resizeErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.text().includes('rail-layout-retry-exhausted')) resizeErrors.push(message.text());
  });
  const docName = `outline-drag-budget-${test.info().workerIndex}`;
  await api.seedDocs([
    {
      name: docName,
      markdown:
        '# Summary\n\nGrindelwald in 1945 became master of the Elder Wand.\n\n## Public offices\n\nBeyond Hogwarts, Dumbledore held public office.',
    },
  ]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '320');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible();
  const informationDivider = page.locator('[data-doc-panel-handle]');
  await informationDivider.hover();
  const ib = await informationDivider.boundingBox();
  if (!ib) throw new Error('information divider has no bounds');
  await page.mouse.down();
  await page.mouse.move(ib.x - 600, ib.y + ib.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.locator('#doc-panel').evaluate((e) => e.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(599);
  await page.getByTestId('header-pane-button-agents').click();
  const info = page.locator('#doc-panel');
  await expect(info).toBeVisible();
  const card = page.locator('[data-slot="pane-card"][data-pane="editor"]');
  const handle = page.locator('[data-agents-panel-resize-handle]');
  await handle.hover();
  const box = await handle.boundingBox();
  const before = await card.evaluate((e) => e.getBoundingClientRect().width);
  if (!box) throw new Error('Chat divider has no bounds');
  await page.mouse.down();
  await expect(handle).toHaveAttribute('data-separator', 'active');
  try {
    for (const target of [1300, 1150, 1000, 850, 750]) {
      await page.mouse.move(box.x + box.width / 2 + target - before, box.y + box.height / 2, {
        steps: 8,
      });
      await settleFrames(page);
      await expect
        .poll(() =>
          page
            .locator('[data-editor-workspace-column]')
            .evaluate((e) => e.getBoundingClientRect().width),
        )
        .toBeGreaterThanOrEqual(300);
      await expect
        .poll(() =>
          page.locator('[data-editor-workspace]').evaluate((e) => e.scrollWidth - e.clientWidth),
        )
        .toBeLessThanOrEqual(1);
      if (target < 1189) await expect(info).toBeHidden();
    }
    await page.screenshot({ path: test.info().outputPath('open-information-during-drag.png') });
  } finally {
    await page.mouse.up();
  }
  await expect(handle).not.toHaveAttribute('data-separator', 'active');
  await settleFrames(page);
  await page.screenshot({ path: test.info().outputPath('open-information-after-drag.png') });
  await expect(info).toBeHidden();
  await expect
    .poll(() => card.evaluate((e) => e.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(749);
  await expect
    .poll(() => card.evaluate((e) => e.getBoundingClientRect().width))
    .toBeLessThanOrEqual(751);
  await expect
    .poll(() =>
      page
        .locator('[data-editor-workspace-column]')
        .evaluate((e) => e.getBoundingClientRect().width),
    )
    .toBeGreaterThanOrEqual(300);
  await expect
    .poll(() =>
      page.locator('[data-editor-workspace]').evaluate((e) => e.scrollWidth - e.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  const toggle = page.locator('[data-doc-panel-toggle]');
  await expect(toggle).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
  expect(
    await toggle.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  expect(resizeErrors).toEqual([]);
});
