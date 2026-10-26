import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, REQUIRED_FIXTURE_ENTRY_NAMES, test } from './_helpers';

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

type ReentryWindow = Window & {
  __repeatHashOnce?: boolean;
  __wrappedHashListeners?: number;
  __repeatedHashListeners?: number;
};

async function installHashChangeReentry(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const add = window.addEventListener;
    const remove = window.removeEventListener;
    const wrappers = new WeakMap();
    const appWindow = window as ReentryWindow;
    let repeatedEvent: Event | null = null;
    appWindow.__wrappedHashListeners = 0;
    appWindow.__repeatedHashListeners = 0;
    window.addEventListener = function (type, listener, options) {
      if (type !== 'hashchange' || typeof listener !== 'function') {
        return add.call(this, type, listener, options);
      }
      const wrapped = function (event) {
        if (appWindow.__repeatHashOnce) {
          appWindow.__repeatHashOnce = false;
          repeatedEvent = event;
        }
        listener.call(this, event);
        if (event === repeatedEvent) {
          appWindow.__repeatedHashListeners = (appWindow.__repeatedHashListeners ?? 0) + 1;
          listener.call(this, event);
        }
      };
      wrappers.set(listener, wrapped);
      appWindow.__wrappedHashListeners = (appWindow.__wrappedHashListeners ?? 0) + 1;
      return add.call(this, type, wrapped, options);
    };
    window.removeEventListener = function (type, listener, options) {
      return remove.call(this, type, wrappers.get(listener) ?? listener, options);
    };
  });
}

async function armHashChangeReentry(page: Page): Promise<void> {
  const wrapped = await page.evaluate(() => (window as ReentryWindow).__wrappedHashListeners ?? 0);
  expect(wrapped, 'no hashchange listener was wrapped for re-entry').toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as ReentryWindow).__repeatHashOnce = true;
  });
}

async function seedThreeDocs(api: ApiHelpers, page: Page): Promise<[string, string, string]> {
  const id = randomUUID().slice(0, 8);
  const names: [string, string, string] = [`hist-a-${id}`, `hist-b-${id}`, `hist-c-${id}`];
  await api.seedDocs(names.map((name) => ({ name, markdown: `# ${name}\n\nSeed body.\n` })));
  await page.goto('/');
  for (const label of [...REQUIRED_FIXTURE_ENTRY_NAMES, ...names.map((name) => `${name}.md`)]) {
    await expect(sidebarTreeItem(page, label)).toBeVisible();
  }
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

  test('back to a previewed doc remains preview when the hash handler is re-entered', async ({
    page,
    api,
  }) => {
    await installHashChangeReentry(page);
    const [a, b, c] = await seedThreeDocs(api, page);

    await sidebarTreeItem(page, `${a}.md`).click();
    await expectOpenTabs(page, [a]);
    await sidebarTreeItem(page, `${b}.md`).click();
    await expectOpenTabs(page, [b]);
    await sidebarTreeItem(page, `${c}.md`).click();
    await expectOpenTabs(page, [c]);
    await expectPreviewTab(editorTab(page, `${c}.md`), true);

    await armHashChangeReentry(page);
    await page.goBack();
    await expect
      .poll(() => page.evaluate(() => (window as ReentryWindow).__repeatedHashListeners ?? 0), {
        message: 'the armed hashchange was not delivered twice to its listeners',
      })
      .toBeGreaterThan(0);
    await expectHash(page, `#/${b}`);
    await expectOpenTabs(page, [b]);
    await expectPreviewTab(editorTab(page, `${b}.md`), true);
    await expect(editorTab(page, `${c}.md`)).toHaveCount(0);
  });
});
