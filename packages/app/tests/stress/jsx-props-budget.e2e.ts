import { randomUUID } from 'node:crypto';
import { expect, test } from './_helpers';

test('over-budget MDX props remain editable source without disrupting neighboring content', async ({
  page,
  api,
}) => {
  const docName = `jsx-props-budget-${randomUUID().slice(0, 8)}`;
  const jsx = `<Callout items={${'['.repeat(6000)}0${']'.repeat(6000)}} />`;
  const source = `# Before\n\n${jsx}\n\nAfter remains visible.\n`;
  await api.seedDocs([{ name: docName, markdown: source }]);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced));
  const fallback = page.getByRole('group', {
    name: 'Editing broken MDX source: Component props exceed the rendering budget',
  });
  await expect(fallback).toBeVisible();
  await expect(page.getByText('size limit', { exact: true })).toBeVisible();
  await expect(fallback.getByRole('textbox')).toBeEditable();
  expect(
    await page.evaluate(() => {
      let raw = '';
      window.__activeEditor?.state.doc.descendants((node) => {
        if (node.type.name === 'rawMdxFallback') raw = node.textContent;
      });
      return raw;
    }),
  ).toBe(jsx);
  await expect(page.getByRole('heading', { name: 'Before', exact: true })).toBeVisible();
  await expect(page.getByText('After remains visible.', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.__activeProvider?.document.getText('source').toString()),
  ).toBe(source);
});
