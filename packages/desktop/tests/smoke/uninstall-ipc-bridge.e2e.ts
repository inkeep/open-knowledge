/**
 * The renderer↔main boundary of the uninstall window, exercised for real:
 * a built preload, a real `contextBridge` world, a real `ipcRenderer.invoke`,
 * and the real handler in main. Unit tests on either side of this seam can
 * both pass while the two never meet — a preload that never loads leaves
 * `window.okUninstall` undefined and every screen renders blank forever.
 *
 * Also pins the least-privilege half of the design: the uninstall window gets
 * its own tiny preload, so the editor's ~90-channel `window.okDesktop` bridge
 * must NOT be reachable from it. The editor window is checked in the same
 * launch so that assertion can't silently pass against a build where no
 * preload loads at all.
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

/** What main registers for `OK_UNINSTALL_UI_PREVIEW=renderer`. */
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
        // `renderer` opens the React uninstall window showing the confirm notice
        // and closes it on the first intent. Nothing is removed; gated on
        // `!app.isPackaged` in main.
        env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'renderer' },
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [home] });

    // Both windows are located by path, never by open order: the preview opens
    // the uninstall window alongside the cold-launch Navigator, and which one
    // `firstWindow()` returns is a race.
    await app.firstWindow({ timeout: 20_000 });
    const editorWindow = await findWindowByPath(app, '/index.html');
    const uninstallWindow = await findWindowByPath(app, '/uninstall.html');

    // The exposed surface is two methods and nothing else.
    const exposed = await uninstallWindow.evaluate(() => {
      const bridge = (window as { okUninstall?: object }).okUninstall;
      return bridge === undefined ? null : Object.keys(bridge).sort();
    });
    expect(exposed).toEqual(['ready', 'send']);

    // Least privilege: the editor bridge is not reachable from this window —
    // and the editor window proves the check discriminates.
    expect(await uninstallWindow.evaluate(() => 'okDesktop' in window)).toBe(false);
    expect(await editorWindow.evaluate(() => 'okDesktop' in window)).toBe(true);

    // Main → renderer: `ready` answers with the screen main opened this window
    // for, over the real channel.
    const screen = await uninstallWindow.evaluate(() =>
      (window as unknown as { okUninstall: { ready(): Promise<unknown> } }).okUninstall.ready(),
    );
    expect(screen).toMatchObject({
      kind: 'screen',
      screen: { kind: 'notice', notice: { title: CONFIRM_NOTICE_TITLE } },
    });

    // …and the renderer actually rendered what it was handed.
    await expect(
      uninstallWindow.getByRole('heading', { name: CONFIRM_NOTICE_TITLE }),
    ).toBeVisible();

    // Renderer → main: the intent reaches main, which closes the screen it came
    // from. The window going away IS the proof of receipt; awaiting the invoke
    // inside the page would race that teardown.
    const closed = uninstallWindow.waitForEvent('close', { timeout: 15_000 });
    await uninstallWindow.evaluate(() => {
      void (
        window as unknown as { okUninstall: { send(intent: unknown): Promise<unknown> } }
      ).okUninstall.send({ kind: 'notice-confirm' });
    });
    await closed;
  });
});
