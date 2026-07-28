/**
 * The project picker as the user meets it: the real bundled React screen in a
 * real Electron window, driven through real Radix controls, over the real
 * `okUninstall` bridge.
 *
 * The dom tests cover the screen's logic against a hand-built props object and
 * the main tests cover index→candidate resolution, but neither proves the two
 * halves meet — that main's candidate list survives the trip down, that the
 * shadcn checkboxes work outside jsdom, and that a confirm reaches main at all.
 *
 * Skip conditions match the other smokes: `OK_DESKTOP_E2E_SMOKE=1` opt-in,
 * darwin only, and a prior `pnpm run build:desktop`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

/** The stand-in projects `OK_UNINSTALL_UI_PREVIEW=picker` offers, home-relative. */
const PREVIEW_PROJECTS = ['/Notes', '/Work/Team Handbook', '/Personal/Journal'];

async function findWindowByPath(
  app: import('@playwright/test').ElectronApplication,
  suffix: string,
): Promise<Page> {
  let match: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const pathname = await page.evaluate(() => window.location.pathname).catch(() => '');
      if (pathname.endsWith(suffix)) {
        match = page;
        return;
      }
    }
    throw new Error(`no window is at a path ending in ${suffix} yet`);
  }).toPass({ timeout: 20_000 });
  if (!match) throw new Error('unreachable');
  return match;
}

test.describe('uninstall project picker smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('renders main’s projects and carries a confirmed selection back', async ({
    captureStderrFor,
  }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-picker-'));

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
        // `picker` opens only the project picker, over stand-in candidates, and
        // resolves without entering the flow. Nothing is removed; gated on
        // `!app.isPackaged` in main.
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'picker' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const picker = await findWindowByPath(app, '/uninstall.html');

    // Main → renderer: every candidate main collected is on screen, by path,
    // and the header selected-of-total counter starts at none of three.
    await expect(picker.getByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeVisible();
    for (const suffix of PREVIEW_PROJECTS) {
      await expect(picker.getByText(suffix, { exact: false })).toBeVisible();
    }
    await expect(picker.getByText('0 / 3', { exact: true })).toBeVisible();

    // The real shadcn checkboxes toggle outside jsdom, and the counter follows.
    // Rows are addressed by their per-project accessible name so the tri-state
    // select-all checkbox in the list header is never mistaken for a row.
    const rowCheckbox = (suffix: string) =>
      picker.getByRole('checkbox', {
        name: new RegExp(`Remove OpenKnowledge from .*${suffix}$`),
      });
    await rowCheckbox('/Notes').click();
    await rowCheckbox('/Personal/Journal').click();
    await expect(picker.getByText('2 / 3', { exact: true })).toBeVisible();

    // The header checkbox is select-all / clear (the two inline buttons folded
    // into one tri-state control): a click from indeterminate selects all, the
    // next clears.
    const selectAll = picker.getByRole('checkbox', { name: 'Select all' });
    await selectAll.click();
    await expect(picker.getByText('3 / 3', { exact: true })).toBeVisible();
    await selectAll.click();
    await expect(picker.getByText('0 / 3', { exact: true })).toBeVisible();

    // Renderer → main: confirming settles the screen in main, which destroys
    // the window and reports back what it resolved the indexes to. That report
    // is the identity proof — main names the project the user actually ticked,
    // not just how many.
    await rowCheckbox('/Work/Team Handbook').click();
    const closed = picker.waitForEvent('close', { timeout: 15_000 });
    await picker.getByRole('button', { name: 'Uninstall OpenKnowledge' }).click();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    const heading = resolved.getByRole('heading');
    await expect(heading).toContainText('Picker confirmed:');
    await expect(heading).toContainText('/Work/Team Handbook');
    await expect(heading).not.toContainText('/Notes');
    await expect(heading).not.toContainText('/Personal/Journal');
  });

  test('closing the picker window cancels rather than proceeding', async ({ captureStderrFor }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-picker-close-'));

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'picker' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const picker = await findWindowByPath(app, '/uninstall.html');
    await expect(picker.getByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeVisible();

    // No button pressed — main has to resolve this as a cancel and must not
    // leave the flow hanging on a window that is already gone.
    const closed = picker.waitForEvent('close', { timeout: 15_000 });
    await picker.close();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Picker cancelled');
  });
});
