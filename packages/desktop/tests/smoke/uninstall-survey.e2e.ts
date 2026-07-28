/**
 * The churn survey as the user meets it: the real bundled React screen in a
 * real Electron window, driven through real Radix controls, over the real
 * `okUninstall` bridge.
 *
 * The dom tests cover the screen's logic against hand-built callbacks and the
 * main tests cover answer normalization, but neither proves the two halves
 * meet — that a picked reason survives the trip up as its slug, that the Radix
 * radios and the reveal-on-opt-in email field work outside jsdom, and that
 * closing the window continues the uninstall instead of stalling it.
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

async function launchSurveyPreview(
  prefix: string,
): Promise<{ app: import('@playwright/test').ElectronApplication; home: string }> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
      // `survey` opens only the churn survey and echoes what main resolved back
      // onto a notice. Nothing is removed and nothing is POSTed; gated on
      // `!app.isPackaged` in main.
      env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'survey' },
      timeout: 30_000,
    }),
  );
  return { app, home };
}

test.describe('uninstall churn survey smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('carries a filled-in survey back to main as answers', async ({ captureStderrFor }) => {
    const { app, home } = await launchSurveyPreview('ok-uninstall-survey-');
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');

    await expect(
      survey.getByRole('heading', { name: 'Thanks for giving OpenKnowledge a try.' }),
    ).toBeVisible();

    // The real Radix radio commits outside jsdom.
    await survey.getByRole('radio', { name: 'Bugs, crashes, or it felt unreliable' }).click();
    await survey.getByLabel("Anything you'd like to add? (optional)").fill('it kept crashing');

    // Opting in is what makes the address usable at all: the field ships
    // disabled so a hidden-but-validatable input cannot silently block submit.
    const email = survey.getByLabel('Email address');
    await expect(email).toBeHidden();
    await survey.getByRole('checkbox', { name: 'Let us follow up by email' }).click();
    await expect(email).toBeEnabled();
    await email.fill('dev@example.com');

    // Renderer → main: sending settles the screen in main, which destroys the
    // window and reports back what it resolved. That report is the proof the
    // slug (not the label) made the trip.
    const closed = survey.waitForEvent('close', { timeout: 15_000 });
    await survey.getByRole('button', { name: 'Send & continue' }).click();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    const heading = resolved.getByRole('heading');
    await expect(heading).toContainText('Survey answered');
    await expect(heading).toContainText('reason=unreliable');
    await expect(heading).toContainText('note=it kept crashing');
    await expect(heading).toContainText('email=dev@example.com');
  });

  test('closing the survey window continues rather than cancelling', async ({
    captureStderrFor,
  }) => {
    const { app, home } = await launchSurveyPreview('ok-uninstall-survey-close-');
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');
    await expect(
      survey.getByRole('heading', { name: 'Thanks for giving OpenKnowledge a try.' }),
    ).toBeVisible();

    // No button pressed. Unlike the picker, this must NOT read as a cancel —
    // the uninstall was already confirmed, so an unanswered question has to
    // let the flow carry on with nothing.
    const closed = survey.waitForEvent('close', { timeout: 15_000 });
    await survey.close();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Survey continued unanswered');
  });

  test('skipping continues with nothing filed', async ({ captureStderrFor }) => {
    const { app, home } = await launchSurveyPreview('ok-uninstall-survey-skip-');
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');

    // Answered, then skipped: skip discards rather than sending what is on screen.
    await survey.getByRole('radio', { name: 'Something else' }).click();
    const closed = survey.waitForEvent('close', { timeout: 15_000 });
    await survey.getByRole('button', { name: 'Skip' }).click();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Survey continued unanswered');
  });
});
