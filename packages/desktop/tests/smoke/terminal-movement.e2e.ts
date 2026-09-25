import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, ElementHandle, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { waitForWindowByMode } from './_helpers/launch-readiness';
import { sumOfDeclaredBoundsMs } from './_helpers/parse-timeouts';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expectCollapsedRailColumn, readRailColumnWidth } from './_helpers/rail-column';
import {
  expectSettledReading,
  RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  type SettleBudget,
  settleBudget,
} from './_helpers/settled-reading';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';
import {
  numberedScrollLine,
  readScrollbackUpward,
  type ScrollbackExpectation,
} from './_helpers/terminal-scrollback';
import {
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
} from './_helpers/terminal-smoke-shell';
import {
  expectTerminalTabOrder,
  openBareTerminalTab,
  renameTerminalTab,
  terminalTabById,
  terminalTabIds,
  terminalTabs,
} from './_helpers/terminal-tabs.test-helper';
import { expectNoticeFromTrigger, transientNoticeObservation } from './_helpers/transient-notice';

const TARGET = resolveDesktopTarget();
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHELL_COMMANDS = terminalSmokeShellCommands();
const SCROLLBACK_PAGE_LIMIT = 40;
const SCROLL_SETTLE_FRAME_LIMIT = 60;

type TerminalHome = 'bottom' | 'right';

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function seed({ skipRestoreState = false }: { skipRestoreState?: boolean } = {}): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-terminal-movement-home-')));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-terminal-movement-project-')));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nTerminal movement smoke.\n');
  seedTerminalShellProfiles(tmpHome, { posixRestrictPath: true });

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  if (!skipRestoreState) {
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          {
            path: projectDir,
            name: 'Terminal Movement Smoke',
            lastOpenedAt: new Date().toISOString(),
          },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );
  }

  return { tmpHome, userDataDir, projectDir };
}

async function launchApp(s: Seed): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${s.userDataDir}`, deepLink],
      timeout: 30_000,
      env: {
        ...process.env,
        ...terminalSmokeEnvironment(s.tmpHome, {
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

async function dispatchRendererMenuAction(
  action: 'move-terminal' | 'toggle-agent-panel' | 'toggle-terminal',
  editorPage: Page,
): Promise<void> {
  await editorPage.evaluate(async (menuAction) => {
    const menu = window.okDesktop?.menu;
    if (!menu) throw new Error('renderer menu bridge is unavailable');
    await menu.dispatch({ kind: 'menu-action', action: menuAction });
  }, action);
}

async function clickViewTerminalItem(app: ElectronApplication, editorPage: Page): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction('toggle-terminal', editorPage);
    return;
  }
  await app.evaluate(async ({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    const terminal = view?.submenu?.items.find(
      (item) => item.label === 'Show Terminal' || item.label === 'Hide Terminal',
    );
    if (!terminal) throw new Error('View menu is missing the required Terminal visibility item');
    terminal.click();
  });
}

async function clickViewAgentsItem(app: ElectronApplication, editorPage: Page): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction('toggle-agent-panel', editorPage);
    return;
  }
  await app.evaluate(async ({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    const item = view?.submenu?.items.find(
      (candidate) => candidate.label === 'Show Agents' || candidate.label === 'Hide Agents',
    );
    if (!item) throw new Error('View menu is missing the required Agents visibility item');
    item.click();
  });
}

async function clickTerminalPlacementItem(
  app: ElectronApplication,
  editorPage: Page,
): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction('move-terminal', editorPage);
    return;
  }
  await app.evaluate(async ({ Menu }) => {
    const terminal = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Terminal');
    const placement = terminal?.submenu?.items.find(
      (item) => item.label === 'Move Terminal to right' || item.label === 'Move Terminal to bottom',
    );
    if (!placement) throw new Error('Terminal menu is missing the required placement item');
    placement.click();
  });
}

async function clickTerminalPlacementItemRapidly(
  app: ElectronApplication,
  count: number,
  editorPage: Page,
): Promise<void> {
  if (process.platform !== 'darwin') {
    for (let index = 0; index < count; index += 1) {
      await dispatchRendererMenuAction('move-terminal', editorPage);
    }
    return;
  }
  await app.evaluate(async ({ Menu }, clickCount) => {
    const terminal = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Terminal');
    const placement = terminal?.submenu?.items.find(
      (item) => item.label === 'Move Terminal to right' || item.label === 'Move Terminal to bottom',
    );
    if (!placement) throw new Error('Terminal menu is missing the required placement item');
    for (let index = 0; index < clickCount; index += 1) placement.click();
  }, count);
}

const visibleTerminal = (page: Page) => page.locator('section[aria-label="Terminal"]:visible');

async function widenEditorWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const editorWindow = await app.browserWindow(page);
  await editorWindow.evaluate(
    (windowHandle: unknown, size) => {
      (windowHandle as { setSize: (w: number, h: number, animate: boolean) => void }).setSize(
        size.width,
        size.height,
        false,
      );
    },
    { width, height },
  );

  let settled = 0;
  let previous = Number.NaN;
  await expect(async () => {
    const inner = await page.evaluate(() => window.innerWidth);
    settled = inner === previous ? settled + 1 : 0;
    previous = inner;
    expect(settled).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 10_000, intervals: [100] });

  if (previous < width - 100) {
    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
    if (workArea.width < width) {
      test.skip(
        true,
        `Window settled at ${previous}px after asking for ${width}px. The primary display's work area is ${workArea.width}x${workArea.height} and cannot hold it, and this test asserts a layout the app only owes at ${width}px.`,
      );
    }
    throw new Error(
      `Window settled at ${previous}px after asking for ${width}px, on a display whose work area is ${workArea.width}x${workArea.height} and could have held it. That is a window-sizing bug, not a display limit.`,
    );
  }
}

async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  const terminal = visibleTerminal(page);
  await expect(async () => {
    if (await terminal.isVisible()) return;
    await clickViewTerminalItem(app, page);
    await expect(terminal).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 15_000 });
  await expect(terminal.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
  await waitForShellReady(
    () => readActiveTerminal(page),
    (command) => typeInActiveTerminal(page, `${command}\r`),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

async function openBareTab(page: Page): Promise<void> {
  await openBareTerminalTab(page, async () => {
    await expect(visibleTerminal(page).locator('[data-terminal-status]')).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 25_000 },
    );
    await waitForShellReady(
      () => readActiveTerminal(page),
      (command) => typeInActiveTerminal(page, `${command}\r`),
      { resetTerminalInput: () => page.keyboard.press('Control+C') },
    );
  });
}

async function typeInActiveTerminal(page: Page, text: string): Promise<void> {
  await visibleTerminal(page).locator('.xterm').click();
  await page.keyboard.type(text);
}

function readTerminalRows(page: Page): Promise<string> {
  return visibleTerminal(page).evaluate(
    (section) => section.querySelector('.xterm-rows')?.textContent ?? '',
  );
}

async function readActiveTerminal(page: Page): Promise<string> {
  return visibleTerminal(page).evaluate((section) => {
    const accessibility = section.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = section.querySelector('.xterm-rows')?.textContent ?? '';
    return `${accessibility}\n${rows}`;
  });
}

async function expectScrollbackRetains(
  page: Page,
  expectation: ScrollbackExpectation,
): Promise<void> {
  await visibleTerminal(page).locator('.xterm-helper-textarea').focus();
  const verdict = await readScrollbackUpward(
    {
      readSettledView: () => settleScrollPosition(page),
      pageUpFrom: async (settledView) => {
        await page.keyboard.press('Shift+PageUp');
        return settleScrollPosition(page, settledView);
      },
      pageDownFrom: async (settledView) => {
        await page.keyboard.press('Shift+PageDown');
        return settleScrollPosition(page, settledView);
      },
    },
    expectation,
    SCROLLBACK_PAGE_LIMIT,
  );
  expect(verdict, 'terminal scrollback no longer holds every line the shell printed').toEqual({
    kind: 'complete',
  });
}

async function settleScrollPosition(page: Page, departFrom?: string): Promise<string> {
  let previous = '';
  let stable = 0;
  let departed = departFrom === undefined;
  for (let step = 0; step < SCROLL_SETTLE_FRAME_LIMIT && !(departed && stable >= 2); step += 1) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const current = await readTerminalRows(page);
    departed ||= current !== departFrom;
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
  return previous;
}

function waitForTerminalHome(page: Page, home: TerminalHome): Promise<void> {
  return page.evaluate((targetHome) => {
    return new Promise<void>((resolve, reject) => {
      const activeSelector =
        targetHome === 'right'
          ? '#terminal-column section[aria-label="Terminal"]'
          : '#terminal-dock-panel section[aria-label="Terminal"]';
      const inactiveSelector =
        targetHome === 'right'
          ? '#terminal-dock-panel section[aria-label="Terminal"]'
          : '#terminal-column section[aria-label="Terminal"]';
      let frame = 0;
      const timeout = window.setTimeout(() => {
        window.cancelAnimationFrame(frame);
        reject(new Error(`Terminal did not settle at ${targetHome}`));
      }, 5_000);

      const inspect = () => {
        const active = [...document.querySelectorAll(activeSelector)].find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const inactive = document.querySelector(inactiveSelector);
        const text = active?.querySelector('.xterm-rows')?.textContent ?? '';
        const rect = active?.getBoundingClientRect();
        if (active && !inactive && rect && rect.width > 0 && rect.height > 0 && text.length > 0) {
          window.clearTimeout(timeout);
          resolve();
          return;
        }
        frame = window.requestAnimationFrame(inspect);
      };

      frame = window.requestAnimationFrame(inspect);
    });
  }, home);
}

async function moveTerminal(
  app: ElectronApplication,
  page: Page,
  home: TerminalHome,
): Promise<void> {
  const settlement = waitForTerminalHome(page, home);
  await clickTerminalPlacementItem(app, page);
  await settlement;
}

async function captureLiveTerminal(page: Page): Promise<ElementHandle<Element>> {
  const handle = await visibleTerminal(page).locator('.xterm').elementHandle();
  if (!handle) throw new Error('no visible Terminal surface to follow across the move');
  return handle;
}

async function expectTerminalMovedNotRebuilt(
  surface: ElementHandle<Element>,
  home: TerminalHome,
): Promise<void> {
  const containerId = home === 'right' ? 'terminal-column' : 'terminal-dock-panel';
  const placement = await surface.evaluate(
    (element, id) => ({
      connected: element.isConnected,
      atHome: element.closest(`#${id}`) !== null,
    }),
    containerId,
  );
  expect(placement, `the live terminal surface did not survive the move to ${home}`).toEqual({
    connected: true,
    atHome: true,
  });
}

interface MenuActionTally {
  count: number;
  stop: () => void;
}

function tallyMenuActionDeliveries(
  page: Page,
  action: 'move-terminal',
): Promise<JSHandle<MenuActionTally>> {
  return page.evaluateHandle((counted) => {
    const bridge = window.okDesktop;
    if (!bridge) throw new Error('renderer desktop bridge is unavailable');
    const tally: MenuActionTally = { count: 0, stop: () => {} };
    tally.stop = bridge.onMenuAction((delivered) => {
      if (delivered === counted) tally.count += 1;
    });
    return tally;
  }, action);
}

function readBurstOutcome(
  surface: ElementHandle<Element>,
  deliveries: JSHandle<MenuActionTally>,
  home: TerminalHome,
) {
  return surface.evaluate(
    (element, { tally, containerId }) => ({
      delivered: tally.count,
      connected: element.isConnected,
      atHome: element.closest(`#${containerId}`) !== null,
    }),
    {
      tally: deliveries,
      containerId: home === 'right' ? 'terminal-column' : 'terminal-dock-panel',
    },
  );
}

async function readShellPid(page: Page, marker: string): Promise<number> {
  await typeInActiveTerminal(page, `${SHELL_COMMANDS.processId(marker)}\r`);
  let processId = 0;
  await expect
    .poll(
      async () => {
        const rows = await readTerminalRows(page);
        const matches = [...rows.matchAll(new RegExp(`${marker}=(\\d+)`, 'g'))];
        processId = Number(matches.at(-1)?.[1] ?? 0);
        return processId;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return processId;
}

async function growRightTerminal(
  page: Page,
  deltaPx: number,
): Promise<{ width: number; settle: SettleBudget }> {
  const column = page.locator('#terminal-column');
  const before = await column.evaluate((element) => element.getBoundingClientRect().width);
  const handle = await column.evaluate((element) => {
    const rect = element.previousElementSibling?.getBoundingClientRect();
    return rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!handle) throw new Error('right Terminal resize handle is unavailable');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - deltaPx, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  const settle = settleBudget('right Terminal resize and its persisted layout', {
    timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  });
  await expectSettledReading(
    () => readRailColumnWidth(page, '#terminal-column'),
    (width) => expect(width).toBeGreaterThan(before + deltaPx / 2),
    { reading: 'width', of: '#terminal-column', budget: settle },
  );
  const width = await column.evaluate((element) => element.getBoundingClientRect().width);
  return { width, settle };
}

async function expectStillScrolledBack(page: Page, newestLine: string): Promise<void> {
  expect(
    await readTerminalRows(page),
    'the move left a scrolled-back reader at the bottom of the buffer',
  ).not.toContain(newestLine);
}

test.describe('Terminal placement continuity — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('moving a populated terminal preserves every live session', async ({ captureStderrFor }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);

    await openTerminal(app, page);
    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');

    const token = randomUUID().replaceAll('-', '');
    const processMarker = `PROCESS_${token}`;
    const sentinel = `SENTINEL_${token}`;
    const scrollStart = `SCROLL_START_${token}`;
    const scrollback: ScrollbackExpectation = {
      markers: [sentinel, scrollStart],
      linePrefix: `SCROLL_${token}_`,
      lineCount: 120,
    };
    const newestScrollLine = numberedScrollLine(scrollback.linePrefix, scrollback.lineCount);
    const processId = await readShellPid(page, processMarker);
    await typeInActiveTerminal(
      page,
      `${SHELL_COMMANDS.scroll(sentinel, scrollStart, scrollback.linePrefix, scrollback.lineCount)}\r`,
    );
    await expect
      .poll(() => readActiveTerminal(page), { timeout: 15_000 })
      .toContain(newestScrollLine);
    await expectScrollbackRetains(page, scrollback);

    const liveSurface = await captureLiveTerminal(page);
    await moveTerminal(app, page, 'right');
    await expectTerminalMovedNotRebuilt(liveSurface, 'right');
    await expectStillScrolledBack(page, newestScrollLine);
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    await expectScrollbackRetains(page, scrollback);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rightOutput = `RIGHT_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(rightOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rightOutput);

    await expectScrollbackRetains(page, scrollback);
    await moveTerminal(app, page, 'bottom');
    await expectTerminalMovedNotRebuilt(liveSurface, 'bottom');
    await expectStillScrolledBack(page, newestScrollLine);
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    await expectScrollbackRetains(page, scrollback);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const bottomOutput = `BOTTOM_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(bottomOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(bottomOutput);

    const rapidToggles = 7;
    const rapidDeliveries = await tallyMenuActionDeliveries(page, 'move-terminal');
    await clickTerminalPlacementItemRapidly(app, rapidToggles, page);
    await expect
      .poll(() => readBurstOutcome(liveSurface, rapidDeliveries, 'right'), {
        message: 'the rapid placement burst never settled at its final placement',
      })
      .toEqual({ delivered: rapidToggles, connected: true, atHome: true });
    await rapidDeliveries.evaluate((tally) => tally.stop());
    await rapidDeliveries.dispose();
    await expectTerminalMovedNotRebuilt(liveSurface, 'right');
    await expect(page.locator('section[aria-label="Terminal"]')).toHaveCount(2);
    await expect(visibleTerminal(page)).toHaveCount(1);
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toHaveCount(2);
    await expect(page.locator('#terminal-dock-panel section[aria-label="Terminal"]')).toHaveCount(
      0,
    );
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rapidOutput = `RAPID_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(rapidOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rapidOutput);
    await expectScrollbackRetains(page, scrollback);
  });

  test('renderer restart restores the right layout and its live active terminal', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed({ skipRestoreState: true });
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);

    await openTerminal(app, page);
    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await renameTerminalTab(page, terminalTabById(page, firstTabId), 'restart first');
    const secondLabel = process.platform === 'win32' ? 'restart second' : 'Terminal 2';
    if (process.platform === 'win32') {
      await renameTerminalTab(page, terminalTabById(page, secondTabId), secondLabel);
    }
    await terminalTabById(page, secondTabId).click();
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    const token = randomUUID().replaceAll('-', '');
    const processMarker = `RESTART_PROCESS_${token}`;
    const processId = await readShellPid(page, processMarker);
    const beforeRestart = `BEFORE_RESTART_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(beforeRestart)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(beforeRestart);

    await visibleTerminal(page).locator('.xterm').click();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowLeft`);
    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    await moveTerminal(app, page, 'right');
    const { width: restoredWidth, settle: railResize } = await growRightTerminal(page, 120);

    await expectSettledReading(
      () => page.evaluate(() => localStorage.getItem('ok-terminal-placement-v1')),
      (placement) => expect(placement).toBe('right'),
      { reading: 'placement', of: 'localStorage ok-terminal-placement-v1', budget: railResize },
    );
    await expectSettledReading(
      () => page.evaluate(() => Number(localStorage.getItem('ok-terminal-right-width-v1'))),
      (retainedWidth) => expect(Math.abs(retainedWidth - restoredWidth)).toBeLessThan(20),
      { reading: 'width', of: 'localStorage ok-terminal-right-width-v1', budget: railResize },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('#terminal-column')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#terminal-dock-panel')).toHaveCount(0);
    await expect(terminalTabs(page)).toHaveText([secondLabel, 'restart first'], {
      timeout: 25_000,
    });
    const restoredTail = settleBudget('restored active tab and right Terminal width', {
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByRole('tab', { name: secondLabel })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: restoredTail.remainingMs() },
    );
    await expectSettledReading(
      () => readRailColumnWidth(page, '#terminal-column'),
      (width) => expect(Math.abs(width - restoredWidth)).toBeLessThan(20),
      { reading: 'width', of: '#terminal-column', budget: restoredTail },
    );
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const afterRestart = `AFTER_RESTART_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(afterRestart)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(afterRestart);

    await clickViewAgentsItem(app, page);
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    const editorWindow = await app.browserWindow(page);
    await editorWindow.evaluate((windowHandle: unknown) => {
      const target = windowHandle as {
        setSize: (width: number, height: number, animate: boolean) => void;
      };
      target.setSize(900, 900, false);
    });
    const shrink = settleBudget('rail admission after the window narrows to 900 px', {
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expectSettledReading(
      () => page.evaluate(() => window.innerWidth),
      (width) => expect(width).toBeLessThan(1000),
      { reading: 'innerWidth', of: 'the editor window', budget: shrink },
    );
    await expectCollapsedRailColumn(page, '#agents-column', { budget: shrink });
    await page.evaluate(() => {
      window.okDesktop?.editor.notifyViewMenuStateChanged({ agentPanelVisible: true });
    });
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            window.okDesktop?.terminal?.getDockState()?.then((state) => state.agentPanelVisible),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expectNoticeFromTrigger(
      'Agent panel closed to keep Terminal readable.',
      transientNoticeObservation(page, {
        document: 'next',
        trigger: async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
        },
      }),
      { timeout: 20_000 },
    );
    await expect(page.locator('#terminal-column')).toBeVisible({ timeout: 10_000 });
    await expectCollapsedRailColumn(page, '#agents-column');
    await editorWindow.evaluate((windowHandle: unknown) => {
      const target = windowHandle as {
        setSize: (width: number, height: number, animate: boolean) => void;
      };
      target.setSize(1900, 900, false);
    });
    await expect(visibleTerminal(page).locator('.xterm')).toBeVisible({ timeout: 10_000 });
    expect(await readShellPid(page, processMarker)).toBe(processId);
  });

  test('fresh and malformed layout state recover to a usable bottom terminal', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await openTerminal(app, page);
    await expect(page.locator('#terminal-dock-panel')).toBeVisible();
    await expectCollapsedRailColumn(page, '#terminal-column');
    const token = randomUUID().replaceAll('-', '');
    const processMarker = `MALFORMED_PROCESS_${token}`;
    const processId = await readShellPid(page, processMarker);

    await page.evaluate(() => {
      localStorage.setItem('ok-terminal-placement-v1', 'future-home');
      localStorage.setItem('ok-terminal-right-width-v1', 'not-a-width');
      localStorage.setItem('ok-terminal-width-v1', 'agents-width-sentinel');
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#terminal-dock-panel')).toBeVisible({ timeout: 20_000 });
    await expectCollapsedRailColumn(page, '#terminal-column');
    expect(
      await page.evaluate(() => ({
        placement: localStorage.getItem('ok-terminal-placement-v1'),
        rightWidth: localStorage.getItem('ok-terminal-right-width-v1'),
        agentsWidth: localStorage.getItem('ok-terminal-width-v1'),
      })),
    ).toEqual({
      placement: 'bottom',
      rightWidth: '740',
      agentsWidth: 'agents-width-sentinel',
    });
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const output = `AFTER_MALFORMED_RESTART_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(output)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(output);
  });
});
