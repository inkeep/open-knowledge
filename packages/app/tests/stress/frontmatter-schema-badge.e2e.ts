import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const TAB_LINE = '\tindented with a hard tab';
const NO_FRONTMATTER_BODY = `# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
const INVALID_ENUM_BODY = `---\nstatus: shipped\nowner: sam\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
const MIXED_BODY = `---\nstatus: shipped\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
const CONFORMANT_BODY = `---\nstatus: draft\nowner: sam\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;

const errors: LogEntry[] = [];
let testDocName = '';

const addPropertiesButton = (page: Page) => page.getByTestId('add-properties-button');
const missingBadge = (page: Page) => page.getByTestId('add-properties-problem-badge');
const invalidBadge = (page: Page) => page.getByTestId('property-problem-badge');
const decoratedBlocks = (page: Page) =>
  page.locator('.ProseMirror:not(.composer-prosemirror) > .ok-lint-block');

const markedBlockIndex = (page: Page) =>
  page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) return -1;
    return Array.from(editor.children).findIndex((child) =>
      child.classList.contains('ok-lint-block'),
    );
  });

async function seed(page: Page, api: ApiHelpers, markdown: string) {
  await api.replaceDoc(testDocName, markdown);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText('hard tab', {
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page, api, workerServer }) => {
  mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'schemas', 'doc.schema.json'),
    JSON.stringify({
      type: 'object',
      required: ['status', 'owner'],
      properties: { status: { enum: ['draft', 'review', 'published'] } },
    }),
    'utf-8',
  );
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'config.yml'),
    [
      'contentRules:',
      '  markdownlint:',
      '    enabled: true',
      '  frontmatter:',
      '    enabled: true',
      '    schemas:',
      '      - file: .ok/schemas/doc.schema.json',
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

  testDocName = `fmbadge-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${testDocName}.md`);
  await page.goto(`/#/${testDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('frontmatter schema violations in WYSIWYG', () => {
  test('a doc missing required frontmatter marks the tab block only, never the heading', async ({
    page,
    api,
  }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    await expect(missingBadge(page)).toBeVisible();
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });

  test('missing properties report on the Add-properties button', async ({ page, api }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    await expect(missingBadge(page)).toHaveText('2');
    await expect(addPropertiesButton(page)).toHaveAttribute(
      'aria-label',
      /2 required properties missing/,
    );
    await expect(invalidBadge(page)).toHaveCount(0);
  });

  test('a present-but-invalid property reports on the Properties count, not the button', async ({
    page,
    api,
  }) => {
    await seed(page, api, INVALID_ENUM_BODY);
    await expect(invalidBadge(page)).toHaveText('1');
    await expect(page.getByTestId('property-problem-badge-trigger')).toHaveAttribute(
      'aria-label',
      /1 property does not match the schema/,
    );
    await expect(missingBadge(page)).toHaveCount(0);
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });

  test('one of each lands on its own affordance', async ({ page, api }) => {
    await seed(page, api, MIXED_BODY);
    await expect(invalidBadge(page)).toHaveText('1');
    await expect(missingBadge(page)).toHaveText('1');
  });

  test('both badges clear once the frontmatter satisfies the schema', async ({ page, api }) => {
    await seed(page, api, MIXED_BODY);
    await expect(invalidBadge(page)).toBeVisible();
    await expect(missingBadge(page)).toBeVisible();

    await api.replaceDoc(testDocName, CONFORMANT_BODY);
    await expect(invalidBadge(page)).toHaveCount(0);
    await expect(missingBadge(page)).toHaveCount(0);
    await expect(addPropertiesButton(page)).toHaveAttribute('aria-label', 'Add properties');
    await expect(decoratedBlocks(page)).toHaveCount(1);
  });
});

test.describe('body-anchored decorations survive block reordering', () => {
  test('the mark follows its block up and back down again', async ({ page, api }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(2);

    const moveMarkedBlock = (direction: 'up' | 'down') =>
      page.evaluate((dir) => {
        const editor = window.__activeEditor;
        if (!editor) throw new Error('no active editor');
        let target = -1;
        editor.state.doc.forEach((node, offset) => {
          if (node.textContent.includes('hard tab')) target = offset;
        });
        if (target < 0) throw new Error('marked block not found');
        editor.commands.focus();
        editor.commands.setTextSelection(target + 1);
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        editor.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: dir === 'up' ? 'ArrowUp' : 'ArrowDown',
            metaKey: isMac,
            ctrlKey: !isMac,
            shiftKey: true,
            bubbles: true,
          }),
        );
      }, direction);

    await moveMarkedBlock('up');
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(1);

    await moveMarkedBlock('down');
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(2);
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });
});
