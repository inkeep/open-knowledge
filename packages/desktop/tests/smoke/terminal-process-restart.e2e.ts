import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

interface RestartSeed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function seedRestartProfile(): RestartSeed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-terminal-restart-home-')));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-terminal-restart-project-')));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Terminal restart\n');
  writeFileSync(join(tmpHome, '.zprofile'), 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"\n');
  writeFileSync(join(tmpHome, '.zshrc'), 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"\n');
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Terminal restart', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, userDataDir, projectDir };
}

async function launchRestartProfile(seed: RestartSeed): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(seed.projectDir)}&doc=start`;
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${seed.userDataDir}`, deepLink],
      env: {
        ...process.env,
        HOME: seed.tmpHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        SHELL: '/bin/zsh',
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined;
  await expect(async () => {
    for (const candidate of app.windows()) {
      const mode = await candidate
        .evaluate(() => window.okDesktop?.config?.mode)
        .catch(() => undefined);
      if (mode === 'editor') {
        page = candidate;
        return;
      }
    }
    throw new Error('editor window unavailable');
  }).toPass({ timeout: 25_000 });
  if (!page) throw new Error('editor window vanished');
  return page;
}

async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const editorWindow = await app.browserWindow(page);
  await editorWindow.evaluate(
    (handle: unknown, size) => {
      (handle as { setSize: (w: number, h: number, animate: boolean) => void }).setSize(
        size.width,
        size.height,
        false,
      );
    },
    { width, height },
  );
  await expect
    .poll(() => page.evaluate(() => window.innerWidth))
    .toBeGreaterThanOrEqual(width - 100);
}

async function clickMenuItem(
  app: ElectronApplication,
  topLabel: string,
  labels: string[],
): Promise<void> {
  await app.evaluate(
    ({ Menu }, payload) => {
      const top = Menu.getApplicationMenu()?.items.find((item) => item.label === payload.topLabel);
      const item = top?.submenu?.items.find((candidate) =>
        payload.labels.includes(candidate.label),
      );
      if (!item)
        throw new Error(`missing ${payload.topLabel} menu item: ${payload.labels.join(' / ')}`);
      item.click();
    },
    { topLabel, labels },
  );
}

const terminalTabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');

async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await clickMenuItem(app, 'View', ['Show Terminal']);
  const terminal = page.locator('section[aria-label="Terminal"]:visible');
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  await expect(terminal.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
}

async function openBareTab(page: Page): Promise<void> {
  await page.getByTestId('terminal-new-chat-menu').click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await expect(terminalTabs(page)).toHaveCount(2, { timeout: 25_000 });
}

async function growRightTerminal(page: Page, deltaPx: number): Promise<number> {
  const column = page.locator('#terminal-column');
  const before = await column.evaluate((element) => element.getBoundingClientRect().width);
  const handle = await column.evaluate((element) => {
    const rect = element.previousElementSibling?.getBoundingClientRect();
    return rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!handle) throw new Error('right Terminal resize handle unavailable');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - deltaPx, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => column.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(before + deltaPx / 2);
  return column.evaluate((element) => element.getBoundingClientRect().width);
}

async function quitAndWait(app: ElectronApplication, child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Electron process did not exit after app.quit()')),
      15_000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await exited;
  expect(child.exitCode ?? child.signalCode).not.toBeNull();
}

test.describe('terminal process restart', () => {
  test.skip(!ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1');
  test.skip(process.platform !== 'darwin', 'Desktop is darwin-only');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('restores placement, width, tab order, and active tab in a separate Electron process', async ({
    captureStderrFor,
  }) => {
    // Two Electron launches and their sequential restore checks have a 220s cumulative budget.
    test.setTimeout(240_000);
    const seed = seedRestartProfile();
    const firstApp = await launchRestartProfile(seed);
    captureStderrFor(firstApp);
    const firstProcess = firstApp.process();
    const firstPage = await findEditorWindow(firstApp);
    await setWindowSize(firstApp, firstPage, 1900, 900);
    await openTerminal(firstApp, firstPage);
    await openBareTab(firstPage);
    // This test owns process-restart persistence; the dedicated terminal-tabs
    // smoke owns pointer-drag behavior. Reordering in the bottom dock keeps
    // this setup independent of right-column overlay geometry.
    await firstPage.locator('section[aria-label="Terminal"]:visible .xterm').click();
    await firstPage.keyboard.press('Meta+Shift+ArrowLeft');
    await expect(terminalTabs(firstPage)).toHaveText(['Terminal 2', 'Terminal 1']);
    await expect(firstPage.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await clickMenuItem(firstApp, 'Terminal', ['Move Terminal to right']);
    await expect(firstPage.locator('#terminal-column')).toBeVisible({ timeout: 10_000 });
    const retainedWidth = await growRightTerminal(firstPage, 120);
    await quitAndWait(firstApp, firstProcess);

    const secondApp = await launchRestartProfile(seed);
    captureStderrFor(secondApp, { cleanupDirs: [seed.tmpHome, seed.projectDir] });
    const secondPage = await findEditorWindow(secondApp);
    await setWindowSize(secondApp, secondPage, 1900, 900);
    await expect(secondPage.locator('#terminal-column')).toBeVisible({ timeout: 25_000 });
    await expect(secondPage.locator('#terminal-dock-panel')).toHaveCount(0);
    await expect(terminalTabs(secondPage)).toHaveText(['Terminal 2', 'Terminal 1'], {
      timeout: 25_000,
    });
    await expect(secondPage.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect
      .poll(async () => {
        const width = await secondPage
          .locator('#terminal-column')
          .evaluate((element) => element.getBoundingClientRect().width);
        return Math.abs(width - retainedWidth);
      })
      .toBeLessThan(20);
  });
});
