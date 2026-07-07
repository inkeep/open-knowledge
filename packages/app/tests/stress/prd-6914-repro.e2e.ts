/**
 * browser-rung pins — "valid table shows PARSE ERROR chrome; clicking
 * it destroys the source (block becomes the literal word 'table'/'list')".
 *
 * Discriminating rung (fidelity ladder): full-page browser E2E — the error
 * chrome is a React NodeView (RawMdxFallbackCMView) and the destructive step
 * rides real focus/click + the nested-CM→PM sync, none of which lower rungs see.
 *
 * Two complementary pins:
 *
 *   (1) Reporter doc: a valid GFM table renders WITHOUT fallback chrome
 *       at HEAD (the reporter's 0.10.x trigger no longer fires), and a passive
 *       open leaves Y.Text('source') byte-identical. The pre-corrupted
 *       `## Notes for Next Time` section (already destroyed to the literal
 *       `list` in the attachment) is part of the preserved bytes.
 *
 *   (2) Destructive interaction against REAL fallback chrome: no markdown
 *       input can reach the unknown-mdast-type guard at HEAD (the parser only
 *       emits KNOWN_MDAST_TYPES members — that arm is pinned at the unit
 *       tier in unknown-mdast-guard.test.ts), so the chrome is produced
 *       deterministically via the R6 parse-failure path (broken MDX tag).
 *       The reporter's destructive steps — click into the fallback's nested
 *       CodeMirror, escape/blur back out — must not mutate Y.Text by a single
 *       byte. Pre-fix, fallback content that diverged from the source bytes
 *       was written back over the document by exactly this interaction.
 */
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

/**
 * Wait until Y.Text('source') is non-empty and stable across two consecutive
 * polls — observers/persistence have quiesced. Returns the settled text.
 */
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
  // fixture sanity: the table and the pre-corrupted section seeded into Y.Text
  expect(before).toContain('| Flounder | 4 |');
  expect(before).toContain('## Notes for Next Time');

  // The reporter's 0.10.x build wrapped the valid Catch table in PARSE ERROR
  // chrome — that trigger must not fire at HEAD.
  await expect(page.locator('text=PARSE ERROR')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/prd-6914-open.png', fullPage: true });

  // Passive open must not write back a single byte (no silent normalization,
  // no fabricated fallback content persisted over the document).
  const after = await getSourceText(page);
  expect(after).toBe(before);
});

test('PRD-6914: clicking + escaping real fallback chrome does not mutate source bytes', async ({
  page,
  api,
}) => {
  // Broken MDX deterministically renders rawMdxFallback chrome at HEAD via the
  // R6 parse-failure path (same NodeView + nested-CM→PM sync the reporter's
  // destructive click rode). Surround it with real content so a write-back
  // anywhere in the doc would break byte identity.
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

  // The broken tag must render error chrome — this keeps the destructive
  // interaction below from silently becoming a no-op pin.
  await expect(page.locator('text=PARSE ERROR').first()).toBeVisible({ timeout: 10_000 });
  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await expect(fallbackCm).toBeAttached({ timeout: 5_000 });

  // Reporter's destructive steps: click into the fallback's nested CodeMirror,
  // then leave it (Escape + focusing the outer editor triggers the on-blur
  // re-parse path).
  await fallbackCm.click();
  await awaitSourceQuiescence(page);
  await page.keyboard.press('Escape');
  await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
  const after = await awaitSourceQuiescence(page);

  // The interaction must not write back a single byte, and the unchanged
  // still-broken block must keep its fallback chrome (no churn, no upgrade).
  expect(after).toBe(before);
  await expect(page.locator('.raw-mdx-fallback-wrapper')).toHaveCount(1);
});
