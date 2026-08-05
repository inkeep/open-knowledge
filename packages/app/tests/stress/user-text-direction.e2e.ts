/**
 * Bidirectional-text isolation E2E.
 *
 * The chrome carries a base direction derived from the interface language and
 * `direction` inherits, so every surface showing text the user wrote has to
 * resolve its own direction from that text. Whether it does is a question about
 * bidi layout, which only a real engine answers — jsdom has none, so the sibling
 * unit tests can pin the markup contract and nothing more.
 *
 * The probe is a trailing `!`. It is a neutral character, so the bidi algorithm
 * parks it at whichever end the paragraph's base direction says is the end:
 * right for a left-to-right base, left for a right-to-left one. Measuring it
 * against the first character therefore reads the resolved base direction out
 * of real layout, rather than restating the rule that was supposed to set it.
 *
 * Implementation under test:
 *   - packages/app/src/globals.css (`unicode-bidi: plaintext` on editor blocks)
 *   - packages/app/src/components/EditorTabs.tsx (`dir="auto"` on tab labels)
 *   - packages/app/src/components/UserText.tsx
 */

import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { type ApiHelpers, expect, test, toggleMode } from './_helpers';

const EDITOR_BODY = '.ProseMirror:not(.composer-prosemirror)';

/** Latin prose, and the same sentence in Arabic. Both end in a neutral `!`. */
const LATIN_PROSE = 'Hello world!';
const ARABIC_PROSE = 'مرحبا بالعالم!';

/**
 * Put the chrome in the state an Arabic or Urdu interface would produce.
 *
 * Set on the document rather than reached through the language preference: the
 * two right-to-left locales are deliberately absent from the picker, and how a
 * locale becomes a `dir` is `language-first-paint.e2e.ts`'s subject, not this
 * file's. What matters here is only that the surrounding chrome says
 * right-to-left while the user's text says otherwise.
 */
async function setChromeDirection(page: Page, dir: 'ltr' | 'rtl'): Promise<void> {
  await page.evaluate((value: string) => {
    document.documentElement.dir = value;
  }, dir);
}

/**
 * Left edge of a single character, taken from real layout via a `Range` over
 * the element's first text node. Selecting the character by value rather than
 * by index keeps the caller from having to count code units in Arabic.
 */
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

/**
 * Resolved writing direction of the active tab's label button.
 *
 * Located by the tab's active-state hook rather than by the attribute under
 * test, so dropping that attribute surfaces as the wrong direction instead of
 * as an element that no longer exists.
 */
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

    // Precondition, not decoration: without a right-to-left chrome the rest of
    // this test would pass on a build with no isolation at all.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const paragraph = page.locator(`${EDITOR_BODY} p`, { hasText: LATIN_PROSE }).first();
    await expect(paragraph).toBeVisible();
    expect(await characterLeft(paragraph, '!')).toBeGreaterThan(
      await characterLeft(paragraph, 'H'),
    );

    // The tab label is the filename, so it resolves left-to-right even though
    // every inherited direction on the page says otherwise.
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
    // Names the rule directly, so a selector that stops matching after a
    // ProseMirror upgrade fails here instead of silently passing the layout
    // assertion for some unrelated reason.
    expect(await paragraph.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe(
      'plaintext',
    );
    expect(await characterLeft(paragraph, '!')).toBeLessThan(await characterLeft(paragraph, 'م'));

    // The Latin filename above it is unaffected — direction is resolved per
    // string, so one Arabic document does not tip the chrome around it.
    expect(await tabLabelDirection(page, docName)).toBe('ltr');
  });

  test('file tree rows read in the direction the name was written', async ({ page, api }) => {
    // The tree is a third-party web component, so its rows are reached through
    // Pierre's stylesheet channel rather than through markup. That makes the
    // selector the risk — it has to keep matching inside someone else's shadow
    // DOM — which is why this is checked against a real tree and not a string.
    await seedAndOpen(page, api, LATIN_PROSE);

    const rowLabel = page.locator("[data-item-section='content']").first();
    await expect(rowLabel).toBeVisible();
    expect(await rowLabel.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe(
      'plaintext',
    );
  });

  test('source mode reads each line in the direction it was written', async ({ page, api }) => {
    // Source mode runs on CodeMirror, which resolves direction through its own
    // facet rather than the stylesheet the two tests above exercise — a
    // separate mechanism, so a separate check.
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
