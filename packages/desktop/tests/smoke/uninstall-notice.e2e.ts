import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const CONFIRM_HEADING = 'Uninstall OpenKnowledge?';
const FAILURE_HEADING = 'Cleanup didn’t finish';
const RESULTS_HEADING = 'Notice results';

async function findNoticeWindow(
  app: import('@playwright/test').ElectronApplication,
  heading: string,
): Promise<Page> {
  let match: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const pathname = await page.evaluate(() => window.location.pathname).catch(() => '');
      if (!pathname.endsWith('/uninstall.html')) continue;
      const title = await page
        .locator('h1')
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null);
      if (title === heading) {
        match = page;
        return;
      }
    }
    throw new Error(`no uninstall window is showing "${heading}" yet`);
  }).toPass({ timeout: 20_000 });
  if (!match) throw new Error('unreachable');
  return match;
}

async function launchNoticePreview(
  prefix: string,
): Promise<{ app: import('@playwright/test').ElectronApplication; home: string }> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
      env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'notice' },
      timeout: 30_000,
    }),
  );
  return { app, home };
}

test.describe('uninstall notice smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('pressing each notice through carries the answer to main', async ({ captureStderrFor }) => {
    const { app, home } = await launchNoticePreview('ok-uninstall-notice-');
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });

    const confirm = await findNoticeWindow(app, CONFIRM_HEADING);
    await expect(confirm.getByText('OpenKnowledge will quit before cleanup starts.')).toBeVisible();
    let closed = confirm.waitForEvent('close', { timeout: 15_000 });
    await confirm.getByRole('button', { name: 'Uninstall OpenKnowledge' }).click();
    await closed;

    const failure = await findNoticeWindow(app, FAILURE_HEADING);
    await expect(
      failure.getByText('The cleanup helper could not start. No cleanup was started.'),
    ).toBeVisible();
    closed = failure.waitForEvent('close', { timeout: 15_000 });
    await failure.getByRole('button', { name: 'Continue' }).click();
    await closed;

    const results = await findNoticeWindow(app, RESULTS_HEADING);
    await expect(results.getByText('confirm=confirmed')).toBeVisible();
    await expect(results.getByText('failure=confirmed')).toBeVisible();
  });

  test('closing an unanswered question cancels, closing a failure notice acknowledges it', async ({
    captureStderrFor,
  }) => {
    const { app, home } = await launchNoticePreview('ok-uninstall-notice-close-');
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });

    const confirm = await findNoticeWindow(app, CONFIRM_HEADING);
    let closed = confirm.waitForEvent('close', { timeout: 15_000 });
    await confirm.close();
    await closed;

    const failure = await findNoticeWindow(app, FAILURE_HEADING);
    await expect(failure.getByRole('heading', { name: FAILURE_HEADING })).toBeVisible();

    closed = failure.waitForEvent('close', { timeout: 15_000 });
    await failure.close();
    await closed;

    const results = await findNoticeWindow(app, RESULTS_HEADING);
    await expect(results.getByText('confirm=cancelled')).toBeVisible();
    await expect(results.getByText('failure=confirmed')).toBeVisible();
  });
});
