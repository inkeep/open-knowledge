import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function waitForSourceQuiescence(page: Page): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const current = await readSource(page);
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000, intervals: [250] },
    )
    .toBe(true);
}

async function caretAtEndOf(page: Page, locatorText: string): Promise<void> {
  const paragraph = page
    .locator('.ProseMirror:not(.composer-prosemirror) > p')
    .filter({ hasText: locatorText })
    .last();
  await paragraph.evaluate((el) => {
    el.closest<HTMLElement>('.ProseMirror')?.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function openDocInSourceMode(
  page: Page,
  api: { createPage: (name: string) => Promise<unknown> },
) {
  const docName = `test-source-undo-flip-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await sourceToggle(page).click();
  const cm = page.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  return cm;
}

test.describe('source undo after a mode flip (live app)', () => {
  test('source-mode Cmd+Z after WYSIWYG edits must not destroy the untouched pre-flip line', async ({
    page,
    api,
  }) => {
    const cm = await openDocInSourceMode(page, api);
    await cm.click();
    await page.keyboard.insertText('hello bug\n\n\nhello bug');
    await expect
      .poll(() => readSource(page), { timeout: 10_000 })
      .toContain('hello bug\n\n\nhello bug');

    await visualToggle(page).click();
    const pm = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(pm).toBeVisible({ timeout: 10_000 });
    await expect(pm).toContainText('hello bug');

    await caretAtEndOf(page, 'hello bug');
    await page.keyboard.insertText(' oops');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('hello bug oops');

    await waitForSourceQuiescence(page);
    const blankParagraph = page
      .locator('.ProseMirror:not(.composer-prosemirror) > p')
      .filter({ hasText: /^$/ })
      .first();
    await blankParagraph.click();
    await page.keyboard.type('zoops', { delay: 40 });
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('zoops');

    await sourceToggle(page).click();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await waitForSourceQuiescence(page);

    const beforeUndo = await readSource(page);
    expect((beforeUndo.match(/hello bug/g) ?? []).length).toBe(2);
    expect(beforeUndo).toContain('hello bug oops');
    expect(beforeUndo).toContain('zoops');

    await cm.click();
    await page.keyboard.press('ControlOrMeta+z');
    await waitForSourceQuiescence(page);

    expect((await readSource(page)).split('\n')).toEqual(beforeUndo.split('\n'));

    await cm.click();
    await page.keyboard.insertText('Q');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Q');
    await waitForSourceQuiescence(page);

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe(beforeUndo);
  });

  test('guard: a casual peek at Visual editor with no edit preserves source undo history', async ({
    page,
    api,
  }) => {
    const cm = await openDocInSourceMode(page, api);
    await cm.click();
    await page.keyboard.insertText('hello bug\n\n\nhello bug');
    await expect
      .poll(() => readSource(page), { timeout: 10_000 })
      .toContain('hello bug\n\n\nhello bug');

    await visualToggle(page).click();
    const pm = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(pm).toBeVisible({ timeout: 10_000 });
    await expect(pm).toContainText('hello bug');

    await sourceToggle(page).click();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await waitForSourceQuiescence(page);

    await cm.click();
    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('hello bug');
  });
});
