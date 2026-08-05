/**
 * Preview-tab promotion, in a real browser.
 *
 * A preview tab (single sidebar click, italic label) is provisional — the next
 * click reuses its slot. Committing to the document makes it permanent. These
 * flows need a real browser for reasons the jsdom tests cannot reach:
 *
 *   - A real double-click is `click → click → dblclick`, and click 2 lands on
 *     an already-selected row, which re-runs the sidebar's open path. If that
 *     re-open settled AFTER the promotion, the tab would silently go
 *     provisional again. The dom test fires a synthetic `doubleClick` with no
 *     preceding clicks, so only this layer proves the ordering.
 *   - Promotion-on-edit runs off real ProseMirror/CodeMirror transactions
 *     carrying real y-prosemirror sync metadata, which is what the origin
 *     guards actually read.
 *   - An agent write arrives over the wire as a remote CRDT update, the exact
 *     shape that must NOT promote.
 */

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

/** The tab strip's primary button for a tab, by its filename aria-label. */
function editorTab(page: Page, label: string): Locator {
  return page
    .locator('[data-editor-pane-focused] [data-editor-pane-tabs] [data-editor-tab-sortable]')
    .locator(`button[aria-label="${label}"]`);
}

/** Open tab ids from the persisted session — the durable record of what survived. */
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

/**
 * Preview state is carried by the `italic` class on the tab's title button —
 * the same signal the user reads. No data attribute mirrors it, so this
 * doubles as the assertion that the visual cue clears.
 */
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

/**
 * Two fresh docs, sidebar visible, nothing open. Unique per test so parallel
 * workers never share a docName (shared names corrupt CRDT state across
 * workers).
 */
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
    // The control. Preview replacement is correct behavior, and the promotion
    // work must not turn every click permanent.
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    await expectOpenTabs(page, [first]);
    await expectPreviewTab(editorTab(page, `${first}.md`), true);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [second]);
  });

  test('editing keeps the file open when the next one is clicked', async ({ page, api }) => {
    // The reported bug: the edited file vanished from the tab strip as soon as
    // the next one was opened.
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).click();
    // Wait on the seeded text rather than provider sync: the typing needs the
    // document's content actually rendered into ProseMirror, and a keystroke
    // that lands before then is applied to an empty doc and then overwritten.
    const body = page.locator('.ProseMirror:not(.composer-prosemirror)');
    await expect(body).toContainText('Seed body.');
    await body.click();
    await page.keyboard.type('EDITED');
    await expect(body).toContainText('EDITED');

    // The italic cue clears the moment the edit lands, before any navigation.
    await expectPreviewTab(editorTab(page, `${first}.md`), false);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [first, second]);
  });

  test('a real double-click on the sidebar row promotes, click-pair and all', async ({
    page,
    api,
  }) => {
    // The ordering risk: click 2 of the pair re-runs the sidebar open path for
    // an already-selected row. Promotion must survive that re-open.
    const { first, second } = await seedTwoDocs(api, page);

    await sidebarTreeItem(page, `${first}.md`).dblclick();
    await expectOpenTabs(page, [first]);
    await expectPreviewTab(editorTab(page, `${first}.md`), false);

    await sidebarTreeItem(page, `${second}.md`).click();
    await expectOpenTabs(page, [first, second]);
  });

  test('switching between source and visual mode promotes', async ({ page, api }) => {
    // A mode flip changes no bytes, so no editor origin guard can see it.
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
    // Arrives as a remote CRDT update — the shape the origin guards exist to
    // reject. A tab must not become permanent because something else wrote.
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
});
