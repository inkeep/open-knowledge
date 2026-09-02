import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const APP_FONT_FAMILY = 'Inter Variable';

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

test.describe('uninstall renderer chrome smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('loads the app font, the app tokens, and the theme main resolved', async ({
    captureStderrFor,
  }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-chrome-'));

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'renderer' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const editorWindow = await findWindowByPath(app, '/index.html');
    const uninstallWindow = await findWindowByPath(app, '/uninstall.html');

    const faceStatuses = await uninstallWindow.evaluate(async (family) => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.family.replace(/["']/g, '') === family)
        .map((face) => face.status);
    }, APP_FONT_FAMILY);
    expect(faceStatuses.length).toBeGreaterThan(0);
    expect(faceStatuses).toContain('loaded');

    const mainWantsDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const rendererIsDark = await uninstallWindow.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(rendererIsDark).toBe(mainWantsDark);

    const readPrimary = (page: Page) =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      );
    const uninstallPrimary = await readPrimary(uninstallWindow);
    expect(uninstallPrimary).not.toBe('');
    expect(uninstallPrimary).toBe(await readPrimary(editorWindow));

    await expect(uninstallWindow.locator('#root')).not.toBeEmpty();
  });
});
