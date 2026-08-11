/**
 * Playwright E2E for the appliesTo folder picker — the running-app fidelities
 * the DOM tests structurally cannot reach. The DOM tier mocks BOTH system
 * boundaries (the config binding and the page list), so it proves what the UI
 * sends, not that the system accepts it: the real chain
 *   pick a folder -> CRDT config patch -> persistence -> config.yml on disk
 *   -> server lint compose -> validation scoped to the picked folder
 * is unknown until driven against a live server. This file drives it, plus the
 * one class jsdom is blind to by construction: wheel scrolling the picker's
 * list inside the Settings dialog, where react-remove-scroll's document-level
 * listeners preventDefault native scroll on portaled descendants
 * (radix-ui/primitives#1159) unless the popover's stopPropagation workaround
 * holds. That regression shipped once — jsdom stayed green through it.
 *
 * Isolation: the schema files + config mappings are per-worker (shared across
 * this file's tests), so every test asserts only against its OWN uuid-prefixed
 * folders and patterns — totals like "of N docs" are matched by regex, never
 * pinned, because sibling tests and fixture files contribute to N.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import { expect, filterCriticalErrors, type LogEntry, test } from './_helpers';

const SCHEMA_MAIN = '.ok/schemas/glob-picker.schema.json';
/** Dedicated row for the zero-match test — its count must not see other globs. */
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
  // The panel mounts reactively once the project config doc syncs and reports
  // the plugin enabled — the deep-linked section id is held in state, so this
  // is pure config-sync latency. Generous: under parallel worker start-up the
  // sync can trail first paint by tens of seconds.
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
      // Scoped to a folder that never exists: an UNSCOPED mapping applies to
      // every doc, which would badge the scoping test's "outside" doc from
      // this row and make SCHEMA_MAIN's absence unobservable.
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
  // Restore the default so any e2e sharing this worker isn't left with the
  // frontmatter plugin silently enabled.
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
    // The row is fed by the real /api/documents folder feed; the watcher may
    // still be indexing the folder created above, and the open list re-renders
    // live as the page list refreshes.
    await expect(folderItem(page, SCHEMA_MAIN, folder)).toBeVisible({ timeout: 15_000 });
    await folderItem(page, SCHEMA_MAIN, folder).click();

    // Multi-select: the popover stays open, the trigger now summarizes.
    await expect(folderList(page, SCHEMA_MAIN)).toBeVisible();
    await expect(pickerTrigger(page, SCHEMA_MAIN)).toContainText('1 folder picked');
    // The generated pattern is visible in the escape-hatch pill input's row.
    await expect(schemaRow(page, SCHEMA_MAIN)).toContainText(`${folder}/**`);
    // And the write is REAL: CRDT patch -> persistence -> config.yml bytes.
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

    // The in-scope doc proves the schema is live before the out-of-scope
    // absence means anything: both docs are missing the same two required
    // properties, so the badge difference can only be the picked glob.
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
    // The remove path must start from a PERSISTED glob, not one this test just
    // picked: re-seed the worker config with the mapping already scoped, so
    // the unpick drives a fresh CRDT patch through persistence to disk.
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
    // The seeded glob is live in the row before the picker opens.
    await expect(schemaRow(page, SCHEMA_MAIN)).toContainText(`${folder}/**`, { timeout: 15_000 });
    await pickerTrigger(page, SCHEMA_MAIN).click();
    const item = folderItem(page, SCHEMA_MAIN, folder);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toHaveAttribute('aria-checked', 'true');

    await item.click();
    await expect(pickerTrigger(page, SCHEMA_MAIN)).toContainText('Pick folders');
    await expect(schemaRow(page, SCHEMA_MAIN)).not.toContainText(`${folder}/**`);
    // The removal is REAL: CRDT patch -> persistence -> config.yml bytes.
    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), 'utf-8'), {
        timeout: 15_000,
      })
      .not.toContain(`${folder}/**`);
    // Emptying the list drops the `appliesTo` key rather than writing
    // `appliesTo: []`: the mapping reverts to its unscoped authored shape.
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
    // The original bug-bash failure, typed into the raw input: a bare folder
    // name is an exact-doc pattern and matches nothing.
    await pillInput(page, SCHEMA_ZERO).fill(folder);
    await pillInput(page, SCHEMA_ZERO).press('Enter');
    await expect(matchCount(page, SCHEMA_ZERO)).toContainText(/Matches 0 of \d+ docs right now/, {
      timeout: 15_000,
    });
    await expect(matchCount(page, SCHEMA_ZERO)).toContainText('a bare folder name needs /**');

    // Picking the folder authors the pattern that was meant.
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
    // Enough folders to overflow the CommandList's 300px max height. Created
    // before navigation so the initial page-list fetch already carries them.
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
    // Native wheel must actually move the list. With the popover's
    // stopPropagation workaround removed, react-remove-scroll preventDefaults
    // the event and scrollTop stays 0 — this assertion is the regression pin.
    await expect.poll(async () => (await overflows()).scrollTop).toBeGreaterThan(0);
  });
});
