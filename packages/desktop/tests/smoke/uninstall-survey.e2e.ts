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
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');

    await expect(
      survey.getByRole('heading', { name: 'Thanks for giving OpenKnowledge a try.' }),
    ).toBeVisible();

    await survey.getByRole('radio', { name: 'Bugs, crashes, or it felt unreliable' }).click();
    await survey.getByLabel("Anything you'd like to add? (optional)").fill('it kept crashing');

    const email = survey.getByLabel('Email address');
    await expect(email).toBeHidden();
    await survey.getByRole('checkbox', { name: 'Let us follow up by email' }).click();
    await expect(email).toBeEnabled();
    await email.fill('dev@example.com');

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
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');
    await expect(
      survey.getByRole('heading', { name: 'Thanks for giving OpenKnowledge a try.' }),
    ).toBeVisible();

    const closed = survey.waitForEvent('close', { timeout: 15_000 });
    await survey.close();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Survey continued unanswered');
  });

  test('skipping continues with nothing filed', async ({ captureStderrFor }) => {
    const { app, home } = await launchSurveyPreview('ok-uninstall-survey-skip-');
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const survey = await findWindowByPath(app, '/uninstall.html');

    await survey.getByRole('radio', { name: 'Something else' }).click();
    const closed = survey.waitForEvent('close', { timeout: 15_000 });
    await survey.getByRole('button', { name: 'Skip' }).click();
    await closed;

    const resolved = await findWindowByPath(app, '/uninstall.html');
    await expect(resolved.getByRole('heading')).toHaveText('Survey continued unanswered');
  });
});
