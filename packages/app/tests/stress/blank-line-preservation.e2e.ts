/**
 * The user-facing shape of blank-line preservation: press Enter a few times,
 * leave, come back, and the blank lines are still there.
 *
 * Every path that used to lose them is a full re-derive of the WYSIWYG
 * fragment from the source bytes, so the two round trips that matter are the
 * source-mode toggle and a reload. Both are exercised here against the real
 * browser keymap, which is the one surface the jsdom and integration tiers
 * cannot reach.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

/** Top-level paragraphs with no text — what a preserved blank line renders as. */
function countBlankParagraphs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) return -1;
    return [...editor.children].filter(
      (child) => child.tagName === 'P' && (child.textContent ?? '') === '',
    ).length;
  });
}

test.describe('blank lines typed in the visual editor', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-blank-lines-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, 'Above.\n\nBelow.\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.ProseMirror:not(.composer-prosemirror)')
          ?.textContent?.includes('Above'),
      null,
      { timeout: 10_000 },
    );
  });

  test('survive a source-mode round trip and a reload', async ({ page }) => {
    // Three Enters at the end of the first paragraph: three empty paragraphs,
    // i.e. three blank lines the user means to keep.
    const firstParagraph = page
      .locator('.ProseMirror:not(.composer-prosemirror)')
      .getByText('Above.', { exact: true });
    await firstParagraph.evaluate((paragraph) => {
      paragraph.closest<HTMLElement>('.ProseMirror')?.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe('Above.\n\n\n\n\nBelow.\n');

    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(3);
    expect(await readSource(page)).toBe('Above.\n\n\n\n\nBelow.\n');

    await page.reload();
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(3);
    expect(await readSource(page)).toBe('Above.\n\n\n\n\nBelow.\n');
  });
});
