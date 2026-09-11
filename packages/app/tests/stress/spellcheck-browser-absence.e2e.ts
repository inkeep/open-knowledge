import type { Page } from '@playwright/test';
import { expect, SETTINGS_PANEL_TIMEOUT_MS, test } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

const TOGGLE_RESULT_ID = 'settings-search-result-subsection:preferences:spellcheck';

const LANGUAGES_RESULT_ID = 'settings-search-result-subsection:preferences:spellcheck-languages';

async function expectBrowserHost(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => (window as { okDesktop?: unknown }).okDesktop === undefined),
  ).toBe(true);
}

async function openUserPreferences(page: Page): Promise<void> {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
  const languageField = page.locator('[data-field="appearance.language"]');
  const item = page.getByTestId('settings-sidebar-item-preferences');
  await expect(async () => {
    if (!(await languageField.isVisible())) await item.click({ timeout: 5_000 });
    await expect(languageField).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
}

test.describe('Spelling settings — browser host', () => {
  test('User Preferences offers no desktop spelling control, and still offers the interface Language control', async ({
    page,
  }) => {
    await openUserPreferences(page);
    await expectBrowserHost(page);

    await expect(page.getByTestId('settings-spelling')).toHaveCount(0);
    await expect(page.getByTestId('settings-spellcheck-row')).toHaveCount(0);
    await expect(page.getByTestId('settings-spellcheck-toggle')).toHaveCount(0);
    await expect(page.getByTestId('settings-spellcheck-languages-row')).toHaveCount(0);

    const combobox = page.locator('[data-field="appearance.language"] [role="combobox"]');
    await expect(combobox).toBeVisible();
    await combobox.click();
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('option', { name: 'English' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('searching spellcheck surfaces no desktop spelling entry on a browser host', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
    await expectBrowserHost(page);

    await page.getByTestId('settings-search-input').fill('Hotkeys');
    await expect(page.getByTestId('settings-search-result-section:hotkeys')).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('settings-search-input').fill('spellcheck');
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(TOGGLE_RESULT_ID)).toHaveCount(0);
    await expect(page.getByTestId(LANGUAGES_RESULT_ID)).toHaveCount(0);
  });

  test('the editor leaves spelling to the browser', async ({ page, api }) => {
    const docName = `test-spellcheck-browser-${Date.now().toString(36)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await page.waitForSelector(EDITOR);
    await expectBrowserHost(page);

    const editable = page.locator(EDITOR).first();
    expect(await editable.getAttribute('spellcheck')).toBeNull();
    expect(
      await editable.evaluate((element) => ({
        editable: (element as HTMLElement).isContentEditable,
        spellcheck: (element as HTMLElement).spellcheck,
      })),
    ).toEqual({ editable: true, spellcheck: true });
  });
});
