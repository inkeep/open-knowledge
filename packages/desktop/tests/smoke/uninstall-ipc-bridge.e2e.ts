import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const CONFIRM_NOTICE_TITLE = 'Uninstall OpenKnowledge?';

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

test.describe('uninstall renderer IPC bridge smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('carries main’s screen down and the user’s intent back up', async ({ captureStderrFor }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-ipc-'));

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(home, 'electron-userdata')}`],
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'renderer' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { home, cleanupDirs: [home] });

    await app.firstWindow({ timeout: 20_000 });
    const editorWindow = await findWindowByPath(app, '/index.html');
    const uninstallWindow = await findWindowByPath(app, '/uninstall.html');

    const exposed = await uninstallWindow.evaluate(() => {
      const bridge = (window as { okUninstall?: object }).okUninstall;
      return bridge === undefined ? null : Object.keys(bridge).sort();
    });
    expect(exposed).toEqual(['ready', 'send']);

    expect(await uninstallWindow.evaluate(() => 'okDesktop' in window)).toBe(false);
    expect(await editorWindow.evaluate(() => 'okDesktop' in window)).toBe(true);

    const screen = await uninstallWindow.evaluate(() =>
      (window as unknown as { okUninstall: { ready(): Promise<unknown> } }).okUninstall.ready(),
    );
    expect(screen).toMatchObject({
      kind: 'screen',
      screen: { kind: 'notice', notice: { title: CONFIRM_NOTICE_TITLE } },
    });

    await expect(
      uninstallWindow.getByRole('heading', { name: CONFIRM_NOTICE_TITLE }),
    ).toBeVisible();

    const closed = uninstallWindow.waitForEvent('close', { timeout: 15_000 });
    await uninstallWindow.evaluate(() => {
      void (
        window as unknown as { okUninstall: { send(intent: unknown): Promise<unknown> } }
      ).okUninstall.send({ kind: 'notice-confirm' });
    });
    await closed;
  });
});
