import { expect, SETTINGS_PANEL_TIMEOUT_MS, test } from './_helpers';

const DRACULA_BG = 'rgb(40, 42, 54)';

test('the Default tile does not inherit the applied palette', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('settings-search-input').fill('Color theme');
  await page.getByTestId('settings-search-results').getByText('Color theme').first().click();

  const surfaceOf = (label: RegExp) =>
    page
      .getByRole('group', { name: label })
      .locator('[data-theme-swatch]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  await expect(page.getByRole('group', { name: /Default/ })).toBeVisible({
    timeout: SETTINGS_PANEL_TIMEOUT_MS,
  });
  await page.evaluate(() => document.documentElement.setAttribute('data-color-theme', 'dracula'));

  await expect.poll(() => surfaceOf(/Dracula/)).toBe(DRACULA_BG);
  expect(await surfaceOf(/Default/)).not.toBe(DRACULA_BG);
});
