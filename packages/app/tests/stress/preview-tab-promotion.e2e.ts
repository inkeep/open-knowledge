import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

function sidebarTreeItem(page: Page, accessibleLabel: string): Locator {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: accessibleLabel, exact: true });
}

function editorTab(page: Page, label: string): Locator {
  return page
    .locator('[data-editor-pane-focused] [data-editor-pane-tabs] [data-editor-tab-sortable]')
    .locator(`button[aria-label="${label}"]`);
}

async function openTabIds(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem(`ok-editor-tabs-v1:${window.location.origin}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { panes?: Array<{ openTabs?: unknown }> };
    const openTabs = parsed.panes?.[0]?.openTabs;
    return Array.isArray(openTabs) ? (openTabs as string[]) : null;
  });
}

async function expectOpenTabs(page: Page, expected: string[]) {
  await expect.poll(() => openTabIds(page)).toEqual(expected);
}

async function expectPreviewTab(tab: Locator, isPreview: boolean) {
  if (isPreview) {
    await expect(tab).toHaveClass(/italic/);
  } else {
    await expect(tab).not.toHaveClass(/italic/);
  }
}

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

interface Fixture {
  first: string;
  second: string;
}

async function seedTwoDocs(api: ApiHelpers, page: Page): Promise<Fixture> {
  const id = randomUUID().slice(0, 8);
  const first = `promo-a-${id}`;
  const second = `promo-b-${id}`;
  for (const name of [first, second]) {
    await api.createPage(`${name}.md`);
    await api.replaceDoc(name, `# ${name}\n\nSeed body.\n`);
  }
  await page.goto('/');
  await expect(sidebarTreeItem(page, `${first}.md`)).toBeVisible();
  return { first, second };
}

test.describe('preview-tab promotion', () => {
  test('an untouched preview tab is replaced by the next sidebar click', async ({ page, api }) => {
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    await expectOpenTabs(page, [first]);
    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [second]);
  });

  test('editing keeps the file open when the next one is clicked', async ({ page, api }) => {
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    const body = page.locator('.ProseMirror:not(.composer-prosemirror)');
    await expect(body).toContainText('Seed body.');
    await body.click();
    await page.keyboard.type('EDITED');
    await expect(body).toContainText('EDITED');

    await expectPreviewTab(editorTab(page, `${first}.md`), false);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [first, second]);
  });

  test('a real double-click on the sidebar row promotes, click-pair and all', async ({
    page,
    api,
  }) => {
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).dblclick();
    await expectOpenTabs(page, [first]);
    await expectPreviewTab(editorTab(page, `${first}.md`), false);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [first, second]);
  });

  test('switching between source and visual mode promotes', async ({ page, api }) => {
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    await waitForProvider(page);
    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await sourceToggle(page).click();
    await expectPreviewTab(editorTab(page, `${first}.md`), false);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [first, second]);
  });

  test('an agent write does NOT promote a tab you are only reading', async ({ page, api }) => {
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    await waitForProvider(page);
    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await api.replaceDoc(first, `# ${first}\n\nRewritten by an agent.\n`);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'Rewritten by an agent.',
    );

    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [second]);
  });

  test('an unregistered component does NOT promote a tab you are only reading', async ({
    page,
    api,
  }) => {
    const { first, second } = await seedTwoDocs(api, page);
    await api.replaceDoc(first, '<Steps>\n\n<Step>\n\nContent one.\n\n</Step>\n\n</Steps>\n');

    await sidebarTreeItem(page, `${first}.md`).click();
    await waitForProvider(page);
    await expect(page.locator('.raw-mdx-fallback-wrapper').first()).toBeAttached({
      timeout: 10_000,
    });

    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [second]);
  });
});
