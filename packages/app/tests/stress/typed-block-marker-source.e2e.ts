import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, placeCaretAtEndOfText, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const FIRST_LINE = 'Start here:';

interface MarkerCase {
  marker: string;
  literalLine: string;
  block: string;
  blockLine: string;
}

const CASES: MarkerCase[] = [
  { marker: '*', literalLine: '\\*', block: 'ul > li', blockLine: '* ' },
  { marker: '-', literalLine: '\\-', block: 'ul > li', blockLine: '- ' },
  { marker: '+', literalLine: '\\+', block: 'ul > li', blockLine: '+ ' },
  { marker: '1.', literalLine: '1\\.', block: 'ol > li', blockLine: '1. ' },
  { marker: '#', literalLine: '\\#', block: 'h1', blockLine: '#' },
  { marker: '>', literalLine: '\\>', block: 'blockquote', blockLine: '>' },
];

const sourceWith = (secondLine: string): string => `${FIRST_LINE}\n\n${secondLine}\n`;

const readSource = (page: Page): Promise<string> =>
  page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');

const nextFrame = (page: Page): Promise<void> =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );

test.describe('a block marker typed into a new paragraph', () => {
  for (const { marker, literalLine, block, blockLine } of CASES) {
    test(`"${marker} " writes the empty block's markdown to the source and the saved file`, async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = `typed-block-marker-${randomUUID()}`;
      await api.seedDocs([{ name: docName, markdown: `${FIRST_LINE}\n` }]);
      await page.goto(`/#/${docName}`);
      await waitForActiveProviderSynced(page);
      await expect(page.locator(EDITOR)).toContainText(FIRST_LINE);
      await placeCaretAtEndOfText(page, FIRST_LINE);

      await page.keyboard.press('Enter');
      await nextFrame(page);
      await page.keyboard.type(marker);
      await expect.poll(() => readSource(page)).toBe(sourceWith(literalLine));

      await page.keyboard.type(' ');
      await expect(page.locator(EDITOR).locator(block)).toHaveCount(1);

      await expect.poll(() => readSource(page)).toBe(sourceWith(blockLine));
      await expect
        .poll(() => readFileSync(join(workerServer.contentDir, `${docName}.md`), 'utf8'))
        .toBe(sourceWith(blockLine));
    });
  }
});
