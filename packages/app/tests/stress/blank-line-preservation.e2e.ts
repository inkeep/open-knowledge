import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type CaretPlacement,
  expect,
  placeCaretAtEndOfText,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const ABOVE_PARAGRAPH = 'Above.';
const BELOW_PARAGRAPH = 'Below.';
const SEED_SOURCE = `${ABOVE_PARAGRAPH}\n\n${BELOW_PARAGRAPH}\n`;
const ABSENT_PARAGRAPH = 'Nowhere in this document.';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

function countBlankParagraphs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) return -1;
    return [...editor.children].filter(
      (child) => child.tagName === 'P' && (child.textContent ?? '') === '',
    ).length;
  });
}

function readPmSelection(page: Page): Promise<{ from: number; to: number }> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readPmSelection: window.__activeEditor not set');
    return { from: editor.state.selection.from, to: editor.state.selection.to };
  });
}

test.describe('blank lines typed in the visual editor', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-blank-lines-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, SEED_SOURCE);
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

  test('the returned placement is what the editor independently reports', async ({ page }) => {
    const placement: CaretPlacement = await placeCaretAtEndOfText(page, ABOVE_PARAGRAPH);
    const live = await readPmSelection(page);

    expect(
      { from: placement.pmCaret, to: placement.pmCaretTo },
      `placeCaretAtEndOfText returned ${placement.pmCaret}-${placement.pmCaretTo}, but the editor independently reports ${live.from}-${live.to}. The helper owes the reading its own barrier accepted, and this is a separate, later read, so the break is in that promise or in the window after it: the selection moved, or the editor was swapped, before this read`,
    ).toEqual(live);
    expect(
      placement.pmCaret,
      `the editor settled at ${placement.pmCaret} rather than the intended ${placement.intendedCaret}. Enter runs TipTap's splitBlock, which reads tr.selection and never the DOM, so a key dispatched from here splits wherever ProseMirror still believes the caret is`,
    ).toBe(placement.intendedCaret);
    expect(
      placement.editorOwnsDomFocus,
      'caret placement resolved without the editor holding DOM focus, so keys pressed after it would not reach the editor at all',
    ).toBe(true);
  });

  test('caret placement refuses absent text and leaves the selection where it was', async ({
    page,
  }) => {
    const anchored: CaretPlacement = await placeCaretAtEndOfText(page, ABOVE_PARAGRAPH);
    const before = await readPmSelection(page);

    await expect(
      placeCaretAtEndOfText(page, ABSENT_PARAGRAPH),
      `"${ABSENT_PARAGRAPH}" is not in the seeded document, so the helper owes a rejection rather than a return: a caller that presses a key after an unplaced caret splits wherever the editor's selection happened to be, which is the defect this helper exists to close`,
    ).rejects.toThrow(/not found within a single text node/);
    expect(
      await readPmSelection(page),
      `a refused placement moved ProseMirror's selection off ${anchored.intendedCaret}, so the caller is left with a caret this helper relocated on its way to failing`,
    ).toEqual(before);
  });

  test('survive a source-mode round trip and a reload', async ({ page }) => {
    await placeCaretAtEndOfText(page, ABOVE_PARAGRAPH);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe('Above.\n\n\n\n\nBelow.\n');

    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(3);
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe('Above.\n\n\n\n\nBelow.\n');

    await page.reload();
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(3);
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe('Above.\n\n\n\n\nBelow.\n');
  });
});
