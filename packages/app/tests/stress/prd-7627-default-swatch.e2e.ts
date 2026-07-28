/**
 * The Default theme tile must preview the base palette, not whichever palette
 * is currently applied.
 *
 * Real-browser only: the regression is a CSS cascade effect. A selected palette
 * sets `data-color-theme` on `<html>`, and the generated stylesheet overrides
 * `--background` / `--sidebar` / `--primary` / … there. The Default tile used to
 * paint itself from those same `var(--…)` references, so it inherited the
 * override and mirrored the active theme. jsdom applies no stylesheet, so it
 * cannot reach this seam — the DOM test next to `ColorThemePicker.tsx` can only
 * guard the structural half (no `var(--` in the tile).
 *
 * The palette is applied by setting the attribute directly rather than by
 * clicking a tile: `appearance.colorTheme` is USER-scoped config, and the dev
 * server resolves user scope against the real `~/.ok/global.yml`, so a click
 * here would rewrite the developer's own theme. Poking the attribute drives the
 * identical cascade with no write and no dependence on incoming config.
 */
import { expect, test } from './_helpers';

/** Dracula's `--background`, as the generated stylesheet sets it. */
const DRACULA_BG = 'rgb(40, 42, 54)';

test('the Default tile does not inherit the applied palette', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 15_000 });

  // The tile picker lives under Settings → Plugins → Themes; reach it via search.
  await page.getByTestId('settings-search-input').fill('Color theme');
  await page.getByTestId('settings-search-results').getByText('Color theme').first().click();

  const surfaceOf = (label: RegExp) =>
    page
      .getByRole('radio', { name: label })
      .locator('[aria-hidden]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  await expect(page.getByRole('radio', { name: /Default/ })).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-color-theme', 'dracula'));

  // The palette really is cascading — the Dracula tile paints Dracula's canvas.
  await expect.poll(() => surfaceOf(/Dracula/)).toBe(DRACULA_BG);
  // …and the Default tile is unmoved by it. Asserted against the palette rather
  // than a fixed base color so the check holds in either light or dark mode.
  expect(await surfaceOf(/Default/)).not.toBe(DRACULA_BG);
});
