
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

const FILLER = 'Filler paragraph to force scrollable content. '.repeat(10);

const SECTION_FILLERS = 10;

const DOC = [
  '---',
  'title: Toolbar Occlusion Test',
  '---',
  '',
  '# First Heading',
  '',
  ...Array(SECTION_FILLERS).fill(FILLER),
  '',
  '## Target Heading',
  '',
  ...Array(SECTION_FILLERS).fill(FILLER),
  '',
  '### Last Heading',
  '',
  FILLER,
  FILLER,
].join('\n');

const TARGET_SLUG = 'target-heading';

async function seedDoc(api: ApiHelpers, page: Page): Promise<string> {
  const docName = `occlusion-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');

  await api.replaceDoc(docName, DOC);

  await page.waitForFunction(
    () =>
      document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length === 3,
    null,
    { timeout: 15_000 },
  );

  return docName;
}

async function primeFullLayout(page: Page): Promise<void> {
  let lastHeight = -1;
  await expect
    .poll(
      async () => {
        const h = await page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          s.scrollTop = s.scrollHeight;
          return s.scrollHeight;
        });
        const stable = h > 0 && h === lastHeight;
        lastHeight = h;
        return stable;
      },
      { timeout: 6_000, intervals: [150, 250, 350] },
    )
    .toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          if (s.scrollTop !== 0) s.scrollTop = 0;
          return s.scrollTop;
        }),
      { timeout: 3_000, intervals: [100, 200] },
    )
    .toBe(0);
}

async function waitForScrollSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await page.evaluate(() => {
          const s = document.querySelector(
            '[data-testid="editor-scroll-container"]',
          ) as HTMLElement | null;
          return s?.scrollTop ?? 0;
        });
        await new Promise((r) => setTimeout(r, 150));
        const b = await page.evaluate(() => {
          const s = document.querySelector(
            '[data-testid="editor-scroll-container"]',
          ) as HTMLElement | null;
          return s?.scrollTop ?? 0;
        });
        return a === b && a > 50;
      },
      { timeout: 5_000, intervals: [200, 400] },
    )
    .toBe(true);
}

async function targetTopMinusToolbarBottom(page: Page, targetSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel);
    const toolbar = document.querySelector('[data-testid="editor-toolbar"]');
    if (!target || !toolbar) {
      throw new Error(`Missing element: target=${!!target}, toolbar=${!!toolbar}`);
    }
    return target.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
  }, targetSelector);
}

const TOOLBAR_OVERLAP_TOLERANCE_PX = 8;

test('WYSIWYG outline click lands the target heading below the editor toolbar', async ({
  page,
  api,
}) => {
  await seedDoc(api, page);
  await primeFullLayout(page);

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Target Heading' })).toBeVisible();

  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await outlinePanel.getByRole('button', { name: 'Target Heading' }).click();

  await waitForScrollSettled(page);

  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  const targetTopFinal = await page
    .locator('.ProseMirror h2')
    .first()
    .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(targetTopFinal).toBeLessThan(400);

  const delta = await targetTopMinusToolbarBottom(page, '.ProseMirror h2');
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});

test('wiki-link anchor navigation lands the target heading below the editor toolbar', async ({
  page,
  api,
}) => {
  const docName = await seedDoc(api, page);
  await primeFullLayout(page);

  await expect(page.locator(`#${TARGET_SLUG}`)).toBeVisible();

  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await page.goto(`/#/${docName}#${TARGET_SLUG}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector(`#${TARGET_SLUG}`);
  await primeFullLayout(page);
  await page.evaluate((slug) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, TARGET_SLUG);

  await waitForScrollSettled(page);

  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  const targetTopFinal = await page
    .locator(`#${TARGET_SLUG}`)
    .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(targetTopFinal).toBeLessThan(400);

  const delta = await targetTopMinusToolbarBottom(page, `#${TARGET_SLUG}`);
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

test('source-mode outline click lands the target heading line below the editor toolbar', async ({
  page,
  api,
}) => {
  await seedDoc(api, page);

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  await primeFullLayout(page);

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Target Heading' })).toBeVisible();

  const scroller = page.locator('[data-testid="editor-scroll-container"]').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await outlinePanel.getByRole('button', { name: 'Target Heading' }).click();

  await waitForScrollSettled(page);

  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);

  const targetLine = page.locator('.cm-content .cm-line', { hasText: 'Target Heading' }).first();
  await expect(targetLine).toBeVisible();

  const lineTop = await targetLine.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(lineTop).toBeLessThan(400);

  const delta = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-content .cm-line')].find((el) =>
      (el.textContent ?? '').includes('Target Heading'),
    );
    const toolbar = document.querySelector('[data-testid="editor-toolbar"]');
    if (!line || !toolbar) {
      throw new Error(`Missing element: line=${!!line}, toolbar=${!!toolbar}`);
    }
    return line.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
  });
  expect(delta).toBeGreaterThanOrEqual(-TOOLBAR_OVERLAP_TOLERANCE_PX);
});
