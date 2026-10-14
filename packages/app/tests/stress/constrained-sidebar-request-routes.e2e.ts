import { expect, test, waitForActiveProviderSynced } from './_helpers';

const MARKDOWN = '# Sidebar route probe\n\nThe document survives sidebar switching.\n';

test('header, shortcuts and palette switch constrained sidebars without changing stored state', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `sidebar-routes-${crypto.randomUUID()}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await api.seedDocs([{ name: docName, markdown: MARKDOWN }]);
  await page.context().addCookies([{ name: 'sidebar_width', value: '288px', url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('ok-doc-panel-width-v1', '600');
    localStorage.setItem(
      'ok-sidebar-pins-v2',
      JSON.stringify({
        left: { above: 'open', below: 'open', embedded: 'open' },
        right: { above: 'open', below: 'open', embedded: 'open' },
      }),
    );
  });
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const files = page.locator('[data-sidebar="trigger"]');
  const information = page.locator('[data-doc-panel-toggle]');
  const filesCover = page.locator('[data-files-cover]');
  const informationCover = page.locator('[data-doc-panel-cover]');
  const docColumn = page.locator('[data-editor-workspace-column]');

  const assertDock = async (side: 'files' | 'information' | 'both') => {
    await expect(files).toHaveAttribute('aria-expanded', String(side !== 'information'));
    await expect(information).toHaveAttribute('aria-expanded', String(side !== 'files'));
    await expect(filesCover).toHaveCount(0);
    await expect(informationCover).toHaveCount(0);
    await expect
      .poll(async () => (await docColumn.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(300);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  };

  const selectFromPalette = async (query: string, testId: string) => {
    await page.keyboard.press('ControlOrMeta+KeyK');
    const input = page.locator('[data-slot="command-input"]');
    await expect(input).toBeVisible();
    await input.fill(query);
    await page.getByTestId(testId).click();
    await expect(input).toBeHidden();
  };

  await assertDock('both');
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.setViewportSize({ width: 1000, height: 800 });
    await assertDock('files');
    await selectFromPalette('document panel', 'command-palette-toggle-doc-panel');
    await assertDock('information');
    await page.keyboard.press('ControlOrMeta+Alt+KeyS');
    await assertDock('files');
    await information.click();
    await assertDock('information');
    await files.click();
    await assertDock('files');
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await assertDock('information');
    await selectFromPalette('sidebar', 'command-palette-toggle-sidebar');
    await assertDock('files');
    await page.setViewportSize({ width: 560, height: 800 });
    await expect(files).toHaveAttribute('aria-expanded', 'false');
    await expect(information).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ControlOrMeta+Alt+KeyS');
    await expect(filesCover).toBeVisible();
    await expect(informationCover).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await expect(informationCover).toBeVisible();
    await expect(filesCover).toHaveCount(0);
    await page.setViewportSize({ width: 1600, height: 800 });
    await assertDock('both');
  }

  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'The document survives sidebar switching.',
  );
  expect(await page.evaluate(() => localStorage.getItem('ok-doc-panel-width-v1'))).toBe('600');
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'sidebar_width')?.value,
  ).toBe('288px');
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('constrained-sidebar-routes-final.png') });
});
