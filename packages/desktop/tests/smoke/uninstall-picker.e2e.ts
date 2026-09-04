import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

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
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'picker' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const picker = await findWindowByPath(app, '/uninstall.html');

    await expect(picker.getByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeVisible();
    for (const suffix of PREVIEW_PROJECTS) {
      await expect(picker.getByText(suffix, { exact: false })).toBeVisible();
    }
    await expect(picker.getByText('0 / 3', { exact: true })).toBeVisible();

    const rowCheckbox = (suffix: string) =>
      picker.getByRole('checkbox', {
        name: new RegExp(`Remove OpenKnowledge from .*${suffix}$`),
      });
    await rowCheckbox('/Notes').click();
    await rowCheckbox('/Personal/Journal').click();
    await expect(picker.getByText('2 / 3', { exact: true })).toBeVisible();

    const selectAll = picker.getByRole('checkbox', { name: 'Select all' });
    await selectAll.click();
    await expect(picker.getByText('3 / 3', { exact: true })).toBeVisible();
    await selectAll.click();
    await expect(picker.getByText('0 / 3', { exact: true })).toBeVisible();

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

    const closed = picker.waitForEvent('close', { timeout: 15_000 });
    await picker.close();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Picker cancelled');
  });
});
