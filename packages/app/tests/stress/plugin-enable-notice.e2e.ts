/**
 * E2E coverage for the "you enabled it — here's where to set it up" notice.
 *
 * The jsdom test captures the toast call and invokes its action directly, which
 * leaves the two real-browser seams that actually decide whether this works
 * UNKNOWN:
 *   - The Settings dialog is a MODAL Radix layer, which sets
 *     `pointer-events: none` on <body> and dismisses on any outside
 *     interaction. The toast is portaled outside it. Whether its button can be
 *     clicked at all, and whether that click closes the dialog out from under
 *     the navigation, is a real layout + Radix-dismissal question.
 *   - The deep link is a hash write consumed by the shell's `initialSection`
 *     effect. Only a running app proves the WHOLE chain — toggle → CRDT config
 *     write → sidebar item appears → hash → active panel.
 *
 * Runnable via `pnpm exec playwright test tests/stress/plugin-enable-notice.e2e.ts`;
 * wired into the CI `test:e2e` subset (packages/app/package.json).
 */

import type { Page } from '@playwright/test';
import { expect, setPluginEnabled, test, waitForSettingsPanel } from './_helpers';

/**
 * Reach the Plugins panel while KEEPING a prior history entry, which the shared
 * `openProjectPluginsPanel` does not: it is a plain `goto`, so the dialog's
 * single `history.back()` close would leave the SPA. This file asserts on that
 * close, so the navigation strategy is the difference and the two stay separate.
 */
async function openProjectPluginsViaHashPush(page: Page): Promise<void> {
  // Land on the app FIRST, then push the settings hash, so the dialog's
  // `history.back()` close returns to the doc view instead of leaving the SPA
  // (which a `goto('/#settings/...')` deep link would do — there is no prior
  // in-session entry to go back to). Assigning the hash while Settings is
  // closed pushes exactly one entry, so that single `back()` still closes.
  await page.goto('/');
  await page.evaluate(() => {
    window.location.hash = '#settings/plugins-manage';
  });

  // `#settings/<section>` is the app's own deep link, resolved on the dialog's
  // open edge, so the panel is selected before the body ever renders and no
  // sidebar interaction is involved. That also sidesteps the THIS PROJECT
  // group being `disabled` until `collabUrl` resolves, since the body dispatches
  // on the section id alone.
  //
  // The panel wait carries the shared cold-chunk budget rather than a local
  // number — see `_helpers/settings.ts` for why the settings body is the
  // expensive part and every spec that reaches it needs the same margin.
  await waitForSettingsPanel(page, 'settings-plugins-manage');
}

// The waits in the helper above and in `setPluginEnabled` are diagnostic
// budgets: each is sized so a stall fails by name instead of as a bare test
// timeout. Both run again in `afterEach`, and Playwright charges hook time to
// the same per-test slot, so their worst case does not fit the config's 120s. A
// larger slot keeps those named assertions reachable. It cannot mask a
// regression: the assertion that stalls still exhausts its own budget and fails
// first.
test.setTimeout(180_000);

test.describe('plugin enable → settings notice', () => {
  // The toggle writes the shared per-worker project config; leave it off so a
  // sibling stress file on this worker starts from the documented default.
  test.afterEach(async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
  });

  test('the enable notice is clickable under the modal dialog and lands on the plugin panel', async ({
    page,
  }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);

    await setPluginEnabled(page, 'markdownlint', true);

    // The notice names the plugin and offers its settings.
    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await expect(notice).toBeVisible({ timeout: 5_000 });
    const openSettings = notice.getByRole('button', { name: 'Open settings' });
    await expect(openSettings).toBeVisible();

    await openSettings.click();

    // The click reached the button THROUGH the modal layer, did not dismiss the
    // dialog beneath it, and swapped the body to the plugin's own panel.
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });
    expect(await page.evaluate(() => window.location.hash)).toBe('#settings/plugin:markdownlint');
  });

  test('the notice still lands the user on the panel after Settings is closed', async ({
    page,
  }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);

    await setPluginEnabled(page, 'markdownlint', true);
    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await expect(notice).toBeVisible({ timeout: 5_000 });

    // Dismiss Settings first — the notice outlives the dialog, so its action has
    // to REOPEN Settings rather than assume it is still mounted.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0, { timeout: 5_000 });

    await notice.getByRole('button', { name: 'Open settings' }).click();

    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });
  });

  test('each plugin panel links its docs', async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', true);

    // The plugin's own sidebar row only renders once the config binding
    // reflects the enable, so it can lag the assertion above. Without a bounded
    // precondition a row that never attaches burns the whole test slot and
    // reports a bare test timeout instead of naming the missing element.
    const pluginItem = page.getByTestId('settings-sidebar-item-plugin:markdownlint');
    await expect(pluginItem).toBeVisible({ timeout: 15_000 });
    await pluginItem.click();
    const docs = page.getByTestId('settings-plugin-markdownlint-title-docs-link');
    await expect(docs).toBeVisible({ timeout: 5_000 });
    await expect(docs).toHaveAttribute(
      'href',
      'https://openknowledge.ai/docs/advanced/content-rules/markdownlint',
    );
  });
});

test.describe('plugin enable notice — repeat use while Settings is open', () => {
  test.afterEach(async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
  });

  test('one Escape closes Settings after the notice navigated in-dialog', async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
    await setPluginEnabled(page, 'markdownlint', true);

    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await notice.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });

    // In-dialog navigation must not leave a history entry that the single
    // history.back() close has to absorb.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0, { timeout: 5_000 });
  });
});
