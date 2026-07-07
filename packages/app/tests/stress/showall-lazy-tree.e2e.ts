/**
 * Show All Files — lazy tree expansion + truncation banner (user journey).
 *
 * The DOM suites (`FileTree.showall-lazy.dom.test.tsx`,
 * `FileTree.showall-truncation.dom.test.tsx`) pin the component contract
 * against a stubbed fetch and a stub Pierre model; this file covers the
 * composition boundary those stubs cannot reach: the real
 * `/api/documents?showAll=true&dir=…&depth=1` disk walk served by the dev
 * server, the row-context-menu config flow that flips the mode, the NDJSON
 * stream consumed by a real browser, and the Pierre tree the user actually
 * clicks.
 *
 * The whole file opts into a dedicated worker server with a small Show All
 * entry cap (`test.use({ workerServerEnv })` below) so truncation is
 * reachable with a small fixture tree. Both tests keep their root level far
 * below the cap — only the overflow folder's child level exceeds it, which
 * is exactly the shape the lazy tree must surface without ever starving the
 * top level.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/** Show All entry cap for this file's dedicated worker server. */
const SHOW_ALL_CAP = 25;
/** Child count for the folder that must overflow the cap. */
const OVERFLOW_CHILD_COUNT = SHOW_ALL_CAP + 5;

test.use({ workerServerEnv: { OK_SHOWALL_MAX_ENTRIES: String(SHOW_ALL_CAP) } });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

function fileRow(page: Page, filename: string) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: filename, exact: true });
}

function folderRow(page: Page, folderName: string) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: new RegExp(`^${escapeRegExp(folderName)}/?$`) });
}

/**
 * Expand a collapsed folder through the keyboard disclosure affordance.
 * Row CLICK navigates to the folder overview route (see the contract test in
 * `ux-interactions.e2e.ts`); ArrowRight is the expand interaction, and the
 * `aria-expanded` flip is the "expansion landed" signal the lazy child fetch
 * keys off.
 */
async function expandFolder(page: Page, folderName: string): Promise<void> {
  const row = folderRow(page, folderName);
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.focus();
  await row.press('ArrowRight');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Collapse an expanded folder (inverse of {@link expandFolder}). */
async function collapseFolder(page: Page, folderName: string): Promise<void> {
  const row = folderRow(page, folderName);
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await row.focus();
  await row.press('ArrowLeft');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
}

test('Show All seeds the root lazily and loads folder children on expand', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const rootDoc = `showall-root-${stamp}`;
  const folder = `showall-dir-${stamp}`;
  const nested = `nested-${stamp}`;
  const diskOnlyDir = `showall-disk-${stamp}`;

  // Indexed entries — visible in the default filtered mode too.
  await api.seedDocs([
    { name: rootDoc, markdown: '# root\n' },
    { name: `${folder}/child-a`, markdown: '# a\n' },
    { name: `${folder}/child-b`, markdown: '# b\n' },
  ]);
  // Disk-only entries: a second-level subtree plus a root-level folder the
  // filtered index never lists. The disk walk reads the disk directly, so
  // these need no watcher round-trip — and the disk-only dir doubles as proof
  // the disk walk ran.
  mkdirSync(join(workerServer.contentDir, folder, nested), { recursive: true });
  writeFileSync(join(workerServer.contentDir, folder, nested, 'deep-doc.md'), '# deep\n', 'utf-8');
  mkdirSync(join(workerServer.contentDir, diskOnlyDir), { recursive: true });
  writeFileSync(join(workerServer.contentDir, diskOnlyDir, 'ghost.md'), '# ghost\n', 'utf-8');

  const showAllListingUrls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/documents') && url.includes('showAll=true')) {
      showAllListingUrls.push(url);
    }
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // The disk-walk listing is the default. Lazy root seed: disk-only entries
  // the filtered index never lists appear at the root level...
  await expect(folderRow(page, diskOnlyDir)).toBeVisible({ timeout: 15_000 });
  await expect(fileRow(page, `${rootDoc}.md`)).toBeVisible();
  // ...but the still-collapsed folder's child level has not been fetched.
  await expect(fileRow(page, 'child-a.md')).toBeHidden();
  expect(showAllListingUrls.some((url) => url.includes(`dir=${encodeURIComponent(folder)}`))).toBe(
    false,
  );

  // Expanding the folder fetches exactly its one level on demand.
  const childLevelFetch = page.waitForRequest(
    (request) => {
      const url = request.url();
      return (
        url.includes('/api/documents') &&
        url.includes('showAll=true') &&
        url.includes(`dir=${encodeURIComponent(folder)}`) &&
        url.includes('depth=1')
      );
    },
    { timeout: 15_000 },
  );
  await expandFolder(page, folder);
  await childLevelFetch;
  await expect(fileRow(page, 'child-a.md')).toBeVisible({ timeout: 15_000 });
  await expect(fileRow(page, 'child-b.md')).toBeVisible();

  // The second level stays unloaded until ITS folder expands.
  await expect(folderRow(page, nested)).toBeVisible();
  await expect(fileRow(page, 'deep-doc.md')).toBeHidden();
  await expandFolder(page, nested);
  await expect(fileRow(page, 'deep-doc.md')).toBeVisible({ timeout: 15_000 });

  // The lazy contract held for the whole journey: every Show All listing
  // request was a single-level fetch — the full recursive walk never ran.
  expect(showAllListingUrls.length).toBeGreaterThan(0);
  for (const url of showAllListingUrls) {
    expect(url).toContain('depth=1');
  }
});

test('truncation banner appears for an overflowing level while every root entry stays visible', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const rootDocA = `trunc-root-a-${stamp}`;
  const rootDocB = `trunc-root-b-${stamp}`;
  const bigFolder = `trunc-big-${stamp}`;

  await api.seedDocs([
    { name: rootDocA, markdown: '# a\n' },
    { name: rootDocB, markdown: '# b\n' },
  ]);
  // The overflowing level lives on disk only — the Show All walk reads the
  // disk, so the watcher/index never needs to see these files.
  mkdirSync(join(workerServer.contentDir, bigFolder), { recursive: true });
  for (let i = 0; i < OVERFLOW_CHILD_COUNT; i++) {
    writeFileSync(
      join(workerServer.contentDir, bigFolder, `entry-${String(i).padStart(2, '0')}.md`),
      `# entry ${i}\n`,
      'utf-8',
    );
  }

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const banner = page.getByRole('status').filter({ hasText: 'Showing the first' });

  // The root level is far below the cap: the lazy seed is not truncated.
  await expect(folderRow(page, bigFolder)).toBeVisible({ timeout: 15_000 });
  await expect(banner).toBeHidden();

  // Expanding the overflowing folder trips the per-level entry cap.
  await expandFolder(page, bigFolder);
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(`Showing the first ${SHOW_ALL_CAP} items`);
  // The banner must not mention search: show-all-only files are not in the
  // search index, so search cannot find the hidden items.
  await expect(banner).not.toContainText(/search/i);
  // The capped level did partially load.
  await expect(
    page
      .locator('[data-slot="sidebar-container"]')
      .getByRole('treeitem', { name: /entry-\d+\.md/ })
      .first(),
  ).toBeVisible();

  // The starvation regression in user-visible form: the cap was hit (banner
  // asserted above), yet every root-level entry is still listed — only the
  // overflowing level was capped. Collapse the noisy folder first: the Pierre
  // tree windows its rows, so root entries pushed below the viewport by the
  // 25 child rows are not in the DOM at all until scrolled — the root level
  // must fit the window for row-visibility assertions.
  await collapseFolder(page, bigFolder);
  await expect(fileRow(page, `${rootDocA}.md`)).toBeVisible();
  await expect(fileRow(page, `${rootDocB}.md`)).toBeVisible();
  await expect(fileRow(page, 'test-doc.md')).toBeVisible();
  await expect(folderRow(page, 'sidebar-folder')).toBeVisible();
  await expect(folderRow(page, bigFolder)).toBeVisible();
});
