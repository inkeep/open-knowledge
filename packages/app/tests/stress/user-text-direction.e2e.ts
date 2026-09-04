import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, test, toggleMode } from './_helpers';

const EDITOR_BODY = '.ProseMirror:not(.composer-prosemirror)';

const LATIN_PROSE = 'Hello world!';
const ARABIC_PROSE = 'مرحبا بالعالم!';

async function setChromeDirection(page: Page, dir: 'ltr' | 'rtl'): Promise<void> {
  await page.evaluate((value: string) => {
    document.documentElement.dir = value;
  }, dir);
}

async function characterLeft(target: Locator, character: string): Promise<number> {
  return target.evaluate((element, char: string) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (textNode === null) throw new Error('element has no text node to measure');
    const offset = (textNode.textContent ?? '').indexOf(char);
    if (offset < 0) throw new Error(`character ${char} not found in ${textNode.textContent}`);
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + char.length);
    return range.getBoundingClientRect().left;
  }, character);
}

async function tabLabelDirection(page: Page, docName: string): Promise<string> {
  const tab = page.locator('[data-active-tab="true"] button', { hasText: docName }).first();
  await expect(tab).toBeVisible();
  return tab.evaluate((element) => getComputedStyle(element).direction);
}

async function seedAndOpen(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `bidi-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector(EDITOR_BODY);
  return docName;
}

test.describe('user-authored text keeps its own direction', () => {
  test('a Latin document is not reordered by a right-to-left interface', async ({ page, api }) => {
    const docName = await seedAndOpen(page, api, LATIN_PROSE);
    await setChromeDirection(page, 'rtl');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const paragraph = page.locator(`${EDITOR_BODY} p`, { hasText: LATIN_PROSE }).first();
    await expect(paragraph).toBeVisible();
    expect(await characterLeft(paragraph, '!')).toBeGreaterThan(
      await characterLeft(paragraph, 'H'),
    );

    expect(await tabLabelDirection(page, docName)).toBe('ltr');
  });

  test('Arabic prose reads right-to-left inside a left-to-right interface', async ({
    page,
    api,
  }) => {
    const docName = await seedAndOpen(page, api, ARABIC_PROSE);

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    const paragraph = page.locator(`${EDITOR_BODY} p`, { hasText: ARABIC_PROSE }).first();
    await expect(paragraph).toBeVisible();
    expect(await paragraph.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe(
      'plaintext',
    );
    expect(await characterLeft(paragraph, '!')).toBeLessThan(await characterLeft(paragraph, 'م'));

    expect(await tabLabelDirection(page, docName)).toBe('ltr');
  });

  test('file tree rows read in the direction the name was written', async ({ page, api }) => {
    await seedAndOpen(page, api, LATIN_PROSE);

    const rowLabel = page.locator("[data-item-section='content']").first();
    await expect(rowLabel).toBeVisible();
    expect(await rowLabel.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe(
      'plaintext',
    );
  });

  test('source mode reads each line in the direction it was written', async ({ page, api }) => {
    await seedAndOpen(page, api, `${ARABIC_PROSE}\n\n${LATIN_PROSE}`);
    await toggleMode(page, 'source');

    const arabicLine = page.locator('.cm-line', { hasText: ARABIC_PROSE }).first();
    const latinLine = page.locator('.cm-line', { hasText: LATIN_PROSE }).first();
    await expect(arabicLine).toBeVisible();
    await expect(latinLine).toBeVisible();

    expect(await arabicLine.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl');
    expect(await latinLine.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr');
  });
});
