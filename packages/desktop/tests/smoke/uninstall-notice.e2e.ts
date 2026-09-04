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
const COMPLETION_HEADING = 'OpenKnowledge files were removed';
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
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });

    const confirm = await findNoticeWindow(app, CONFIRM_HEADING);
    await expect(
      confirm.getByText('When cleanup finishes, OpenKnowledge will help you remove the app itself'),
    ).toBeVisible();
    let closed = confirm.waitForEvent('close', { timeout: 15_000 });
    await confirm.getByRole('button', { name: 'Uninstall OpenKnowledge' }).click();
    await closed;

    const completion = await findNoticeWindow(app, COMPLETION_HEADING);
    await expect(completion.getByText('Kept your content')).toBeVisible();
    await expect(completion.getByText('Removed OpenKnowledge files')).toBeVisible();
    await expect(completion.getByText('Move OpenKnowledge.app to the Trash')).toBeVisible();
    closed = completion.waitForEvent('close', { timeout: 15_000 });
    await completion.getByRole('button', { name: 'Reveal in Finder' }).click();
    await closed;

    const results = await findNoticeWindow(app, RESULTS_HEADING);
    await expect(results.getByText('confirm=confirmed')).toBeVisible();
    await expect(results.getByText('completion=confirmed')).toBeVisible();
    await expect(results.getByText('revealLog=0')).toBeVisible();
  });

  test('closing an unanswered question cancels, closing a recap confirms', async ({
    captureStderrFor,
  }) => {
    const { app, home } = await launchNoticePreview('ok-uninstall-notice-close-');
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });

    const confirm = await findNoticeWindow(app, CONFIRM_HEADING);
    let closed = confirm.waitForEvent('close', { timeout: 15_000 });
    await confirm.close();
    await closed;

    const completion = await findNoticeWindow(app, COMPLETION_HEADING);
    await completion.getByRole('button', { name: 'Cleanup log' }).click();
    await expect(completion.getByRole('heading', { name: COMPLETION_HEADING })).toBeVisible();

    closed = completion.waitForEvent('close', { timeout: 15_000 });
    await completion.close();
    await closed;

    const results = await findNoticeWindow(app, RESULTS_HEADING);
    await expect(results.getByText('confirm=cancelled')).toBeVisible();
    await expect(results.getByText('completion=confirmed')).toBeVisible();
    await expect(results.getByText('revealLog=1')).toBeVisible();
  });
});
