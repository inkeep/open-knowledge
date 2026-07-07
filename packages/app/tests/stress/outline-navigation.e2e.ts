/**
 * Outline panel heading navigation.
 *
 * Clicking an outline entry should scroll the matching heading into view in
 * WYSIWYG mode and jump the CodeMirror cursor to the matching heading line in
 * source mode. Source-mode indexing must skip YAML frontmatter so alignment
 * matches the server's extractHeadings output.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * playwright.config.ts webServer on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

const FILLER = 'Filler paragraph to force scrollable content. '.repeat(10);

// Frontmatter is intentionally present to exercise the source-mode frontmatter
// skip. "First" / "Second" / "Third" are distinct so we can disambiguate which
// heading got scrolled/focused.
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
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  // Write content via agent-write-md (replace) so it lands in Y.Text and
  // (after the 2s persistence debounce) on disk where page-headings reads.
  await api.replaceDoc(docName, DOC);

  // Poll page-headings until the 3 headings are observed from disk.
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

  // The WYSIWYG DOM also needs the 3 rendered headings for the click handler
  // to resolve by index.
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

  // "Third Heading" lives below a lot of filler, so before the click the
  // editor scroll container should still be near the top.
  const scroller = page.locator('.subtle-scrollbar').first();
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeLessThan(50);

  await outlinePanel.getByRole('button', { name: 'Third Heading' }).click();

  // Smooth scroll — poll on the heading's viewport-relative top until the
  // animation settles at "near the top of the editor viewport". Tolerance is
  // 250px (editor header ~48px + content padding + smooth-scroll end-state
  // jitter under CPU load). A real regression — the scroll not firing, or
  // landing the heading off-screen — is orders of magnitude larger than
  // this threshold; 250px won't hide it.
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

  // Sanity check that the scroll actually moved.
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

  // CodeMirror's active line highlight should now be on the `## Second Heading`
  // source line. If the frontmatter-skip were broken, index 1 would land on
  // `# First Heading` (or worse, a frontmatter line).
  const activeLineText = await page
    .locator('.cm-activeLine')
    .first()
    .evaluate((el) => el.textContent ?? '');
  expect(activeLineText).toContain('## Second Heading');
});

// Regression test for outline vs DOM index drift when a `#` comment lives inside
// a fenced code block (e.g. a `# electron-builder.yml` YAML comment). Before the
// fix, extractHeadings mis-counted the code-block comment as a level-1 heading,
// so every outline entry after the fence pointed at the *next* DOM heading.
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
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  await api.replaceDoc(docName, DOC_WITH_FENCED_HASH_COMMENT);

  // We expect exactly 3 real headings — the `# config.yaml` inside the fence
  // must NOT appear in the outline.
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
  // Before the fix, clicking "Target Section" would scroll to a phantom heading
  // (the `# config.yaml` comment inside the YAML fence) because the outline
  // treated that fenced `#` as a real heading and pushed every subsequent index
  // off by one.
  await expect(outlinePanel.getByRole('button', { name: 'Target Section' })).toBeVisible();
  await outlinePanel.getByRole('button', { name: 'Target Section' }).click();

  // The "Target Section" h2 should scroll near the viewport top. If the bug
  // reappears, clicking this outline entry scrolls past the real target and
  // lands beyond the end of the content, leaving the h2 far below viewport top.
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

  // The active line must be the real `## Target Section`, not the fenced
  // `# config.yaml` comment. Pre-fix, the source scan counted the code-fence
  // `#` line toward the index and put the cursor on one of the intermediate
  // lines instead.
  const activeLineText = await page
    .locator('.cm-activeLine')
    .first()
    .evaluate((el) => el.textContent ?? '');
  expect(activeLineText).toContain('## Target Section');
});
