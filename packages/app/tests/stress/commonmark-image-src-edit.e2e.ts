import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '_fixtures');
const IMAGE = '.jsx-component-wrapper[data-component-type="commonmarkimage"]';

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function openImageProperties(page: Page): Promise<Locator> {
  const wrapper = page.locator(IMAGE).first();
  await wrapper.hover();
  await wrapper.locator('button[data-jsx-gear]').click();
  const panel = page.locator('[data-slot="popover-content"]:has([data-prop-panel])');
  await expect(panel).toBeVisible();
  return panel;
}

async function closeProperties(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
}

test('a src edit on a doc-relative image in the Properties panel saves the new URL', async ({
  page,
  api,
  workerServer,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const docName = `notes/image-src-edit-${suffix}`;
  const imageFile = `img-${suffix}.png`;
  const seed = `# Notes\n\n![](${imageFile})\n\nAfter.\n`;
  await api.createPage(`${docName}.md`);
  writeFileSync(
    join(workerServer.contentDir, 'notes', imageFile),
    readFileSync(join(FIXTURES_DIR, 'real-shot.png')),
  );
  await api.testReset(docName);
  await api.replaceDoc(docName, seed);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(IMAGE).first()).toBeVisible();
  expect(await readSource(page), 'opening the document changed its bytes').toBe(seed);

  let panel = await openImageProperties(page);
  await panel.locator('#prop-src').click();
  await page
    .getByTestId('src-autocomplete-option')
    .filter({ hasText: `notes/${imageFile}` })
    .click();
  await expect(panel.locator('#prop-src')).toHaveValue(`/notes/${imageFile}`);
  await panel.locator('#prop-alt').fill('A chart');
  await closeProperties(panel);
  await expect.poll(() => readSource(page)).toContain('![A chart]');
  expect(
    await readSource(page),
    'picking the image already in src, or an alt edit, rewrote the authored image URL',
  ).toBe(`# Notes\n\n![A chart](${imageFile})\n\nAfter.\n`);

  panel = await openImageProperties(page);
  await panel.locator('#prop-src').fill('other.png');
  await closeProperties(panel);
  await expect
    .poll(() => readSource(page), { message: 'the src edit never reached the source text' })
    .toContain('(other.png)');
  expect(await readSource(page)).toBe('# Notes\n\n![A chart](other.png)\n\nAfter.\n');
});
