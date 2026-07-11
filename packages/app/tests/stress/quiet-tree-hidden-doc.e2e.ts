// Quiet-tree contract for docs the sidebar tree does not display. Opening a
// tree-hidden doc (dot-path, with hidden files off — the default) must open
// the editor normally while the tree stays quiet: the previously active row
// deselects, the tree does not scroll to the stale row, and visible ancestors
// of a partially-hidden path stay expanded. The editor's not-in-sidebar
// indicator completes the contract: it names the hiding toggle beside the
// breadcrumb and flips it in place.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

function uniqueStamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const fileRow = (page: Page, fileName: string) =>
  sidebar(page).getByRole('treeitem', { name: fileName, exact: true });
const folderRow = (page: Page, folderName: string) =>
  sidebar(page).getByRole('treeitem', { name: folderName, exact: true });
const selectedRow = (page: Page) => sidebar(page).locator('[aria-selected="true"]');
// Pierre's internal scroll element inside the file-tree-container shadow root
// (Playwright CSS pierces open shadow roots).
const treeScroller = (page: Page) => sidebar(page).locator('[data-file-tree-virtualized-scroll]');

const editorHeading = (page: Page, text: string) =>
  page.locator('.ProseMirror:not(.composer-prosemirror) h1', { hasText: text });

/** Yield a few animation frames so any pending commit/effect would have landed. */
async function settleFrames(page: Page, frames = 5): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const tick = () => {
          if (--remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/**
 * Wait until the server's page list includes every given docName. Dot-path
 * docs cannot be seeded through the agent-write API (dot segments are
 * rejected), so they are written straight to the worker's content dir — the
 * app must not navigate until the server actually lists them.
 */
async function waitForPagesToInclude(baseURL: string, docNames: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/pages`).catch(() => null);
        if (!response?.ok) return ['__pages-fetch-failed__'];
        const data = (await response.json()) as { pages?: Array<{ docName: string }> };
        const known = new Set((data.pages ?? []).map((entry) => entry.docName));
        return docNames.filter((name) => !known.has(name));
      },
      { timeout: 15_000 },
    )
    .toEqual([]);
}

async function createFolder(baseURL: string, path: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`create-folder failed for ${path}: ${response.status}`);
  }
}

test('opening a tree-hidden doc keeps the tree quiet: previous row deselects, no auto-scroll', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const hiddenDir = `.quiet-scratch-${stamp}`;
  const hiddenDocName = `${hiddenDir}/hidden-note`;
  const targetDoc = `zz-quiet-target-${stamp}`;

  // Enough rows above the zz-sorted target that revealing it must scroll the
  // virtualized tree — the no-scroll assertion below is vacuous otherwise.
  const fillerNames = Array.from(
    { length: 40 },
    (_, i) => `quiet-filler-${stamp}-${String(i).padStart(2, '0')}`,
  );
  for (const name of fillerNames) {
    await api.createPage(`${name}.md`);
  }
  await api.createPage(`${targetDoc}.md`);

  mkdirSync(join(workerServer.contentDir, hiddenDir), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, hiddenDir, 'hidden-note.md'),
    '# Quiet hidden note\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenDocName, targetDoc]);

  await page.goto(`/#/${targetDoc}`);
  await fileRow(page, `${targetDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', `${targetDoc}.md`);

  // Revealing the bottom-sorted target scrolled the tree; park it back at the
  // top so a stale reveal-scroll after the hidden-doc hop is observable.
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);

  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, hiddenDocName);

  // The editor opens the hidden doc fully...
  await expect(editorHeading(page, 'Quiet hidden note')).toBeVisible({ timeout: 15_000 });

  // ...while the tree stays quiet: nothing selected, no scroll to the stale row.
  await settleFrames(page);
  await expect(selectedRow(page)).toHaveCount(0);
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);

  // The previous row is genuinely deselected — not merely virtualized out of
  // the viewport: bring it back into view and re-check.
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await fileRow(page, `${targetDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(0);
});

test('visible ancestors of a partially-hidden path stay expanded while the tree stays quiet', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const startDoc = `quiet-start-${stamp}`;
  const parentFolder = `quiet-parent-${stamp}`;
  const hiddenChildDocName = `${parentFolder}/.hidden-child`;

  await createFolder(workerServer.baseURL, parentFolder);
  await api.createPage(`${startDoc}.md`);
  await api.createPage(`${parentFolder}/sibling-note.md`);
  writeFileSync(
    join(workerServer.contentDir, parentFolder, '.hidden-child.md'),
    '# Quiet hidden child\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenChildDocName, startDoc]);

  await page.goto(`/#/${startDoc}`);
  await fileRow(page, `${startDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', `${startDoc}.md`);

  // Folders sort first — park the tree at the top so the parent folder row is
  // rendered (it may be virtualized out when this worker's tree is long).
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  await folderRow(page, parentFolder).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, hiddenChildDocName);

  await expect(editorHeading(page, 'Quiet hidden child')).toBeVisible({ timeout: 15_000 });

  // The hidden child has no row, so nothing is selected — but its visible
  // ancestor folder is expanded and pinned (ancestor priority unchanged).
  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'true');
  await settleFrames(page);
  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'true');
  await expect(selectedRow(page)).toHaveCount(0);
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);
});

test('the not-in-sidebar indicator names the hiding toggle and its flip reveals the row', async ({
  page,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const hiddenDir = `.indicator-scratch-${stamp}`;
  const hiddenDocName = `${hiddenDir}/indicator-note`;

  mkdirSync(join(workerServer.contentDir, hiddenDir), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, hiddenDir, 'indicator-note.md'),
    '# Indicator note\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenDocName]);

  await page.goto(`/#/${hiddenDocName}`);
  await expect(editorHeading(page, 'Indicator note')).toBeVisible({ timeout: 15_000 });

  // The doc is hidden solely by the hidden-files axis: the indicator names
  // exactly that toggle (no only-markdown chip) while the tree stays quiet.
  const indicator = page.getByTestId('not-in-sidebar-indicator');
  await expect(indicator).toBeVisible();
  await expect(page.getByTestId('not-in-sidebar-flip-hidden-files')).toBeVisible();
  await expect(page.getByTestId('not-in-sidebar-flip-only-markdown')).toHaveCount(0);
  await expect(selectedRow(page)).toHaveCount(0);

  // Flip from the indicator: the tree refetches, the row appears, the
  // selection mirror re-selects it, and the indicator retires.
  await page.getByTestId('not-in-sidebar-flip-hidden-files').click();
  await fileRow(page, 'indicator-note.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(indicator).toHaveCount(0);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'indicator-note.md');

  // Flip back from the tree-options popover (this worker's server is shared
  // by the file's other tests — restore the default) and the indicator
  // recomputes back into view for the still-open doc.
  await page.getByRole('button', { name: 'Tree view options' }).click();
  await page.getByTestId('tree-options-show-hidden-files').click();
  await expect(fileRow(page, 'indicator-note.md')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('not-in-sidebar-indicator')).toBeVisible();
  await expect(selectedRow(page)).toHaveCount(0);
});
