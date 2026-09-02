import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = (
      window as unknown as {
        __activeProvider?: { document?: { getText: (n: string) => { toString(): string } } };
      }
    ).__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function awaitSourceQuiescence(page: Page): Promise<string> {
  let prev = '';
  await expect
    .poll(
      async () => {
        const current = await getSourceText(page);
        const stable = current.length > 0 && current === prev;
        prev = current;
        return stable;
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(true);
  return prev;
}

const REPRO_DOC = readFileSync(
  join(import.meta.dirname, '_fixtures/prd-6914-repro-doc.md'),
  'utf-8',
);

test('PRD-6914: reporter doc — valid table renders without error chrome; passive open preserves source bytes', async ({
  page,
  api,
}) => {
  const docName = `prd-6914-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: REPRO_DOC }]);

  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  const before = await awaitSourceQuiescence(page);
  expect(before).toContain('| Flounder | 4 |');
  expect(before).toContain('## Notes for Next Time');

  await expect(page.locator('text=PARSE ERROR')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/prd-6914-open.png', fullPage: true });

  const after = await getSourceText(page);
  expect(after).toBe(before);
});

test('PRD-6914: clicking + escaping real fallback chrome does not mutate source bytes', async ({
  page,
  api,
}) => {
  const interactDoc = [
    '# Fishing Log',
    '',
    '| Species | Count |',
    '| --- | --- |',
    '| Flounder | 4 |',
    '| Lingcod | 0 |',
    '',
    '<Foo>text</Bar>',
    '',
    'closing paragraph',
    '',
  ].join('\n');
  const docName = `prd-6914-interact-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: interactDoc }]);

  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  const before = await awaitSourceQuiescence(page);
  expect(before).toContain('<Foo>text</Bar>');

  await expect(page.locator('text=PARSE ERROR').first()).toBeVisible({ timeout: 10_000 });
  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await expect(fallbackCm).toBeAttached({ timeout: 5_000 });

  await fallbackCm.click();
  await awaitSourceQuiescence(page);
  await page.keyboard.press('Escape');
  await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
  const after = await awaitSourceQuiescence(page);

  expect(after).toBe(before);
  await expect(page.locator('.raw-mdx-fallback-wrapper')).toHaveCount(1);
});
