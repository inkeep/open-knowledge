/**
 * Both notice shapes as the user meets them: the real bundled React screens in
 * real Electron windows, answered through the real `okUninstall` bridge.
 *
 * The dom tests cover the screen against hand-built callbacks, but only main
 * decides what an unanswered window means, and it decides opposite things for
 * the two shapes — a two-button question cancels, a single-button recap
 * confirms. That asymmetry is load-bearing (getting it backwards either quits
 * the flow early or strands a half-uninstalled app) and it is only observable
 * end to end, so it is asserted here.
 *
 * Skip conditions match the other smokes: `OK_DESKTOP_E2E_SMOKE=1` opt-in,
 * darwin only, and a prior `pnpm run build:desktop`.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type Page } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

const CONFIRM_HEADING = 'Uninstall OpenKnowledge?';
const COMPLETION_HEADING = 'OpenKnowledge files were removed';
const RESULTS_HEADING = 'Notice results';

/**
 * Every screen in this preview lives at the same path, so the heading is what
 * tells them apart — and waiting for it also waits out the window main is in
 * the middle of tearing down.
 */
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
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${join(home, 'electron-userdata')}`],
    // `notice` shows the confirm question and the completion recap back to
    // back, then reports how main resolved each. Nothing is removed, nothing is
    // revealed in Finder; gated on `!app.isPackaged` in main.
    env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'notice' },
    timeout: 30_000,
  });
  return { app, home };
}

test.describe('uninstall notice smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

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
    // The recap is the point of this screen: two done items and the one thing
    // still left for the user to do.
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

    // Two buttons, so walking away from it must leave the install alone.
    const confirm = await findNoticeWindow(app, CONFIRM_HEADING);
    let closed = confirm.waitForEvent('close', { timeout: 15_000 });
    await confirm.close();
    await closed;

    const completion = await findNoticeWindow(app, COMPLETION_HEADING);
    // Revealing the log is not an answer — main takes the request and leaves
    // the screen up, or the user would lose the recap by reading the log.
    await completion.getByRole('button', { name: 'Cleanup log' }).click();
    await expect(completion.getByRole('heading', { name: COMPLETION_HEADING })).toBeVisible();

    // One button, so walking away is the only answer there is.
    closed = completion.waitForEvent('close', { timeout: 15_000 });
    await completion.close();
    await closed;

    const results = await findNoticeWindow(app, RESULTS_HEADING);
    await expect(results.getByText('confirm=cancelled')).toBeVisible();
    await expect(results.getByText('completion=confirmed')).toBeVisible();
    await expect(results.getByText('revealLog=1')).toBeVisible();
  });
});
