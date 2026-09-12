import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './_helpers';

const TEXT_DOC = '[data-text-doc-editor]';
const CM_CONTENT = `${TEXT_DOC} .cm-content`;
const CM_SCROLLER = `${TEXT_DOC} .cm-scroller`;
const COMPOSER = '[data-testid="bottom-composer"]';
const COMPOSER_CARD = `${COMPOSER} > div`;

const LINE_COUNT = 400;

test.describe('editable text doc reserves the Ask AI composer height', () => {
  test('the last line of a code file scrolls clear of the composer card', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-inset-${randomUUID().slice(0, 8)}.ts`;
    const lastLine = `export const lastLineSentinel = ${LINE_COUNT - 1};`;
    const body = Array.from(
      { length: LINE_COUNT - 1 },
      (_, index) => `export const l${index} = ${index};`,
    )
      .concat(lastLine)
      .join('\n');
    writeFileSync(join(workerServer.contentDir, docName), `${body}\n`, 'utf-8');

    await page.goto(`/#/${docName}`);
    await expect(page.locator(CM_CONTENT).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(COMPOSER_CARD).first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number.parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue(
                '--ask-composer-height',
              ) || '0',
            ),
          ),
        {
          message:
            'the composer never published --ask-composer-height, so every assertion below would ' +
            'compare 0 against 0 and pass whether or not the inset rule exists',
          timeout: 20_000,
        },
      )
      .toBeGreaterThan(0);

    await expect
      .poll(
        () =>
          page.evaluate((contentSel) => {
            const content = document.querySelector(contentSel);
            if (!(content instanceof HTMLElement)) throw new Error('no painted .cm-content');
            const composerHeight = Number.parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue('--ask-composer-height'),
            );
            return Number.parseFloat(getComputedStyle(content).paddingBottom) - composerHeight;
          }, CM_CONTENT),
        {
          message:
            'the compiled stylesheet gives `[data-text-doc-editor] .cm-content` no bottom inset ' +
            'matching the composer. `.cm-editor .cm-content { padding: 0 }` ties the shared ' +
            '`.editor-doc-scroll` inset on specificity and wins on document order, so a code file ' +
            'paints its last lines under the floating Ask AI card. Only this tier reads the ' +
            'compiled CSS, so a source-text guard cannot see a regression here',
          timeout: 10_000,
        },
      )
      .toBeCloseTo(0, 0);

    await page.evaluate((scrollerSel) => {
      const scroller = document.querySelector(scrollerSel);
      if (!(scroller instanceof HTMLElement)) throw new Error('no painted .cm-scroller');
      scroller.scrollTop = scroller.scrollHeight;
    }, CM_SCROLLER);

    const lastLineBox = await page
      .locator(`${CM_CONTENT} .cm-line`)
      .filter({ hasText: 'lastLineSentinel' })
      .first()
      .boundingBox();
    const cardBox = await page.locator(COMPOSER_CARD).first().boundingBox();
    if (!lastLineBox || !cardBox) throw new Error('last line or composer card is not painted');

    expect(
      lastLineBox.y + lastLineBox.height,
      'with the scroller pinned to the bottom the final line still paints below the top of the ' +
        'Ask AI card, so it is unreachable however far the user scrolls. The inset has to be ' +
        'tall enough to lift the document floor past the card, not merely non-zero',
    ).toBeLessThanOrEqual(cardBox.y);
  });
});
