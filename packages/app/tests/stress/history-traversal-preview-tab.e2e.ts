import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

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

async function expectHash(page: Page, expected: string) {
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toBe(expected);
}

async function expectPreviewTab(tab: Locator, isPreview: boolean) {
  if (isPreview) {
    await expect(tab).toHaveClass(/italic/);
  } else {
    await expect(tab).not.toHaveClass(/italic/);
  }
}

async function seedThreeDocs(api: ApiHelpers, page: Page): Promise<[string, string, string]> {
  const id = randomUUID().slice(0, 8);
  const names: [string, string, string] = [`hist-a-${id}`, `hist-b-${id}`, `hist-c-${id}`];
  for (const name of names) {
    await api.createPage(`${name}.md`);
    await api.replaceDoc(name, `# ${name}\n\nSeed body.\n`);
  }
  await page.goto('/');
  await expect(sidebarTreeItem(page, `${names[0]}.md`)).toBeVisible();
  return names;
}

test.describe('history traversal and the preview tab slot', () => {
  test('back to a previewed doc reuses the preview slot instead of appending a tab', async ({
    page,
    api,
  }) => {
    const [a, b, c] = await seedThreeDocs(api, page);

    await sidebarTreeItem(page, `${a}.md`).click();
    await expectOpenTabs(page, [a]);
    await sidebarTreeItem(page, `${b}.md`).click();
    await expectOpenTabs(page, [b]);
    await sidebarTreeItem(page, `${c}.md`).click();
    await expectOpenTabs(page, [c]);
    await expectPreviewTab(editorTab(page, `${c}.md`), true);

    await page.goBack();
    await expectHash(page, `#/${b}`);
    await expectOpenTabs(page, [b]);
    await expectPreviewTab(editorTab(page, `${b}.md`), true);
    await expect(editorTab(page, `${c}.md`)).toHaveCount(0);

    await page.goBack();
    await expectHash(page, `#/${a}`);
    await expectOpenTabs(page, [a]);
    await expectPreviewTab(editorTab(page, `${a}.md`), true);
    await expect(editorTab(page, `${b}.md`)).toHaveCount(0);

    await page.goForward();
    await expectHash(page, `#/${b}`);
    await expectOpenTabs(page, [b]);
    await expectPreviewTab(editorTab(page, `${b}.md`), true);
  });
});
