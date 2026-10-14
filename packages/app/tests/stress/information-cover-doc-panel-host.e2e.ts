import { randomUUID } from 'node:crypto';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

test.use({ video: 'off', trace: 'off' });

test('information cover keeps the same document panel content and selected tab through Back and widening', async ({
  page,
  api,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const docName = `cover-host-${suffix}`;
  const heading = `Cover heading ${suffix}`;
  await api.seedDocs([{ name: docName, markdown: `# ${heading}\n\nRetained body.\n` }]);
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const panel = page.locator('#doc-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: heading })).toBeVisible();
  const panelHeaderNode = await panel.locator('[data-doc-panel-header]').elementHandle();
  if (panelHeaderNode == null) throw new Error('document panel content is missing');

  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('[data-doc-panel-toggle]').click();
    const cover = page.locator('[data-doc-panel-cover]');
    await expect(cover).toBeVisible();
    await expect(cover.getByRole('button', { name: heading })).toBeVisible();
    await expect
      .poll(() =>
        panelHeaderNode.evaluate(
          (element) =>
            element.isConnected &&
            element === document.querySelector('[data-doc-panel-header]') &&
            element.closest('[data-doc-panel-cover]') != null,
        ),
      )
      .toBe(true);

    await cover.getByRole('tab', { name: 'Links' }).click();
    await expect(cover.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
    await cover.locator('[data-doc-panel-back]').click();
    await expect(cover).toHaveCount(0);
    await page.setViewportSize({ width: 2400, height: 900 });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Links' })).toHaveAttribute('data-state', 'on');
    await expect
      .poll(() =>
        panelHeaderNode.evaluate(
          (element) =>
            element.isConnected &&
            element === document.querySelector('[data-doc-panel-header]') &&
            element.closest('#doc-panel') != null &&
            element.closest('[data-doc-panel-cover]') == null,
        ),
      )
      .toBe(true);
  } finally {
    await panelHeaderNode.dispose();
  }
});
