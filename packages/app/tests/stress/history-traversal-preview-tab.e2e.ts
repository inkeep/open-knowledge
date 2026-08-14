/**
 * History traversal must not upgrade a previewed tab into a permanent one.
 *
 * A preview tab (single sidebar click, italic label) is provisional: the next
 * click reuses its slot. Pressing Back replays a hash the sidebar already
 * recorded, so the doc it lands on was provisional when its history entry was
 * created. Replaying it must not durably grow the strip.
 *
 * Why this belongs in a real browser rather than beside the jsdom sibling:
 *
 *   - The signal that distinguishes a replay from a fresh hash assignment can
 *     come from `popstate`/`event.state` or from the Navigation API's
 *     `navigationType`. jsdom implements the first and not the second, so a
 *     jsdom-only pin would silently decide which mechanism is allowed. Real
 *     Chromium exposes both, so the contract pinned here is about the outcome
 *     the user sees — the tab strip — not about how the handler classifies.
 *   - It is the composition of the hash handler, the document context, and the
 *     tab reducer against a real session-persistence write that grows; each
 *     part is individually correct.
 *
 * The two neighbouring suites are each blind to this on their own:
 * navigation-history.e2e.ts traverses every target kind but never reads the tab
 * strip, and preview-tab-promotion.e2e.ts reads the strip thoroughly but never
 * traverses history.
 */

import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

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

async function expectHash(page: Page, expected: string) {
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toBe(expected);
}

/**
 * Preview state is carried by the `italic` class on the tab's title button —
 * the same signal the user reads.
 */
async function expectPreviewTab(tab: Locator, isPreview: boolean) {
  if (isPreview) {
    await expect(tab).toHaveClass(/italic/);
  } else {
    await expect(tab).not.toHaveClass(/italic/);
  }
}

/** Three fresh docs, unique per test so parallel workers never share a docName. */
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

    // Forward: three single clicks. Each reuses the preview slot, so the strip
    // stays at one tab. The sidebar records each hash with pushState, which is
    // silent — the hash handler only hears about these again on traversal.
    await sidebarTreeItem(page, `${a}.md`).click();
    await expectOpenTabs(page, [a]);
    await sidebarTreeItem(page, `${b}.md`).click();
    await expectOpenTabs(page, [b]);
    await sidebarTreeItem(page, `${c}.md`).click();
    await expectOpenTabs(page, [c]);
    await expectPreviewTab(editorTab(page, `${c}.md`), true);

    // The in-app Back button is Electron-only; it emits `navigate-back` ->
    // `window.history.back()`, which is exactly what `goBack()` performs.
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

    // Forward is the same replay in the other direction and carries the same
    // contract; it is only harder to notice because a Back sequence usually
    // leaves the forward targets already open.
    await page.goForward();
    await expectHash(page, `#/${b}`);
    await expectOpenTabs(page, [b]);
    await expectPreviewTab(editorTab(page, `${b}.md`), true);
  });
});
