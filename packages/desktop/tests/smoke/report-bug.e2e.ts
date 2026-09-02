import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { expect, type SmokeFixtures, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

async function bootEditorWindow(
  captureStderrFor: SmokeFixtures['captureStderrFor'],
): Promise<{ app: ElectronApplication; page: Page; tmpHome: string }> {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-report-bug-home-')));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-report-bug-project-')));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');

  const userDataDir = join(tmpHome, 'electron-userdata');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Report Bug Smoke', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );

  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDir}`],
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
  captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

  let editorPage: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (mode === 'editor') {
        editorPage = page;
        return;
      }
    }
    throw new Error('editor window not ready yet');
  }).toPass({ timeout: 30_000 });
  if (!editorPage) throw new Error('editor window vanished after readiness poll');
  const page = editorPage;

  await expect(
    page.getByTestId('sidebar-toolbar').getByRole('button', { name: 'New file' }),
  ).toBeVisible({ timeout: 30_000 });

  return { app, page, tmpHome };
}

async function clickReportBugMenuItem(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const appMenu = Menu.getApplicationMenu();
    for (const top of appMenu?.items ?? []) {
      const item = top.submenu?.items.find((candidate) => candidate.label === 'Report a bug…');
      if (item) {
        item.click();
        return;
      }
    }
    throw new Error('Report a bug… menu item not found in any submenu');
  });
}

async function readScreenshotPreview(dialog: Locator): Promise<string | null> {
  const img = dialog.getByRole('img', { name: 'Preview of the screenshot' });
  if ((await img.count()) === 0) return null;
  return await img.getAttribute('src');
}

function skipWhenHostCannotCapture(preview: string | null): asserts preview is string {
  test.skip(
    preview === null,
    'This host composites no readable surface for capturePage(), so main returns an empty image and the dialog offers no screenshot — there are no pixels to compare.',
  );
}

test.describe('Report-a-bug entry points', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('Help menu and palette open the dialog; create lands a zip shown in review', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(140_000);
    const { app, page, tmpHome } = await bootEditorWindow(captureStderrFor);

    await clickReportBugMenuItem(app);
    const composeDialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(composeDialog).not.toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    const paletteRow = page.getByTestId('command-palette-report-bug');
    await expect(paletteRow).toBeVisible({ timeout: 10_000 });
    await paletteRow.click();
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });

    await composeDialog
      .getByRole('textbox', { name: /What happened/ })
      .fill('Report-a-bug smoke note');
    await composeDialog.getByRole('button', { name: 'Create report' }).click();

    const reviewDialog = page.getByRole('dialog', { name: 'Review your report' });
    await expect(reviewDialog).toBeVisible({ timeout: 30_000 });
    await expect(reviewDialog.getByText(/secrets redacted/)).toBeVisible();
    await expect(reviewDialog.getByRole('button', { name: 'Send report' })).toBeVisible();

    const reportsDir = join(tmpHome, '.ok', 'bug-reports');
    const zips = readdirSync(reportsDir).filter((name) => name.endsWith('.zip'));
    expect(zips).toHaveLength(1);
    const zipName = zips[0];
    expect(zipName).toMatch(/-bugreport\.zip$/);
    const zipPath = join(reportsDir, zipName);
    expect(statSync(zipPath).size).toBeGreaterThan(0);
    await expect(reviewDialog.getByTitle(zipName)).toBeVisible();
  });

  test('a report filed with a context menu open captures the menu', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(140_000);
    const { app, page } = await bootEditorWindow(captureStderrFor);

    const composeDialog = page.getByRole('dialog', { name: 'Report a bug' });

    const row = page.getByRole('treeitem', { name: /start\.md/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowBox = await row.boundingBox();
    if (!rowBox) throw new Error('start.md tree row reported no bounding box');
    const pointerX = rowBox.x + rowBox.width / 2;
    const pointerY = rowBox.y + rowBox.height / 2;
    await page.mouse.move(pointerX, pointerY);

    await clickReportBugMenuItem(app);
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    const withoutMenu = await readScreenshotPreview(composeDialog);
    await page.keyboard.press('Escape');
    await expect(composeDialog).not.toBeVisible();

    skipWhenHostCannotCapture(withoutMenu);

    await page.mouse.click(pointerX, pointerY, { button: 'right' });
    const contextMenu = page
      .getByRole('menu')
      .filter({ has: page.getByRole('menuitem', { name: /rename/i }) });
    await expect(contextMenu).toBeVisible({ timeout: 10_000 });
    const menuBox = await contextMenu.boundingBox();
    if (!menuBox) throw new Error('context menu reported no bounding box');

    await clickReportBugMenuItem(app);
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    const withMenu = await readScreenshotPreview(composeDialog);
    if (withMenu === null) throw new Error('the second pass captured nothing while the first did');
    expect(withMenu).not.toEqual(withoutMenu);

    const diff = await app.evaluate(
      ({ nativeImage }, images) => {
        const a = nativeImage.createFromDataURL(images.a).toBitmap();
        const b = nativeImage.createFromDataURL(images.b).toBitmap();
        if (a.length !== b.length || a.length === 0) {
          return { comparable: false, changedPixels: 0, totalPixels: 0 };
        }
        let changedPixels = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changedPixels += 1;
        }
        return { comparable: true, changedPixels, totalPixels: a.length / 4 };
      },
      { a: withoutMenu, b: withMenu },
    );
    expect(diff.comparable, 'the two previews did not decode to comparable bitmaps').toBe(true);

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const menuFraction = (menuBox.width * menuBox.height) / (viewport.width * viewport.height);
    const changedFraction = diff.changedPixels / diff.totalPixels;
    expect(
      changedFraction,
      `changed ${(changedFraction * 100).toFixed(3)}% of the preview; the menu covers ` +
        `${(menuFraction * 100).toFixed(3)}% of the viewport`,
    ).toBeGreaterThan(menuFraction * 0.25);
  });
});
