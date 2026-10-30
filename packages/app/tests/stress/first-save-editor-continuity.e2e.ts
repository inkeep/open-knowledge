import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, test, type WorkerServer } from './_helpers';

const EDITOR_SELECTOR = '.ProseMirror:not(.composer-prosemirror)';
const PLACEHOLDER = 'Start writing to create this page';
const PREFIX = 'Created from a missing page';
const SUFFIX = ' while continuing to type';
const PAGES_ROUTE = '**/api/pages*';

const softExpect = expect.configure({ soft: true });

function visibleEditor(page: Page): Locator {
  return page.locator(EDITOR_SELECTOR).filter({ visible: true }).first();
}

function fileRow(page: Page, fileName: string): Locator {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: fileName, exact: true });
}

async function openMissingPage(page: Page, api: ApiHelpers) {
  const stamp = randomUUID().slice(0, 8);
  const anchor = `first-save-anchor-${stamp}`;
  const missing = `first-save-missing-${stamp}`;
  await api.createPage(`${anchor}.md`);
  await page.goto(`/#/${anchor}`);
  await fileRow(page, `${anchor}.md`).waitFor({ state: 'visible' });
  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, missing);
  const editor = visibleEditor(page);
  await expect
    .poll(() => editor.evaluate((element) => getComputedStyle(element, '::before').content))
    .toBe(`"${PLACEHOLDER}"`);
  await expect(editor).toBeVisible();
  return { editor, missing };
}

async function activeElementIsEditor(page: Page): Promise<boolean> {
  return page.evaluate((selector) => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches(selector);
  }, EDITOR_SELECTOR);
}

function storedContent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function exerciseOrder(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  order: 'publication-before-suffix' | 'suffix-before-publication',
): Promise<void> {
  const { editor, missing } = await openMissingPage(page, api);
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  let armed = false;
  let heldResponses = 0;
  await page.route(PAGES_ROUTE, async (route) => {
    if (!armed) return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { pages?: Array<{ docName?: string }> };
    if (body.pages?.some((entry) => entry.docName === missing)) {
      heldResponses += 1;
      await released;
    }
    await route.fulfill({ response });
  });

  const path = join(workerServer.contentDir, `${missing}.md`);
  try {
    await editor.click();
    await expect(editor).toBeFocused();
    armed = true;
    await page.keyboard.type(PREFIX);
    await expect(editor).toContainText(PREFIX);
    await expect
      .poll(() => heldResponses, {
        message: 'the successful page-list response containing the newly created page must be held',
      })
      .toBeGreaterThan(0);

    if (order === 'suffix-before-publication') {
      await page.keyboard.type(SUFFIX);
      await expect(editor).toContainText(PREFIX + SUFFIX);
      release();
    } else {
      release();
      await expect(fileRow(page, `${missing}.md`)).toBeVisible();
      await softExpect(editor).toBeFocused();
      await softExpect
        .poll(() => activeElementIsEditor(page), {
          message: 'the active element must remain the visible editor after page-list publication',
        })
        .toBe(true);
      await page.keyboard.type(SUFFIX);
    }

    await softExpect
      .poll(() => editor.textContent(), {
        message: 'the visible editor must retain the complete trusted keyboard input',
      })
      .toContain(PREFIX + SUFFIX);
    await softExpect
      .poll(() => storedContent(path), {
        message: 'the stored document must contain the complete trusted keyboard input',
      })
      .toContain(PREFIX + SUFFIX);
  } finally {
    release();
    await page.unroute(PAGES_ROUTE);
  }
}

test('preserves focused editor and stored suffix when publication precedes continuing input', async ({
  page,
  api,
  workerServer,
}) => {
  await exerciseOrder(page, api, workerServer, 'publication-before-suffix');
});

test('preserves focused editor and stored suffix when continuing input precedes publication', async ({
  page,
  api,
  workerServer,
}) => {
  await exerciseOrder(page, api, workerServer, 'suffix-before-publication');
});
