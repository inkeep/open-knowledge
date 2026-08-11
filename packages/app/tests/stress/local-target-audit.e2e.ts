/**
 * Real-browser composition coverage for the local-target audit plane.
 *
 * The lower tiers exercise classification and each UI projection independently.
 * This file proves the production wiring they cannot: real disk events feed the
 * server's watcher-backed inventory, the derived index projects one assessment
 * through HTTP + CC1, and the browser renders the same result in WYSIWYG,
 * source mode, Links, and Problems.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const errors: LogEntry[] = [];

async function openDoc(
  page: Page,
  api: {
    createPage(path: string): Promise<void>;
    replaceDoc(docName: string, md: string): Promise<void>;
  },
  docName: string,
  body: string,
): Promise<void> {
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, body);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
}

async function switchToSource(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  await page.waitForSelector('.cm-content');
}

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const location = msg.location();
    errors.push({
      type: 'error',
      text: msg.text(),
      url: location.url,
      line: location.lineNumber,
    });
  });
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.describe('local-target audit composition', () => {
  test('one classification projects uniformly into Links and Problems', async ({
    page,
    api,
    workerServer,
  }) => {
    const folder = `local-target-matrix-${randomUUID().slice(0, 8)}`;
    const docName = `${folder}/matrix`;
    const assetsDir = join(workerServer.contentDir, folder, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'NOTICE'), 'existing extensionless file\n', 'utf-8');

    await openDoc(
      page,
      api,
      docName,
      [
        '# Local target matrix',
        '',
        '[existing file](assets/NOTICE)',
        '[missing file](assets/missing.pdf)',
        '[missing document](missing.md)',
        '',
      ].join('\n'),
    );

    await page.locator('#tab-links').click();
    await expect(page.getByText('Local files', { exact: true })).toBeVisible();

    const existingFile = `${folder}/assets/NOTICE`;
    const missingFile = `${folder}/assets/missing.pdf`;
    await expect(
      page.getByRole('button', { name: `File ${existingFile}. Go to reference.` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: `Missing file ${missingFile}. Go to reference.` }),
    ).toBeVisible();
    // An existing extensionless file must never leak into the document graph's
    // recovery path, while the genuinely missing document still may be created.
    await expect(page.getByRole('button', { name: /Missing page: existing file/i })).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: /Missing page: .*missing.*\. Click to create\./i,
      }),
    ).toBeVisible();

    await page.locator('#tab-problems').click();
    const problems = page.locator('ul[aria-label="Problems"]');
    await expect(problems).toBeVisible({ timeout: 15_000 });
    await expect(
      problems.getByTestId('problems-source-tag').filter({ hasText: 'links' }),
    ).toHaveCount(2);
    // The file failure reports, but only the document finding offers Create.
    await expect(problems.getByTestId('problems-create-page')).toHaveCount(1);
    await expect(
      problems.getByRole('button', { name: `Create missing page ${folder}/missing` }),
    ).toBeVisible();
  });

  test('creating a missing file heals WYSIWYG and source diagnostics without reload', async ({
    page,
    api,
    workerServer,
  }) => {
    const folder = `local-target-heal-${randomUUID().slice(0, 8)}`;
    const docName = `${folder}/matrix`;
    const relativeTarget = 'assets/report.pdf';
    const targetPath = join(workerServer.contentDir, folder, relativeTarget);
    mkdirSync(join(workerServer.contentDir, folder, 'assets'), { recursive: true });

    await openDoc(page, api, docName, `# Healing\n\n[the report](${relativeTarget})\n`);

    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror) [data-resolution-state="unresolved"]'),
    ).toHaveCount(1, { timeout: 15_000 });

    await switchToSource(page);
    const diagnostic = page.locator('.cm-lint-local-target');
    await expect(diagnostic).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(() => diagnostic.evaluate((element) => getComputedStyle(element).textDecorationStyle))
      .toBe('wavy');

    writeFileSync(targetPath, '%PDF-1.4 real watcher target\n', 'utf-8');

    // Real watcher → local-target index → CC1 local-targets → scoped audit
    // refresh. No page reload or test-only event injection participates.
    await expect(diagnostic).toHaveCount(0, { timeout: 25_000 });

    await page.getByRole('radio', { name: 'Visual editor' }).click();
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror) [data-resolution-state="asset"]'),
    ).toHaveCount(1, { timeout: 15_000 });
  });

  test('deleting a referenced file breaks WYSIWYG and source diagnostics without reload', async ({
    page,
    api,
    workerServer,
  }) => {
    const folder = `local-target-break-${randomUUID().slice(0, 8)}`;
    const docName = `${folder}/matrix`;
    const relativeTarget = 'assets/report.pdf';
    const targetPath = join(workerServer.contentDir, folder, relativeTarget);
    mkdirSync(join(workerServer.contentDir, folder, 'assets'), { recursive: true });
    writeFileSync(targetPath, '%PDF-1.4 real watcher target\n', 'utf-8');

    await openDoc(page, api, docName, `# Breaking\n\n[the report](${relativeTarget})\n`);

    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror) [data-resolution-state="asset"]'),
    ).toHaveCount(1, { timeout: 15_000 });

    await switchToSource(page);
    const diagnostic = page.locator('.cm-lint-local-target');
    await expect(diagnostic).toHaveCount(0);

    unlinkSync(targetPath);

    // The unlink direction of the same wiring the heal test drives: real
    // watcher delete → local-target index → CC1 local-targets → scoped audit
    // refresh surfaces the now-missing target.
    await expect(diagnostic).toHaveCount(1, { timeout: 25_000 });

    await page.getByRole('radio', { name: 'Visual editor' }).click();
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror) [data-resolution-state="unresolved"]'),
    ).toHaveCount(1, { timeout: 15_000 });
  });
});
