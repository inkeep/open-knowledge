import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  focusEditor,
  selectText,
  simulateCopyAndRead,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const LINK_CHIP = `${EDITOR} span[data-link]`;
const URL_LITERAL = 'https://inkeep.com';

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function pasteText(page: Page, text: string) {
  await page.evaluate((content) => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) throw new Error('ProseMirror editor not found');
    const dt = new DataTransfer();
    dt.setData('text/plain', content);
    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
  }, text);
}

async function pmLinkSnapshot(page: Page): Promise<{ hasLink: boolean; text: string }> {
  return page.evaluate(() => {
    const ed = window.__activeEditor;
    return {
      hasLink: JSON.stringify(ed?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
      text: ed?.state.doc.textContent ?? '',
    };
  });
}

async function waitForPmLink(page: Page): Promise<void> {
  await page.waitForFunction(
    () => JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
    null,
    { timeout: 5_000 },
  );
}

test.describe('lone-URL paste at cursor — bare-literal bytes', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-cursor-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await page.click(EDITOR);
  });

  test('pasted lone URL lands as a link with exactly the bare-literal bytes', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
  });

  test('WYSIWYG copy of the pasted link round-trips clean text/plain', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toBe('https://inkeep.com\n');
  });

  test('one undo removes the pasted link entirely', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });

  test('explicit-scheme dotless host (localhost) pastes as a link with bare-literal bytes', async ({
    page,
  }) => {
    const localUrl = 'http://localhost:5174/#/some-doc';
    await pasteText(page, localUrl);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe(`${localUrl}\n`);
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${localUrl}"]`)).toHaveCount(1);
  });
});

test.describe('lone-URL paste over a selection — [text](url) bytes', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-sel-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await api.replaceDoc(docName, 'inkeep docs\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('inkeep docs\n');
    await expect(page.locator(`${EDITOR} p`).first()).toContainText('inkeep docs');
  });

  test('pasting a URL over a selected word keeps the text and links it', async ({ page }) => {
    await selectText(page, 'docs');
    await pasteText(page, URL_LITERAL);
    await expect
      .poll(() => getYText(page), { timeout: 5_000 })
      .toBe('inkeep [docs](https://inkeep.com)\n');
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
  });

  test('one undo restores the pre-paste unlinked text', async ({ page }) => {
    await selectText(page, 'docs');
    await pasteText(page, URL_LITERAL);
    await expect
      .poll(() => getYText(page), { timeout: 5_000 })
      .toBe('inkeep [docs](https://inkeep.com)\n');
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('inkeep docs\n');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });
});

test.describe('typed URL + space — GFM autolink byte contract', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-typed-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await page.click(EDITOR);
  });

  test('typed GFM URL converts on space; bytes settle bare on the next edit', async ({ page }) => {
    await page.keyboard.type('https://inkeep.com ');
    await waitForPmLink(page);
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
    await page.keyboard.type('done');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com done\n');
  });

  test('typed filename-shaped token stays plain and serializes unlinked', async ({ page }) => {
    await page.keyboard.type('AGENTS.md ');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('AGENTS.md\n');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });

  test('one undo removes only the mark — text intact, bytes re-escape', async ({ page }) => {
    await page.keyboard.type('https://inkeep.com ');
    await waitForPmLink(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(() => pmLinkSnapshot(page), { timeout: 5_000 })
      .toEqual({ hasLink: false, text: 'https://inkeep.com ' });
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
    await page.keyboard.type('x');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https\\://inkeep.com x\n');
  });
});
