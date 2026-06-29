
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const SHOW_ALL_CAP = 25;
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

async function expandFolder(page: Page, folderName: string): Promise<void> {
  const row = folderRow(page, folderName);
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.focus();
  await row.press('ArrowRight');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

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

  await api.seedDocs([
    { name: rootDoc, markdown: '# root\n' },
    { name: `${folder}/child-a`, markdown: '# a\n' },
    { name: `${folder}/child-b`, markdown: '# b\n' },
  ]);
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

  await expect(folderRow(page, diskOnlyDir)).toBeVisible({ timeout: 15_000 });
  await expect(fileRow(page, `${rootDoc}.md`)).toBeVisible();
  await expect(fileRow(page, 'child-a.md')).toBeHidden();
  expect(showAllListingUrls.some((url) => url.includes(`dir=${encodeURIComponent(folder)}`))).toBe(
    false,
  );

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

  await expect(folderRow(page, nested)).toBeVisible();
  await expect(fileRow(page, 'deep-doc.md')).toBeHidden();
  await expandFolder(page, nested);
  await expect(fileRow(page, 'deep-doc.md')).toBeVisible({ timeout: 15_000 });

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

  await expect(folderRow(page, bigFolder)).toBeVisible({ timeout: 15_000 });
  await expect(banner).toBeHidden();

  await expandFolder(page, bigFolder);
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(`Showing the first ${SHOW_ALL_CAP} items`);
  await expect(banner).not.toContainText(/search/i);
  await expect(
    page
      .locator('[data-slot="sidebar-container"]')
      .getByRole('treeitem', { name: /entry-\d+\.md/ })
      .first(),
  ).toBeVisible();

  await collapseFolder(page, bigFolder);
  await expect(fileRow(page, `${rootDocA}.md`)).toBeVisible();
  await expect(fileRow(page, `${rootDocB}.md`)).toBeVisible();
  await expect(fileRow(page, 'test-doc.md')).toBeVisible();
  await expect(folderRow(page, 'sidebar-folder')).toBeVisible();
  await expect(folderRow(page, bigFolder)).toBeVisible();
});
