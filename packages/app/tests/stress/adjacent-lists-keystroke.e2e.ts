import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function openWith(
  page: Page,
  api: {
    createPage: (n: string) => Promise<unknown>;
    replaceDoc: (n: string, c: string) => Promise<unknown>;
  },
  body: string,
): Promise<string> {
  const docName = `test-adjacent-lists-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, body);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent?.includes('two') ?? false,
    EDITOR,
    { timeout: 10_000 },
  );
  return docName;
}

async function selectParagraphText(page: Page, text: string): Promise<void> {
  await page
    .locator(EDITOR)
    .getByText(text, { exact: true })
    .evaluate((node) => {
      node.closest<HTMLElement>('.ProseMirror')?.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
}

async function caretAtEndOf(page: Page, text: string): Promise<void> {
  await page
    .locator(EDITOR)
    .getByText(text, { exact: true })
    .first()
    .evaluate((node) => {
      node.closest<HTMLElement>('.ProseMirror')?.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
}

test.describe('two lists made adjacent by emptying the paragraph between them', () => {
  test('keeps the keystroke typed after the merge', async ({ page, api }) => {
    await openWith(page, api, '- one\n\nmid\n\n- two\n');

    await selectParagraphText(page, 'mid');
    await page.keyboard.press('Backspace');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('mid');

    await page.keyboard.type('Zed');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Zed');
    const source = await readSource(page);
    expect(source).toContain('one');
    expect(source).toContain('two');
  });

  test('keeps the second list when the keystroke lands in the first one', async ({ page, api }) => {
    await openWith(page, api, '- one\n\n  X\n\nmid\n\n- two\n\n  Y\n');

    await selectParagraphText(page, 'mid');
    await page.keyboard.press('Backspace');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('mid');

    await caretAtEndOf(page, 'X');
    await page.keyboard.type('Q');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Q');
    const source = await readSource(page);
    expect(source).toContain('two');
    expect(source).toContain('Y');
  });
});
