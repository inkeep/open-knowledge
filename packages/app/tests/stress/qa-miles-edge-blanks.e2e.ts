/**
 * Browser-rung QA probes for the doc-edge blank-run class (#3132 audit).
 *
 * FWD-11: real Enter keypresses at the very top and bottom of the WYSIWYG
 * reach the source bytes and survive a mode toggle + reload (the forward
 * fix at user fidelity, edges instead of the shipped interior case).
 *
 * INV-11: blank lines typed at the document tail in real CodeMirror source
 * mode appear as blank paragraphs when toggling to the visual editor (the
 * inverse direction at user fidelity).
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

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

test.describe('doc-edge blank runs at browser fidelity', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-qa-edge-${randomUUID().slice(0, 8)}`;
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

  test('FWD-11: Enters at the very top and bottom reach the source bytes and survive toggle + reload', async ({
    page,
  }) => {
    // Deterministic caret placement via the exposed editor handle (the
    // grip-click suite's pattern) — keyboard-only navigation proved unable to
    // reach the document edges under automation. The focus() commit is
    // asynchronous relative to the evaluate's return, so each placement
    // waits for the view to actually hold focus before any key is pressed —
    // a press racing the focus commit lands outside the editor and reads as
    // a minted-nothing keymap defect that does not exist.
    await page.evaluate(() => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('window.__activeEditor not set');
      editor.chain().focus().setTextSelection(1).run();
    });
    await page.waitForFunction(() => window.__activeEditor?.view.hasFocus() === true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('window.__activeEditor not set');
      editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
    });
    await page.waitForFunction(() => window.__activeEditor?.view.hasFocus() === true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    const expected = '\n\nAbove.\n\nBelow.\n\n\n';
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe(expected);

    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(4);
    expect(await readSource(page)).toBe(expected);

    await page.reload();
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(4);
    expect(await readSource(page)).toBe(expected);
  });

  test('INV-11: blank lines typed at the tail in source mode appear in the visual editor', async ({
    page,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    const expected = 'Above.\n\nBelow.\n\n\n';
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toBe(expected);

    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect.poll(() => countBlankParagraphs(page), { timeout: 10_000 }).toBe(2);
    expect(await readSource(page), 'source bytes survive the toggle').toBe(expected);
  });
});
