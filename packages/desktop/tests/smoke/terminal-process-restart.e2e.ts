import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import {
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
} from './_helpers/terminal-smoke-shell';
import {
  expectTerminalTabOrder,
  openBareTerminalTab,
  renameTerminalTab,
  terminalTabById,
  terminalTabIds,
  terminalTabs,
} from './_helpers/terminal-tabs.test-helper';

const TARGET = resolveDesktopTarget();
const ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

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
  seedTerminalShellProfiles(tmpHome, { restrictPath: true });
  const userDataDir = userDataDirFor(tmpHome);
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
        ...terminalSmokeEnvironment(seed.tmpHome, {
          restrictPath: true,
          pinPosixZsh: true,
        }),
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

async function dispatchRendererMenuAction(
  page: Page,
  action: 'move-terminal' | 'toggle-terminal',
): Promise<void> {
  await page.evaluate(async (menuAction) => {
    const menu = window.okDesktop?.menu;
    if (!menu) throw new Error('renderer menu bridge is unavailable');
    await menu.dispatch({ kind: 'menu-action', action: menuAction });
  }, action);
}

async function openTerminal(page: Page): Promise<void> {
  const terminal = page.locator('section[aria-label="Terminal"]:visible');
  await expect(async () => {
    // A prior dispatch can land between attempts; observe first so a retry cannot hide it again.
    if (await terminal.isVisible()) return;
    await dispatchRendererMenuAction(page, 'toggle-terminal');
    await expect(terminal).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 15_000 });
  await expect(terminal.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
}

async function openBareTab(page: Page): Promise<void> {
  await openBareTerminalTab(page, async () => {
    await expect(
      page.locator('section[aria-label="Terminal"]:visible [data-terminal-status]'),
    ).toHaveAttribute('data-terminal-status', 'running', { timeout: 25_000 });
  });
}

async function applyPersistedRightTerminalWidth(page: Page, width: number): Promise<number> {
  await page.evaluate((nextWidth) => {
    localStorage.setItem('ok-terminal-right-width-v1', String(nextWidth));
  }, width);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const column = page.locator('#terminal-column');
  await expect(column).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const renderedWidth = await column.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      return Math.abs(renderedWidth - width);
    })
    .toBeLessThan(20);
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
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
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
    await openTerminal(firstPage);
    const [firstTabId] = await terminalTabIds(firstPage);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(firstPage);
    const [, secondTabId] = await terminalTabIds(firstPage);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await renameTerminalTab(firstPage, terminalTabById(firstPage, firstTabId), 'process first');
    // The default label pins ordinal persistence on POSIX. ConPTY can replace
    // default labels with OSC titles, so Windows needs a durable custom label.
    const secondLabel = process.platform === 'win32' ? 'process second' : 'Terminal 2';
    if (process.platform === 'win32') {
      await renameTerminalTab(firstPage, terminalTabById(firstPage, secondTabId), secondLabel);
    }
    await terminalTabById(firstPage, secondTabId).click();
    await expect(terminalTabById(firstPage, secondTabId)).toHaveAttribute('aria-selected', 'true');
    // This test owns process-restart persistence; the dedicated terminal-tabs
    // smoke owns pointer-drag behavior. Reordering in the bottom dock keeps
    // this setup independent of right-column overlay geometry.
    await firstPage.locator('section[aria-label="Terminal"]:visible .xterm').click();
    await firstPage.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowLeft`);
    await expectTerminalTabOrder(firstPage, [secondTabId, firstTabId]);
    await expect(terminalTabById(firstPage, secondTabId)).toHaveAttribute('aria-selected', 'true');
    await dispatchRendererMenuAction(firstPage, 'move-terminal');
    await expect(firstPage.locator('#terminal-column')).toBeVisible({ timeout: 10_000 });
    await expect(terminalTabs(firstPage)).toHaveText([secondLabel, 'process first']);
    await expect(firstPage.getByRole('tab', { name: secondLabel })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Pointer-drag behavior has its own live smoke. Here a deterministic
    // persisted width isolates the cross-process contract this test owns.
    const retainedWidth = await applyPersistedRightTerminalWidth(firstPage, 860);
    await expect(terminalTabs(firstPage)).toHaveText([secondLabel, 'process first']);
    await expect(firstPage.getByRole('tab', { name: secondLabel })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await quitAndWait(firstApp, firstProcess);

    const secondApp = await launchRestartProfile(seed);
    captureStderrFor(secondApp, { cleanupDirs: [seed.tmpHome, seed.projectDir] });
    const secondPage = await findEditorWindow(secondApp);
    await setWindowSize(secondApp, secondPage, 1900, 900);
    await expect(secondPage.locator('#terminal-column')).toBeVisible({ timeout: 25_000 });
    await expect(secondPage.locator('#terminal-dock-panel')).toHaveCount(0);
    await expect(terminalTabs(secondPage)).toHaveText([secondLabel, 'process first'], {
      timeout: 25_000,
    });
    await expect(secondPage.getByRole('tab', { name: secondLabel })).toHaveAttribute(
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
