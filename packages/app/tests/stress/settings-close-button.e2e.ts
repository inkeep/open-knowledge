import type { Page } from '@playwright/test';
import { settingsHashScript } from '../../../desktop/src/main/settings-surface.ts';
import { expect, test } from './_helpers';

const APP_READY_TIMEOUT_MS = 30_000;
const DIALOG_TIMEOUT_MS = 15_000;

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('header-settings-button')).toBeVisible({
    timeout: APP_READY_TIMEOUT_MS,
  });
}

async function expectSettingsOpen(page: Page): Promise<void> {
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: DIALOG_TIMEOUT_MS });
}

async function closeWithX(page: Page): Promise<void> {
  await page.getByTestId('settings-dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
  expect(await page.evaluate(() => window.location.hash.startsWith('#settings'))).toBe(false);
}

test.describe('Settings close button', () => {
  test('Settings opened from the header gear closes on one X click', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('header-settings-button').click();
    await expectSettingsOpen(page);
    await closeWithX(page);
  });

  test('Settings opened from the keyboard shortcut closes on one X click', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('ControlOrMeta+,');
    await expectSettingsOpen(page);
    await closeWithX(page);
  });

  test('nothing in the scrolling content covers any part of the X', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await page.getByTestId('header-settings-button').click();
    await expectSettingsOpen(page);
    await expect(page.getByTestId('settings-content-skeleton')).toBeHidden({
      timeout: DIALOG_TIMEOUT_MS,
    });

    const probe = await page.getByTestId('settings-dialog').evaluate(async (dialog) => {
      const close = dialog.querySelector(':scope > [data-slot="dialog-close"]');
      const content = dialog.querySelector('section[aria-label]');
      if (!(close instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return { maxScroll: 0, misses: ['close button or content section missing'] };
      }
      const found: string[] = [];
      const maxScroll = content.scrollHeight - content.clientHeight;
      for (const fraction of [0, 0.5, 1]) {
        content.scrollTop = Math.round(maxScroll * fraction);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const box = close.getBoundingClientRect();
        const midX = box.left + box.width / 2;
        const midY = box.top + box.height / 2;
        const points = [
          [midX, midY],
          [box.left + 1, midY],
          [box.right - 1, midY],
          [midX, box.top + 1],
          [midX, box.bottom - 1],
        ];
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !close.contains(hit)) {
            found.push(`scroll ${fraction} at (${x}, ${y}) hit <${hit?.tagName.toLowerCase()}>`);
          }
        }
      }
      return { maxScroll, misses: found };
    });
    expect(probe.maxScroll).toBeGreaterThan(0);
    expect(probe.misses).toEqual([]);

    await closeWithX(page);
  });

  test('a native-menu Settings request over an open section still closes on one X click', async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.location.hash = '#settings/hotkeys';
    });
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible({ timeout: DIALOG_TIMEOUT_MS });

    await page.evaluate(settingsHashScript());
    await expectSettingsOpen(page);
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible();

    await closeWithX(page);
  });

  test('a native-menu section request over open Settings switches page without stacking history', async ({
    page,
  }) => {
    await openApp(page);
    await page.getByTestId('header-settings-button').click();
    await expectSettingsOpen(page);

    await page.evaluate(settingsHashScript('account'));
    await expect(page).toHaveURL(/#settings\/account$/);
    await expect(page.getByTestId('settings-sidebar-item-account')).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByTestId('settings-sidebar-item-hotkeys').click();
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible({ timeout: DIALOG_TIMEOUT_MS });
    await page.evaluate(settingsHashScript('account'));
    await expect(page.getByTestId('settings-sidebar-item-account')).toHaveAttribute(
      'aria-current',
      'page',
    );

    await closeWithX(page);
  });
});
