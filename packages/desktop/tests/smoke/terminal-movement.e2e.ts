import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, ElementHandle, JSHandle, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
import {
  dockUnitWidth,
  expectStoredDockArrangementChanged,
  readTerminalHome,
  storedDockArrangement,
  TERMINAL_CARD,
  type TerminalHome,
  terminalHomeProbe,
} from './_helpers/dock-workspace';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { waitForWindowByMode } from './_helpers/launch-readiness';
import { sumOfDeclaredBoundsMs } from './_helpers/parse-timeouts';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import {
  expectSettledReading,
  LAYOUT_SETTLE_TIMEOUT_MS,
  type SettleBudget,
  settleBudget,
} from './_helpers/settled-reading';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady, waitForTerminalOutput } from './_helpers/terminal-ready';
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

const TARGET = resolveDesktopTarget();
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHELL_COMMANDS = terminalSmokeShellCommands();
const SCROLLBACK_PAGE_LIMIT = 40;
const SCROLL_SETTLE_FRAME_LIMIT = 60;
const TERMINAL_UNIT = '#dock-unit-terminal';
const AGENTS_UNIT = '#dock-unit-agents';

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

async function moveTerminal(
  app: ElectronApplication,
  page: Page,
  home: TerminalHome,
): Promise<void> {
  const settlement = page
    .waitForFunction(terminalHomeProbe, home, { polling: 'raf', timeout: 5_000 })
    .then(
      () => null,
      (error: unknown) => error,
    );
  await clickTerminalPlacementItem(app, page);
  const failure = await settlement;
  if (failure !== null) {
    throw new Error(
      `the terminal did not settle at ${home}; it last read ${JSON.stringify(await readTerminalHome(page))}`,
      { cause: failure },
    );
  }
}

async function captureLiveTerminal(page: Page): Promise<ElementHandle<Element>> {
  const handle = await visibleTerminal(page).locator('.xterm').elementHandle();
  if (!handle) throw new Error('no visible Terminal surface to follow across the move');
  return handle;
}

async function captureTerminalMount(page: Page): Promise<ElementHandle<Element>> {
  const handle = await page.locator('[data-terminal-panel-mount]').elementHandle();
  if (!handle) throw new Error('no terminal mount to follow across the move');
  return handle;
}

async function expectTerminalMovedNotRebuilt(
  surface: ElementHandle<Element>,
  mount: ElementHandle<Element>,
  home: TerminalHome,
): Promise<void> {
  const placement = await surface.evaluate(
    (element, { terminalMount, card }) => ({
      connected: element.isConnected,
      inMount: terminalMount.isConnected && terminalMount.contains(element),
      placement: element.closest(card)?.getAttribute('data-placement') ?? null,
    }),
    { terminalMount: mount, card: TERMINAL_CARD },
  );
  expect(placement, `the live terminal surface did not survive the move to ${home}`).toEqual({
    connected: true,
    inMount: true,
    placement: home,
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
  mount: ElementHandle<Element>,
  deliveries: JSHandle<MenuActionTally>,
) {
  return surface.evaluate(
    (element, { tally, terminalMount, card }) => ({
      delivered: tally.count,
      connected: element.isConnected,
      inMount: terminalMount.isConnected && terminalMount.contains(element),
      placement: element.closest(card)?.getAttribute('data-placement') ?? null,
    }),
    { tally: deliveries, terminalMount: mount, card: TERMINAL_CARD },
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
  const before = await dockUnitWidth(page, 'terminal');
  const seam = await page
    .getByRole('separator', { name: 'Resize Terminal', exact: true })
    .boundingBox({ timeout: 10_000 });
  if (!seam) throw new Error('the right Terminal seam has no box to drag');
  const x = seam.x + seam.width / 2;
  const y = seam.y + seam.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - deltaPx, y, { steps: 12 });
  await page.mouse.up();
  const settle = settleBudget('right Terminal resize and its persisted arrangement', {
    timeout: LAYOUT_SETTLE_TIMEOUT_MS,
  });
  await expectSettledReading(
    () => dockUnitWidth(page, 'terminal'),
    (width) => expect(Math.abs(width - before - deltaPx)).toBeLessThanOrEqual(deltaPx / 4),
    { reading: 'width', of: TERMINAL_UNIT, budget: settle },
  );
  return { width: await dockUnitWidth(page, 'terminal'), settle };
}

async function expectHeaderPanesOn(page: Page): Promise<void> {
  for (const pane of ['Agents', 'Terminal']) {
    await expect(
      page.locator('header[data-app-header]').getByRole('button', { name: pane, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  }
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
    await configureDesktopGitRepositories(page, s.projectDir);
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
    await waitForTerminalOutput(() => readActiveTerminal(page), newestScrollLine, {
      stallMs: 15_000,
    });
    await expectScrollbackRetains(page, scrollback);

    const liveSurface = await captureLiveTerminal(page);
    const liveMount = await captureTerminalMount(page);
    await moveTerminal(app, page, 'right');
    await expectTerminalMovedNotRebuilt(liveSurface, liveMount, 'right');
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
    await expectTerminalMovedNotRebuilt(liveSurface, liveMount, 'bottom');
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
      .poll(() => readBurstOutcome(liveSurface, liveMount, rapidDeliveries), {
        message: 'the rapid placement burst never settled at its final placement',
      })
      .toEqual({ delivered: rapidToggles, connected: true, inMount: true, placement: 'right' });
    await rapidDeliveries.evaluate((tally) => tally.stop());
    await rapidDeliveries.dispose();
    await expectTerminalMovedNotRebuilt(liveSurface, liveMount, 'right');
    await expect
      .poll(() => readTerminalHome(page), { timeout: 5_000 })
      .toEqual({ placement: 'right', geometry: 'right', painted: true });
    await expect(page.locator('[data-terminal-panel-mount]')).toHaveCount(1);
    await expect(page.locator('section[aria-label="Terminal"]')).toHaveCount(2);
    await expect(visibleTerminal(page)).toHaveCount(1);
    await expect(
      page.locator(`${TERMINAL_CARD} [data-terminal-panel-mount] section[aria-label="Terminal"]`),
    ).toHaveCount(2);
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rapidOutput = `RAPID_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(rapidOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rapidOutput);
    await expectScrollbackRetains(page, scrollback);
  });

  test('dragging the right Terminal seam narrows the document and keeps the side panel width', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.location.hash = '#/start';
    });
    await expect(
      page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)').first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true', {
      timeout: 10_000,
    });

    await openTerminal(app, page);
    await moveTerminal(app, page, 'right');

    const sidePanel = page.locator('#doc-panel');
    const documentColumn = page.locator('[data-editor-workspace-column]');
    const editorCard = page.locator('[data-slot="pane-card"][data-pane="editor"]');
    await expect(editorCard.locator('#doc-panel')).toHaveCount(1);
    await expect
      .poll(() => sidePanel.evaluate((element) => element.getBoundingClientRect().width), {
        timeout: LAYOUT_SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(300);
    const sidePanelBefore = await sidePanel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    const columnBefore = await documentColumn.evaluate(
      (element) => element.getBoundingClientRect().width,
    );

    const deltaPx = 150;
    const { settle } = await growRightTerminal(page, deltaPx);

    await expectSettledReading(
      async () => ({
        sidePanel: await sidePanel.evaluate((element) => element.getBoundingClientRect().width),
        documentColumn: await documentColumn.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      }),
      (widths) => {
        expect(
          Math.abs(widths.sidePanel - sidePanelBefore),
          'the side panel keeps its width while the right Terminal seam is dragged',
        ).toBeLessThanOrEqual(1);
        expect(widths.documentColumn, 'the document column gives up the width').toBeLessThan(
          columnBefore - deltaPx / 2,
        );
      },
      { reading: 'side panel and document column widths', of: 'the editor card', budget: settle },
    );
  });

  test('renderer restart restores the right layout and its live active terminal', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed({ skipRestoreState: true });
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.projectDir);
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
    const movedArrangement = await storedDockArrangement(page, { timeout: 10_000 });
    const { width: restoredWidth, settle: rightResize } = await growRightTerminal(page, 120);
    await expectStoredDockArrangementChanged(page, movedArrangement, rightResize);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(terminalTabs(page)).toHaveText([secondLabel, 'restart first'], {
      timeout: 25_000,
    });
    const restoredTail = settleBudget('restored active tab and right Terminal width', {
      timeout: LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByRole('tab', { name: secondLabel })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: restoredTail.remainingMs() },
    );
    await expectSettledReading(
      () => readTerminalHome(page),
      (home) => expect(home).toEqual({ placement: 'right', geometry: 'right', painted: true }),
      { reading: 'terminal home', of: 'the restored editor window', budget: restoredTail },
    );
    await expectSettledReading(
      () => dockUnitWidth(page, 'terminal'),
      (width) => expect(Math.abs(width - restoredWidth)).toBeLessThan(20),
      { reading: 'width', of: TERMINAL_UNIT, budget: restoredTail },
    );
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const afterRestart = `AFTER_RESTART_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(afterRestart)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(afterRestart);

    await clickViewAgentsItem(app, page);
    await expect(page.locator(AGENTS_UNIT)).toBeVisible({ timeout: 10_000 });
    const editorWindow = await app.browserWindow(page);
    await editorWindow.evaluate((windowHandle: unknown) => {
      const target = windowHandle as {
        setSize: (width: number, height: number, animate: boolean) => void;
      };
      target.setSize(900, 900, false);
    });
    const shrink = settleBudget('the dock after the window narrows to 900 px', {
      timeout: LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expectSettledReading(
      () => page.evaluate(() => window.innerWidth),
      (width) => expect(width).toBeLessThan(1000),
      { reading: 'innerWidth', of: 'the editor window', budget: shrink },
    );
    await expectSettledReading(
      () => readTerminalHome(page),
      (home) => expect(home).toEqual({ placement: 'right', geometry: 'right', painted: true }),
      { reading: 'terminal home', of: 'the narrowed editor window', budget: shrink },
    );
    await expect(page.locator(AGENTS_UNIT)).toBeVisible();
    await expectHeaderPanesOn(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const narrowRestore = settleBudget('the narrowed dock after a renderer restart', {
      timeout: 20_000,
    });
    await expectSettledReading(
      () => readTerminalHome(page),
      (home) => expect(home).toEqual({ placement: 'right', geometry: 'right', painted: true }),
      { reading: 'terminal home', of: 'the restored narrow editor window', budget: narrowRestore },
    );
    await expect(page.locator(AGENTS_UNIT)).toBeVisible({ timeout: narrowRestore.remainingMs() });
    await expectHeaderPanesOn(page);
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
    await configureDesktopGitRepositories(page, s.projectDir);

    await openTerminal(app, page);
    await expect
      .poll(() => readTerminalHome(page), { timeout: 10_000 })
      .toEqual({ placement: 'bottom', geometry: 'bottom', painted: true });
    const token = randomUUID().replaceAll('-', '');
    const processMarker = `MALFORMED_PROCESS_${token}`;
    const processId = await readShellPid(page, processMarker);

    await moveTerminal(app, page, 'right');
    await moveTerminal(app, page, 'bottom');
    const storedArrangement = await storedDockArrangement(page, { timeout: 10_000 });
    const malformed = {
      arrangement: JSON.stringify({
        direction: 'row',
        items: [
          { size: 1, node: { pane: 'editor' } },
          { size: 1, node: { pane: 'agents' } },
        ],
      }),
      placement: 'future-home',
      rightWidth: 'not-a-width',
      agentsWidth: 'agents-width-sentinel',
      height: 'height-sentinel',
    };
    await page.evaluate(
      ({ key, values }) => {
        localStorage.setItem(key, values.arrangement);
        localStorage.setItem('ok-terminal-placement-v1', values.placement);
        localStorage.setItem('ok-terminal-right-width-v1', values.rightWidth);
        localStorage.setItem('ok-terminal-width-v1', values.agentsWidth);
        localStorage.setItem('ok-terminal-height-v1', values.height);
      },
      { key: storedArrangement.key, values: malformed },
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => readTerminalHome(page), { timeout: 20_000 })
      .toEqual({ placement: 'bottom', geometry: 'bottom', painted: true });
    expect(
      await page.evaluate(() => ({
        placement: localStorage.getItem('ok-terminal-placement-v1'),
        rightWidth: localStorage.getItem('ok-terminal-right-width-v1'),
        agentsWidth: localStorage.getItem('ok-terminal-width-v1'),
        height: localStorage.getItem('ok-terminal-height-v1'),
      })),
      'the retired per-install layout keys are read once to seed a project, never written',
    ).toEqual({
      placement: malformed.placement,
      rightWidth: malformed.rightWidth,
      agentsWidth: malformed.agentsWidth,
      height: malformed.height,
    });
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const output = `AFTER_MALFORMED_RESTART_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(output)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(output);
  });

  test('the terminal is its own card: under the whole editor card at the bottom, a full-height card on the right', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);
    await page.evaluate(() => {
      window.location.hash = '#/start';
    });
    await expect(
      page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)').first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true', {
      timeout: 10_000,
    });

    const box = async (selector: string) => {
      const rect = await page.locator(selector).first().boundingBox();
      if (rect == null) throw new Error(`${selector} has no box`);
      return {
        x: rect.x,
        y: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        height: rect.height,
      };
    };
    const gapPx = 8;
    const clippingAncestors = (card: Locator) =>
      card.evaluate((element) => {
        const clippers: string[] = [];
        let cur: Element | null = element.parentElement;
        while (cur != null && cur !== document.body) {
          if (getComputedStyle(cur).overflow !== 'visible') clippers.push(cur.className.toString());
          cur = cur.parentElement;
        }
        return clippers;
      });
    const terminalCard = page.locator(TERMINAL_CARD);

    await openTerminal(app, page);
    await clickViewAgentsItem(app, page);
    await expect(page.locator(AGENTS_UNIT)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => readTerminalHome(page), { timeout: 10_000 })
      .toEqual({ placement: 'bottom', geometry: 'bottom', painted: true });
    expect(
      await clippingAncestors(terminalCard),
      'nothing between the bottom terminal card and the window clips its shadow',
    ).toEqual([]);
    const editor = await box('[data-slot="pane-card"][data-pane="editor"]');
    const bottom = await box(TERMINAL_CARD);
    const fileList = await box('[data-slot="sidebar-container"]');
    const sidePanel = await box('#doc-panel');
    expect(
      Math.abs(bottom.x - editor.x),
      'the bottom terminal card starts under the file list',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bottom.right - editor.right),
      'the bottom terminal card ends under the side panel',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bottom.y - editor.bottom - gapPx),
      'one gap separates the editor card and the terminal card',
    ).toBeLessThanOrEqual(1);
    expect(fileList.bottom, 'the file list stops above the terminal card').toBeLessThanOrEqual(
      bottom.y + 1,
    );
    expect(sidePanel.bottom, 'the side panel stops above the terminal card').toBeLessThanOrEqual(
      bottom.y + 1,
    );
    const bottomBar = await box(`${TERMINAL_CARD} [data-terminal-tab-row]`);
    expect(Math.abs(bottomBar.height - 44), 'the terminal top bar is 44px').toBeLessThanOrEqual(1);
    expect(Math.abs(bottomBar.y - bottom.y)).toBeLessThanOrEqual(1);

    await moveTerminal(app, page, 'right');
    expect(
      await clippingAncestors(terminalCard),
      'nothing between the right terminal card and the window clips its shadow',
    ).toEqual([]);
    const editorAfter = await box('[data-slot="pane-card"][data-pane="editor"]');
    const right = await box(TERMINAL_CARD);
    expect(
      Math.abs(right.y - editorAfter.y),
      'the right terminal card top lines up with the editor card',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(right.bottom - editorAfter.bottom),
      'the right terminal card runs the full height',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(right.x - editorAfter.right - gapPx),
      'one gap separates the editor card and the right terminal card',
    ).toBeLessThanOrEqual(1);
    const chat = await box('[data-slot="pane-card"][data-pane="agents"]');
    expect(
      Math.abs(chat.x - right.right - gapPx),
      'one gap separates the right terminal card and the chat card after it',
    ).toBeLessThanOrEqual(1);
    const tabRow = await box('header[data-editor-header]');
    const rightBar = await box(`${TERMINAL_CARD} [data-terminal-tab-row]`);
    expect(
      Math.abs(rightBar.height - tabRow.height),
      'the right terminal top bar matches the tab row height',
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(rightBar.y - tabRow.y)).toBeLessThanOrEqual(1);
  });
});
