import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
import {
  type CrashDumpVerdict,
  type CrashDumpWatch,
  collectCrashDumps,
  failIfEarlierAttemptFoundCrashDump,
  observeQuit,
  runningAppProcesses,
  watchCrashDumps,
} from './_helpers/crash-dumps';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { waitForWindowByMode } from './_helpers/launch-readiness';
import { sumOfDeclaredBoundsMs } from './_helpers/parse-timeouts';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { readRailColumnWidth } from './_helpers/rail-column';
import {
  expectSettledReading,
  pollSettledReading,
  RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  settleBudget,
} from './_helpers/settled-reading';
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
const QUIT_SAMPLES = process.platform === 'win32' ? 50 : 1;
const SECOND_TAB_LABEL = process.platform === 'win32' ? 'process second' : 'Terminal 2';

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
  seedTerminalShellProfiles(tmpHome, { posixRestrictPath: true });
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
  return waitForWindowByMode(app, 'editor');
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
  await pollSettledReading(() => page.evaluate(() => window.innerWidth), {
    reading: 'viewport width',
    of: 'editor window',
    timeout: 10_000 satisfies typeof RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  }).toBeGreaterThanOrEqual(width - 100);
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

async function expectArrangedTabs(page: Page): Promise<void> {
  await expect(terminalTabs(page)).toHaveText([SECOND_TAB_LABEL, 'process first']);
  await expect(page.getByRole('tab', { name: SECOND_TAB_LABEL })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

async function arrangeTabsInRightColumn(
  page: Page,
  firstTabId: string,
  secondTabId: string,
): Promise<void> {
  await renameTerminalTab(page, terminalTabById(page, firstTabId), 'process first');
  if (process.platform === 'win32') {
    await renameTerminalTab(page, terminalTabById(page, secondTabId), SECOND_TAB_LABEL);
  }
  await terminalTabById(page, secondTabId).click();
  await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
  await page.locator('section[aria-label="Terminal"]:visible .xterm').click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowLeft`);
  await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
  await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
  await dispatchRendererMenuAction(page, 'move-terminal');
  await expect(page.locator('#terminal-column')).toBeVisible({ timeout: 10_000 });
  await expectArrangedTabs(page);
}

async function applyPersistedRightTerminalWidth(page: Page, width: number): Promise<number> {
  await page.evaluate((nextWidth) => {
    localStorage.setItem('ok-terminal-right-width-v1', String(nextWidth));
  }, width);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restore = settleBudget('restored right Terminal width', { timeout: 20_000 });
  const column = page.locator('#terminal-column');
  await expect(column).toBeVisible({ timeout: restore.remainingMs() });
  await expectSettledReading(
    () => readRailColumnWidth(page, '#terminal-column'),
    (renderedWidth) => expect(Math.abs(renderedWidth - width)).toBeLessThan(20),
    { reading: 'width', of: '#terminal-column', budget: restore },
  );
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

async function quitAndCollectCrashDumps(
  app: ElectronApplication,
  child: ChildProcess,
  dumps: CrashDumpWatch,
): Promise<CrashDumpVerdict> {
  const quit = await observeQuit(app);
  await quitAndWait(app, child);
  await expect
    .configure({ soft: true })
    .poll(() => runningAppProcesses(quit.processes), {
      message:
        'every process the app ran before quit has exited, so the crash-dump scan is complete',
      timeout: 15_000,
    })
    .toEqual([]);
  return collectCrashDumps(dumps, quit, test.info());
}

test.describe('terminal process restart', () => {
  test.skip(!ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('restores placement, width, tab order, and active tab in a separate Electron process', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    failIfEarlierAttemptFoundCrashDump(test.info());
    const seed = seedRestartProfile();
    const firstApp = await launchRestartProfile(seed);
    captureStderrFor(firstApp, { home: seed.tmpHome });
    const firstProcess = firstApp.process();
    const firstDumps = await watchCrashDumps(firstApp);
    const firstPage = await findEditorWindow(firstApp);
    await configureDesktopGitRepositories(firstPage, seed.projectDir);
    await setWindowSize(firstApp, firstPage, 1900, 900);
    await openTerminal(firstPage);
    const [firstTabId] = await terminalTabIds(firstPage);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(firstPage);
    const [, secondTabId] = await terminalTabIds(firstPage);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await arrangeTabsInRightColumn(firstPage, firstTabId, secondTabId);
    const retainedWidth = await applyPersistedRightTerminalWidth(firstPage, 860);
    await expectArrangedTabs(firstPage);
    const firstQuitDumps = await quitAndCollectCrashDumps(firstApp, firstProcess, firstDumps);
    expect.soft(firstQuitDumps.lines, firstQuitDumps.headline).toEqual([]);

    const secondApp = await launchRestartProfile(seed);
    captureStderrFor(secondApp, {
      home: seed.tmpHome,
      cleanupDirs: [seed.tmpHome, seed.projectDir],
    });
    const secondPage = await findEditorWindow(secondApp);
    await setWindowSize(secondApp, secondPage, 1900, 900);
    await expect(secondPage.locator('#terminal-column')).toBeVisible({ timeout: 25_000 });
    await expect(secondPage.locator('#terminal-dock-panel')).toHaveCount(0);
    await expect(terminalTabs(secondPage)).toHaveText([SECOND_TAB_LABEL, 'process first'], {
      timeout: 25_000,
    });
    const restoredTail = settleBudget('restored active tab and right Terminal width', {
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expect(secondPage.getByRole('tab', { name: SECOND_TAB_LABEL })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: restoredTail.remainingMs() },
    );
    await expectSettledReading(
      () => readRailColumnWidth(secondPage, '#terminal-column'),
      (width) => expect(Math.abs(width - retainedWidth)).toBeLessThan(20),
      { reading: 'width', of: '#terminal-column', budget: restoredTail },
    );
  });

  for (let sample = 1; sample <= QUIT_SAMPLES; sample += 1) {
    test(`clean quit ${sample} of ${QUIT_SAMPLES} with two live terminals leaves no crash dump for the next launch`, async ({
      captureStderrFor,
    }) => {
      test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
      failIfEarlierAttemptFoundCrashDump(test.info());
      const seed = seedRestartProfile();
      const app = await launchRestartProfile(seed);
      captureStderrFor(app, { home: seed.tmpHome, cleanupDirs: [seed.tmpHome, seed.projectDir] });
      const appProcess = app.process();
      const dumps = await watchCrashDumps(app);
      // WARN: mirrors the first process of the restart test above
      const page = await findEditorWindow(app);
      await configureDesktopGitRepositories(page, seed.projectDir);
      await setWindowSize(app, page, 1900, 900);
      await openTerminal(page);
      const [firstTabId] = await terminalTabIds(page);
      if (firstTabId === undefined) throw new Error('first terminal tab was not created');
      await openBareTab(page);
      const [, secondTabId] = await terminalTabIds(page);
      if (secondTabId === undefined) throw new Error('second terminal tab was not created');
      await arrangeTabsInRightColumn(page, firstTabId, secondTabId);
      await applyPersistedRightTerminalWidth(page, 860);
      await expectArrangedTabs(page);
      const quit = await quitAndCollectCrashDumps(app, appProcess, dumps);
      expect(quit.lines, quit.headline).toEqual([]);
    });
  }
});
