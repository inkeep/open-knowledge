import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import { expect, filterCriticalErrors, type LogEntry, test } from './_helpers';

const SCHEMA_MAIN = '.ok/schemas/glob-picker.schema.json';
const SCHEMA_ZERO = '.ok/schemas/glob-picker-zero.schema.json';

const REQUIRED_SCHEMA = JSON.stringify({ type: 'object', required: ['status', 'owner'] });

const errors: LogEntry[] = [];

const schemaRow = (page: Page, file: string) => page.getByTestId(`frontmatter-schema-row-${file}`);
const pickerTrigger = (page: Page, file: string) =>
  page.getByTestId(`frontmatter-schema-pick-folders-${file}`);
const folderItem = (page: Page, file: string, path: string) =>
  page.getByTestId(`frontmatter-schema-folder-item-${file}-${path}`);
const folderList = (page: Page, file: string) =>
  page.getByTestId(`frontmatter-schema-folder-tree-${file}`);
const matchCount = (page: Page, file: string) =>
  page.getByTestId(`frontmatter-schema-match-count-${file}`);
const pillInput = (page: Page, file: string) =>
  page.locator(`[id="frontmatter-schema-applies-${file}"]`);

async function openFrontmatterSettings(page: Page) {
  await page.goto('/#settings/plugin:frontmatter');
  await expect(page.getByTestId('settings-plugin-frontmatter')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page, workerServer }) => {
  mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
  writeFileSync(join(workerServer.contentDir, SCHEMA_MAIN), REQUIRED_SCHEMA, 'utf-8');
  writeFileSync(join(workerServer.contentDir, SCHEMA_ZERO), REQUIRED_SCHEMA, 'utf-8');
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'config.yml'),
    [
      'contentRules:',
      '  frontmatter:',
      '    enabled: true',
      '    schemas:',
      `      - file: ${SCHEMA_MAIN}`,
      `      - file: ${SCHEMA_ZERO}`,
      '        appliesTo:',
      '          - zzz-never/**',
      '',
    ].join('\n'),
    'utf-8',
  );
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('folder picker writes real config', () => {
  test('picking a folder lands folder/** in the pills, the trigger, and config.yml on disk', async ({
    page,
    workerServer,
  }) => {
    const folder = `pick-${randomUUID().slice(0, 8)}`;
    mkdirSync(join(workerServer.contentDir, folder), { recursive: true });
    writeFileSync(join(workerServer.contentDir, folder, 'doc-a.md'), '# a\n', 'utf-8');

    await openFrontmatterSettings(page);
    await pickerTrigger(page, SCHEMA_MAIN).click();
    await expect(folderItem(page, SCHEMA_MAIN, folder)).toBeVisible({ timeout: 15_000 });
    await folderItem(page, SCHEMA_MAIN, folder).click();

    await expect(folderList(page, SCHEMA_MAIN)).toBeVisible();
    await expect(pickerTrigger(page, SCHEMA_MAIN)).toContainText('1 folder picked');
    await expect(schemaRow(page, SCHEMA_MAIN)).toContainText(`${folder}/**`);
    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), 'utf-8'), {
        timeout: 15_000,
      })
      .toContain(`${folder}/**`);
  });

  test('the picked glob actually scopes validation: in-folder doc flags, outside doc does not', async ({
    page,
    api,
    workerServer,
  }) => {
    const folder = `scope-${randomUUID().slice(0, 8)}`;
    const insideDoc = `${folder}/inside`;
    const outsideDoc = `outside-${randomUUID().slice(0, 8)}`;
    mkdirSync(join(workerServer.contentDir, folder), { recursive: true });
    await api.createPage(`${insideDoc}.md`);
    await api.createPage(`${outsideDoc}.md`);
    await api.replaceDoc(insideDoc, '# inside\n');
    await api.replaceDoc(outsideDoc, '# outside\n');

    await openFrontmatterSettings(page);
    await pickerTrigger(page, SCHEMA_MAIN).click();
    await expect(folderItem(page, SCHEMA_MAIN, folder)).toBeVisible({ timeout: 15_000 });
    await folderItem(page, SCHEMA_MAIN, folder).click();
    await expect(schemaRow(page, SCHEMA_MAIN)).toContainText(`${folder}/**`);

    await page.goto(`/#/${insideDoc}`);
    await expect(page.getByTestId('add-properties-problem-badge')).toBeVisible({
      timeout: 20_000,
    });

    await page.goto(`/#/${outsideDoc}`);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText('outside', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('add-properties-problem-badge')).toHaveCount(0);
  });

  test('unchecking a picked folder removes its pattern from config.yml, dropping the appliesTo key', async ({
    page,
    workerServer,
  }) => {
    const folder = `unpick-${randomUUID().slice(0, 8)}`;
    mkdirSync(join(workerServer.contentDir, folder), { recursive: true });
    writeFileSync(join(workerServer.contentDir, folder, 'doc-u.md'), '# u\n', 'utf-8');
    writeFileSync(
      join(workerServer.contentDir, '.ok', 'config.yml'),
      [
        'contentRules:',
        '  frontmatter:',
        '    enabled: true',
        '    schemas:',
        `      - file: ${SCHEMA_MAIN}`,
        '        appliesTo:',
        `          - ${folder}/**`,
        `      - file: ${SCHEMA_ZERO}`,
        '        appliesTo:',
        '          - zzz-never/**',
        '',
      ].join('\n'),
      'utf-8',
    );

    await openFrontmatterSettings(page);
    await expect(schemaRow(page, SCHEMA_MAIN)).toContainText(`${folder}/**`, { timeout: 15_000 });
    await pickerTrigger(page, SCHEMA_MAIN).click();
    const item = folderItem(page, SCHEMA_MAIN, folder);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toHaveAttribute('aria-checked', 'true');

    await item.click();
    await expect(pickerTrigger(page, SCHEMA_MAIN)).toContainText('Pick folders');
    await expect(schemaRow(page, SCHEMA_MAIN)).not.toContainText(`${folder}/**`);
    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), 'utf-8'), {
        timeout: 15_000,
      })
      .not.toContain(`${folder}/**`);
    const config = parse(
      readFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), 'utf-8'),
    ) as {
      contentRules?: { frontmatter?: { schemas?: Array<{ file?: string; appliesTo?: unknown }> } };
    };
    const mapping = config.contentRules?.frontmatter?.schemas?.find((m) => m.file === SCHEMA_MAIN);
    expect(mapping).toBeDefined();
    expect(mapping).not.toHaveProperty('appliesTo');
  });
});

test.describe('live match count against the real page list', () => {
  test('a bare folder name reads 0 with the /** teaching hint; picking the folder fixes it', async ({
    page,
    workerServer,
  }) => {
    const folder = `zm-${randomUUID().slice(0, 8)}`;
    mkdirSync(join(workerServer.contentDir, folder), { recursive: true });
    writeFileSync(join(workerServer.contentDir, folder, 'doc-z.md'), '# z\n', 'utf-8');

    await openFrontmatterSettings(page);
    await pillInput(page, SCHEMA_ZERO).fill(folder);
    await pillInput(page, SCHEMA_ZERO).press('Enter');
    await expect(matchCount(page, SCHEMA_ZERO)).toContainText(/Matches 0 of \d+ docs right now/, {
      timeout: 15_000,
    });
    await expect(matchCount(page, SCHEMA_ZERO)).toContainText('a bare folder name needs /**');

    await pickerTrigger(page, SCHEMA_ZERO).click();
    await expect(folderItem(page, SCHEMA_ZERO, folder)).toBeVisible({ timeout: 15_000 });
    await folderItem(page, SCHEMA_ZERO, folder).click();
    await expect(matchCount(page, SCHEMA_ZERO)).toContainText(/Matches 1 of \d+ docs right now/);
  });
});

test.describe('picker list scrolls inside the Settings dialog', () => {
  test('wheel over the open folder list moves it (react-remove-scroll workaround holds)', async ({
    page,
    workerServer,
  }) => {
    const stem = `scroll-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 20; i++) {
      const dir = join(workerServer.contentDir, `${stem}-${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'doc.md'), '# d\n', 'utf-8');
    }

    await openFrontmatterSettings(page);
    await pickerTrigger(page, SCHEMA_MAIN).click();
    await expect(folderItem(page, SCHEMA_MAIN, `${stem}-00`)).toBeVisible({ timeout: 15_000 });

    const list = folderList(page, SCHEMA_MAIN);
    const overflows = () =>
      list.evaluate((el) => ({
        scrollTop: el.scrollTop,
        overflow: el.scrollHeight - el.clientHeight,
      }));
    expect((await overflows()).overflow).toBeGreaterThan(0);

    const box = await list.boundingBox();
    if (!box) throw new Error('folder list has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await expect.poll(async () => (await overflows()).scrollTop).toBeGreaterThan(0);
  });
});
