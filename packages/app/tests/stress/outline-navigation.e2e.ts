
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

const FILLER = 'Filler paragraph to force scrollable content. '.repeat(10);

const DOC = [
  '---',
  'title: Outline Navigation Test',
  '---',
  '',
  '# First Heading',
  '',
  FILLER,
  FILLER,
  FILLER,
  FILLER,
  FILLER,
  '',
  '## Second Heading',
  '',
  FILLER,
  FILLER,
  FILLER,
  FILLER,
  FILLER,
  '',
  '### Third Heading',
  '',
  FILLER,
  FILLER,
].join('\n');

async function seedDoc(api: ApiHelpers, page: Page, baseURL: string): Promise<string> {
  const docName = `outline-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');

  await api.replaceDoc(docName, DOC);

  await expect
    .poll(
      async () => {
        const r = await fetch(`${baseURL}/api/page-headings?docName=${docName}`);
        if (!r.ok) return 0;
        const d = (await r.json()) as { ok: boolean; headings?: unknown[] };
        return d.ok ? (d.headings?.length ?? 0) : 0;
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toBe(3);

  await page.waitForFunction(
    () =>
      document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length === 3,
    null,
    { timeout: 10_000 },
  );

  return docName;
}

test('outline click scrolls to the matching heading in WYSIWYG mode', async ({
  page,
  api,
  baseURL,
}) => {
  await seedDoc(api, page, baseURL ?? '');

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Third Heading' })).toBeVisible();

  const scroller = page.locator('.subtle-scrollbar').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await outlinePanel.getByRole('button', { name: 'Third Heading' }).click();

  await expect
    .poll(
      async () =>
        page
          .locator('.ProseMirror h3')
          .first()
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      { timeout: 5_000, intervals: [100, 200, 400] },
    )
    .toBeLessThan(250);

  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBeGreaterThan(scrollBefore + 100);
});

test('browser-style anchor hash opens the doc and scrolls to the matching WYSIWYG heading', async ({
  page,
  api,
}) => {
  const docName = `anchor-hash-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: DOC }]);

  await page.goto(`/#/${docName}#third-heading`);
  await page.waitForFunction(
    (expectedDocName) =>
      window.__activeProvider?.configuration.name === expectedDocName &&
      Boolean(window.__activeProvider?.isSynced),
    docName,
    { timeout: 15_000 },
  );
  await page.waitForSelector('.ProseMirror h3');

  await expect
    .poll(
      async () =>
        page
          .locator('.ProseMirror h3')
          .first()
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      { timeout: 5_000, intervals: [100, 200, 400] },
    )
    .toBeLessThan(250);
});

test('outline click in source mode puts cursor on the heading line, skipping frontmatter', async ({
  page,
  api,
  baseURL,
}) => {
  await seedDoc(api, page, baseURL ?? '');

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  const outlinePanel = page.locator('#panel-outline');
  await outlinePanel.getByRole('button', { name: 'Second Heading' }).click();

  const activeLineText = await page
    .locator('.cm-activeLine')
    .first()
    .evaluate((el) => el.textContent ?? '');
  expect(activeLineText).toContain('## Second Heading');
});

const DOC_WITH_FENCED_HASH_COMMENT = [
  '---',
  'title: Outline With Fenced Code',
  '---',
  '',
  '# First Heading',
  '',
  FILLER,
  FILLER,
  FILLER,
  '',
  '## Section With Config',
  '',
  '```yaml',
  '# config.yaml',
  'name: example',
  '```',
  '',
  FILLER,
  FILLER,
  FILLER,
  '',
  '## Target Section',
  '',
  FILLER,
  FILLER,
].join('\n');

async function seedFencedDoc(api: ApiHelpers, page: Page, baseURL: string): Promise<string> {
  const docName = `outline-fence-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');

  await api.replaceDoc(docName, DOC_WITH_FENCED_HASH_COMMENT);

  await expect
    .poll(
      async () => {
        const r = await fetch(`${baseURL}/api/page-headings?docName=${docName}`);
        if (!r.ok) return 0;
        const d = (await r.json()) as { ok: boolean; headings?: unknown[] };
        return d.ok ? (d.headings?.length ?? 0) : 0;
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toBe(3);

  await page.waitForFunction(
    () => document.querySelectorAll('.ProseMirror h1, .ProseMirror h2').length === 3,
    null,
    { timeout: 10_000 },
  );

  return docName;
}

test('outline click lands on the correct heading when `#` appears inside a code fence', async ({
  page,
  api,
  baseURL,
}) => {
  await seedFencedDoc(api, page, baseURL ?? '');

  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel.getByRole('button', { name: 'Target Section' })).toBeVisible();
  await outlinePanel.getByRole('button', { name: 'Target Section' }).click();

  await expect
    .poll(
      async () =>
        page
          .locator('.ProseMirror h2', { hasText: 'Target Section' })
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      { timeout: 5_000, intervals: [100, 200, 400] },
    )
    .toBeLessThan(250);
});

test('source-mode outline click lands on the correct line when `#` appears inside a code fence', async ({
  page,
  api,
  baseURL,
}) => {
  await seedFencedDoc(api, page, baseURL ?? '');

  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');

  const outlinePanel = page.locator('#panel-outline');
  await outlinePanel.getByRole('button', { name: 'Target Section' }).click();

  const activeLineText = await page
    .locator('.cm-activeLine')
    .first()
    .evaluate((el) => el.textContent ?? '');
  expect(activeLineText).toContain('## Target Section');
});
