import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const SCHEMA_PATH = '.ok/schemas/blog.schema.json';

const SETTINGS_FRONTMATTER_HASH = '#settings/plugin:frontmatter';

const SCHEMA_BYTES = `${JSON.stringify(
  {
    type: 'object',
    properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['title'],
  },
  null,
  2,
)}\n`;

const CONFIG_YML = [
  'contentRules:',
  '  frontmatter:',
  '    enabled: true',
  '    schemas:',
  `      - file: "${SCHEMA_PATH}"`,
  '        appliesTo: "**/*.md"',
  '',
].join('\n');

const schemaEditor = (page: Page) => page.locator('[data-schema-config-editor]');
const sourceSegment = (page: Page) =>
  schemaEditor(page).getByRole('radio', { name: 'Source', exact: true });
const loadedSource = (page: Page) =>
  schemaEditor(page).locator('[data-text-viewer][data-text-viewer-state="loaded"]');
const fieldEditor = (page: Page) => page.getByTestId(`frontmatter-field-editor-${SCHEMA_PATH}`);
const settingsEditButton = (page: Page) =>
  page.getByTestId(`frontmatter-schema-edit-${SCHEMA_PATH}`);

async function openFrontmatterSettings(page: Page): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, SETTINGS_FRONTMATTER_HASH);
}

test.describe('schema Edit lands on the Fields view — running-app E2E (PRD-7650)', () => {
  test.beforeEach(({ workerServer }) => {
    mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(join(workerServer.contentDir, SCHEMA_PATH), SCHEMA_BYTES, 'utf-8');
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), CONFIG_YML, 'utf-8');
  });

  test.afterEach(({ workerServer }) => {
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
    rmSync(join(workerServer.contentDir, SCHEMA_PATH), { force: true });
  });

  test('Edit reaches the Fields view when the schema is already the open file', async ({
    page,
    api,
  }) => {
    const docName = `schema-reopen-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();
    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });

    await sourceSegment(page).click();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(fieldEditor(page)).toHaveCount(0);

    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();

    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
    await expect(settingsEditButton(page)).toHaveCount(0);
  });

  test('Edit reaches the Fields view when a different file is open', async ({ page, api }) => {
    const docName = `schema-edit-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    await page.goto(`/#/${docName}`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(schemaEditor(page)).toHaveCount(0);

    await openFrontmatterSettings(page);
    await expect(settingsEditButton(page)).toBeVisible({ timeout: 15_000 });
    await settingsEditButton(page).click();

    await expect(schemaEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(fieldEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
  });
});
