import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
import {
  armDockRevealProbe,
  DOCK_REVEAL_BUDGET_MS,
  DOCK_REVEAL_WATCH_CEILING_MS,
  measureDockRevealMs,
  watchForDockReveal,
} from './_helpers/dock-reveal-latency';
import { attachDomState, describeDomState } from './_helpers/dom-state';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { launchDesktopApp, readBootLog, waitForWindowByMode } from './_helpers/launch-readiness';
import { sumOfDeclaredBoundsMs } from './_helpers/parse-timeouts';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expectCollapsedRailColumn } from './_helpers/rail-column';
import { closeAppForRelaunch } from './_helpers/settings-surface';
import {
  expectSettledReading,
  pollSettledReading,
  RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  settleBudget,
} from './_helpers/settled-reading';
import { expect, test } from './_helpers/smoke-test';
import { captureTerminalStartupDiagnostics, waitForShellReady } from './_helpers/terminal-ready';
import {
  buildInputReadyProbe,
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
  writeFakeClaudeShim,
} from './_helpers/terminal-smoke-shell';
import { expectNoticeFromTrigger, transientNoticeObservation } from './_helpers/transient-notice';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHELL_COMMANDS = terminalSmokeShellCommands();
const TERMINAL_DOCK_PANEL_ID = 'terminal-dock-panel';
const TERMINAL_DOCK_PANEL_SELECTOR = `#${TERMINAL_DOCK_PANEL_ID}`;

interface SeedOpts {
  consent?: boolean;
  optOut?: boolean;
  claudeJson?: Record<string, unknown> | null;
  fakeClaudeOnPath?: boolean;
  fakeClaudeTui?: boolean;
  skipRestoreState?: boolean;
  pinRestrictedPath?: boolean;
}

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
  realProjectDir: string;
  pathPrefix: string | null;
}

function seed(prefix: string, opts: SeedOpts = {}): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-term-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-term-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');

  if (opts.consent || opts.optOut) {
    mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
    const enabled = opts.optOut ? 'false' : 'true';
    writeFileSync(
      join(projectDir, '.ok', 'local', 'config.yml'),
      `terminal:\n  enabled: ${enabled}\n`,
    );
  }

  if (opts.claudeJson !== undefined && opts.claudeJson !== null) {
    writeFileSync(join(tmpHome, '.claude.json'), JSON.stringify(opts.claudeJson, null, 2));
  }

  let pathPrefix: string | null = null;
  if (opts.fakeClaudeOnPath || opts.fakeClaudeTui) {
    const binDir = join(tmpHome, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFakeClaudeShim(binDir, opts.fakeClaudeTui ? 'interactive' : 'version');
    pathPrefix = binDir;
  }
  seedTerminalShellProfiles(tmpHome, {
    posixPathPrefix: pathPrefix ?? undefined,
    posixRestrictPath: opts.pinRestrictedPath,
  });

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  if (!opts.skipRestoreState) {
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          { path: projectDir, name: 'Terminal Smoke', lastOpenedAt: new Date().toISOString() },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );
  }

  return { tmpHome, userDataDir, projectDir, realProjectDir: projectDir, pathPrefix };
}

interface LaunchOpts {
  restrictPath?: boolean;
  connectionsAvailable?: boolean;
  phaseTrace?: boolean;
}

async function launchApp(s: Seed, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  if (opts.connectionsAvailable) {
    mkdirSync(join(s.tmpHome, '.ok'), { recursive: true });
    writeFileSync(
      join(s.tmpHome, '.ok', 'mcp-status.json'),
      JSON.stringify({ configured: false, skippedAt: new Date().toISOString() }),
    );
  }
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  return launchDesktopApp(
    electron,
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${s.userDataDir}`, deepLink],
      timeout: 30_000,
      env: {
        ...process.env,
        ...terminalSmokeEnvironment(s.tmpHome, {
          ...(s.pathPrefix ? { pathPrefix: s.pathPrefix } : {}),
          restrictPath: opts.restrictPath,
        }),
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_PTY_PHASE_TRACE: opts.phaseTrace ? '1' : '',
        OK_RECLAIM_DISABLE: opts.connectionsAvailable ? '0' : '1',
        OK_M6B_FORCE: opts.connectionsAvailable ? '1' : '0',
      },
    }),
    { home: s.tmpHome },
  );
}

async function findEditorWindow(app: ElectronApplication): Promise<Page> {
  return waitForWindowByMode(app, 'editor');
}

async function dispatchRendererMenuAction(
  action:
    | 'kill-terminal'
    | 'move-terminal'
    | 'new-terminal'
    | 'toggle-agent-panel'
    | 'toggle-editor'
    | 'toggle-terminal',
  editorPage: Page,
): Promise<void> {
  await editorPage.evaluate(async (menuAction) => {
    const menu = window.okDesktop?.menu;
    if (!menu) throw new Error('renderer menu bridge is unavailable');
    await menu.dispatch({ kind: 'menu-action', action: menuAction });
  }, action);
}

async function clickViewTerminalItem(app: ElectronApplication, editorPage: Page): Promise<string> {
  const label = await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) throw new Error('application menu is unavailable');
    const view = menu.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) throw new Error('View menu is missing the required Terminal visibility item');
    const label = item.label;
    if (process.platform === 'darwin') item.click();
    return label;
  });
  if (process.platform !== 'darwin')
    await dispatchRendererMenuAction('toggle-terminal', editorPage);
  return label;
}

async function viewTerminalLabel(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) throw new Error('application menu is unavailable');
    const view = menu?.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) throw new Error('View menu is missing the required Terminal visibility item');
    return item.label;
  });
}

async function waitForMenuSelectionState(page: Page, expected: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const menu = window.okDesktop?.menu;
        if (!menu) return undefined;
        const snapshot = await menu.dispatch({ kind: 'query' });
        return snapshot?.viewMenuState.hasEditorSelection;
      }),
    )
    .toBe(expected);
}

async function terminalPlacementLabel(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) throw new Error('application menu is unavailable');
    const terminal = menu.items.find((i) => i.label === 'Terminal');
    const item = terminal?.submenu?.items.find(
      (i) => i.label === 'Move Terminal to right' || i.label === 'Move Terminal to bottom',
    );
    if (!item) throw new Error('Terminal menu is missing the required placement item');
    return item.label;
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
    const terminal = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Terminal');
    const item = terminal?.submenu?.items.find(
      (i) => i.label === 'Move Terminal to right' || i.label === 'Move Terminal to bottom',
    );
    if (!item) throw new Error('Terminal menu is missing the required placement item');
    item.click();
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

async function clickViewEditorItem(app: ElectronApplication, editorPage: Page): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction('toggle-editor', editorPage);
    return;
  }
  await app.evaluate(async ({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    const item = view?.submenu?.items.find(
      (candidate) => candidate.label === 'Show Editor' || candidate.label === 'Hide Editor',
    );
    if (!item) throw new Error('View menu is missing the Editor visibility item');
    item.click();
  });
}

async function viewMenuEditorLabel(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    return view?.submenu?.items.find((item) => ['Show Editor', 'Hide Editor'].includes(item.label))
      ?.label;
  });
}

function restoredDockState(page: Page) {
  return page.evaluate(() => window.okDesktop?.terminal.getDockState());
}

const editorPaneButton = (page: Page) =>
  page.locator('header[data-app-header]').getByRole('button', { name: 'Editor', exact: true });

const terminalSection = (page: Page) => page.locator('section[aria-label="Terminal"]');
const terminalStatus = (page: Page) => page.locator('[data-terminal-status]');
const readinessBanner = (page: Page) =>
  page.getByRole('tabpanel').getByTestId('terminal-readiness-banner');

const activeTerminalOutput = (page: Page) =>
  page
    .getByRole('tabpanel')
    .getByRole('region', { name: 'Terminal', exact: true })
    .locator('.xterm-accessibility');

async function waitForRendererResponsive(page: Page): Promise<void> {
  await expect(async () => {
    for (let probe = 0; probe < 3; probe += 1) {
      const startedAt = Date.now();
      await page.evaluate(() => performance.now());
      expect(Date.now() - startedAt).toBeLessThan(100);
    }
  }).toPass({ timeout: 15_000, intervals: [250] });
}

async function widenEditorWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const editorWindow = await app.browserWindow(page);
  await editorWindow.evaluate(
    (win: unknown, size) => {
      (win as { setSize: (w: number, h: number, animate: boolean) => void }).setSize(
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

async function revealTerminalSurface(app: ElectronApplication, target: Locator): Promise<void> {
  await expect(async () => {
    if (await target.isVisible()) return;
    await clickViewTerminalItem(app, target.page());
    await expect(target).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 15_000 });
}

async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await revealTerminalSurface(app, terminalSection(page));
}

async function waitForTerminalWidthStable(page: Page): Promise<void> {
  const panel = page.locator('#terminal-dock-panel');
  let previous = Number.NaN;
  let stable = 0;
  await expect(async () => {
    const width = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    stable = width === previous ? stable + 1 : 0;
    previous = width;
    expect(stable).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 15_000, intervals: [100] });
  await page.waitForTimeout(500);
}

async function waitForStatus(
  page: Page,
  status: string,
  timeoutMs = 20_000,
  {
    foreground = 'shell',
    onPrimaryPromptFailure,
  }: { foreground?: 'shell' | 'program'; onPrimaryPromptFailure?: () => Promise<void> } = {},
): Promise<void> {
  await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', status, {
    timeout: timeoutMs,
  });
  if (status === 'running' && foreground === 'shell') {
    await waitForShellReady(
      () => readTerminalText(page),
      (command) => typeInTerminal(page, `${command}\r`),
      { onPrimaryPromptFailure },
    );
  }
}

async function attachTerminalStartupDiagnostics(page: Page, home: string): Promise<void> {
  await captureTerminalStartupDiagnostics({
    readBootLog: () => readBootLog(home),
    readTerminalDom: async () => ({
      a11y: await page.locator('.xterm-accessibility').allTextContents(),
      rows: await page.locator('.xterm-rows').allTextContents(),
    }),
    captureScreen: ({ quality }) => page.screenshot({ type: 'jpeg', quality }),
    attach: (name, attachment) => test.info().attach(name, attachment),
  });
}

async function ensureBottomDock(page: Page): Promise<void> {
  await expect(page.locator('#terminal-dock-panel')).toBeVisible({ timeout: 10_000 });
}

async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(text);
}

async function readTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Terminal"]');
    if (!sec) return '';
    const a11y = sec.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = sec.querySelector('.xterm-rows')?.textContent ?? '';
    return `${a11y}\n${rows}`;
  });
}

async function readTerminalRows(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('section[aria-label="Terminal"] .xterm-rows')?.textContent ?? '',
  );
}

type HeaderPane = 'Agents' | 'Terminal';

const headerPaneButton = (page: Page, pane: HeaderPane) =>
  page.locator('header[data-app-header]').getByRole('button', { name: pane, exact: true });

async function expectHeaderPanes(
  page: Page,
  pressed: Readonly<Record<HeaderPane, boolean>>,
  timeout = 10_000,
): Promise<void> {
  for (const pane of ['Agents', 'Terminal'] as const) {
    await expect(headerPaneButton(page, pane)).toHaveAttribute(
      'aria-pressed',
      String(pressed[pane]),
      { timeout },
    );
  }
}

async function activeElementTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute('data-testid') ?? active?.tagName ?? null;
  });
}

async function terminalHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Terminal"]');
    return sec?.contains(document.activeElement) ?? false;
  });
}

async function viewMenuPaneLabels(
  app: ElectronApplication,
): Promise<{ agents: string | undefined; terminal: string | undefined }> {
  return app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    const labelOf = (labels: readonly string[]) =>
      view?.submenu?.items.find((item) => labels.includes(item.label))?.label;
    return {
      agents: labelOf(['Show Agents', 'Hide Agents']),
      terminal: labelOf(['Show Terminal', 'Hide Terminal']),
    };
  });
}

async function clickTerminalMenuItem(
  app: ElectronApplication,
  page: Page,
  item:
    | { label: 'New Terminal'; action: 'new-terminal' }
    | { label: 'Kill Terminal'; action: 'kill-terminal' },
): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction(item.action, page);
    return;
  }
  await expect(async () => {
    const clicked = await app.evaluate(({ Menu }, label) => {
      const terminal = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Terminal');
      const menuItem = terminal?.submenu?.items.find((i) => i.label === label);
      if (!menuItem?.enabled) return false;
      menuItem.click();
      return true;
    }, item.label);
    expect(clicked, `Terminal > ${item.label} is not enabled yet`).toBe(true);
  }).toPass({ timeout: 10_000 });
}

const IN_WINDOW_MENU_RECOVERY = 'in-window-menu-recovery';

function describeCoveringLayer(state: string): string {
  try {
    const parsed = JSON.parse(state) as { crashInviteDialog?: boolean; dialogs?: number };
    if (parsed.crashInviteDialog === true)
      return 'the crash-invite bug report dialog was covering the page';
    if ((parsed.dialogs ?? 0) > 0) return 'a dialog was covering the page';
  } catch {}
  return 'no dialog was observed, but the header pane buttons were unreachable';
}

async function recordInWindowMenuRecovery(page: Page, moment: string): Promise<void> {
  const info = test.info();
  const ordinal =
    info.annotations.filter((annotation) => annotation.type === IN_WINDOW_MENU_RECOVERY).length + 1;
  const state = await describeDomState(page);
  const layer = describeCoveringLayer(state);
  info.annotations.push({
    type: IN_WINDOW_MENU_RECOVERY,
    description: `#${ordinal} ${moment}: ${layer}; Escape pressed. ${state}`,
  });
  await attachDomState(info, page, `${IN_WINDOW_MENU_RECOVERY}-${ordinal}`);
  console.log(
    `[smoke] ${IN_WINDOW_MENU_RECOVERY} #${ordinal} ${moment}: ${layer}; pressing Escape: ${state}`,
  );
}

async function dismissCrashInviteIfShown(page: Page, moment: string): Promise<boolean> {
  const invite = page.getByTestId('report-bug-crash-invite');
  if (!(await invite.isVisible())) return false;
  await recordInWindowMenuRecovery(page, moment);
  await page.keyboard.press('Escape');
  await expect(invite).toBeHidden({ timeout: 5_000 });
  return true;
}

async function clickInWindowViewTerminalItem(page: Page): Promise<void> {
  const trigger = page
    .getByTestId('app-menubar')
    .getByRole('menuitem', { name: 'View', exact: true });
  const item = page.getByRole('menuitem', { name: /^(Show|Hide) Terminal/ });
  try {
    await expect(async () => {
      await dismissCrashInviteIfShown(page, 'before opening the View menu');
      if ((await trigger.getAttribute('data-state')) !== 'open') {
        await trigger.focus();
        await page.keyboard.press('Enter');
      }
      await expect(item).toBeVisible({ timeout: 2_000 });
      await item.click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  } catch (error) {
    throw new Error(
      `the in-window View menu did not open and select its Terminal item: ${await describeDomState(page)}`,
      { cause: error },
    );
  }
  await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 5_000 });
  await settleHeaderAfterInWindowMenu(page);
}

async function settleHeaderAfterInWindowMenu(page: Page): Promise<void> {
  const agentsButton = headerPaneButton(page, 'Agents');
  try {
    await expect(agentsButton).toBeVisible({ timeout: 3_000 });
    return;
  } catch {}
  if (!(await dismissCrashInviteIfShown(page, 'after the View menu closed'))) {
    await recordInWindowMenuRecovery(page, 'after the View menu closed');
    await page.keyboard.press('Escape');
  }
  try {
    await expect(agentsButton).toBeVisible({ timeout: 5_000 });
  } catch (error) {
    throw new Error(
      `the header pane buttons stayed unreachable after Escape: ${await describeDomState(page)}`,
      { cause: error },
    );
  }
}

const cleanup: string[] = [];

function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Docked terminal — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.afterEach(() => {
    for (const target of cleanup.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  test('QA-004 first open mounts the live panel (no consent dialog)', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('default-on');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true, phaseTrace: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000, {
      onPrimaryPromptFailure: () => attachTerminalStartupDiagnostics(page, s.tmpHome),
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('QA-005 default-on spawns without writing terminal.enabled', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('default-on-no-write');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const localCfg = join(s.projectDir, '.ok', 'local', 'config.yml');
    const persisted = existsSync(localCfg) ? readFileSync(localCfg, 'utf8') : '';
    expect(persisted).not.toMatch(/enabled:\s*true/);
  });

  test('QA-006 opted-out shows not-enabled notice; Enable re-enables the shell', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('opt-out', { optOut: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await revealTerminalSurface(app, page.getByRole('region', { name: 'Terminal disabled' }));
    await expect(page.getByRole('button', { name: 'Enable terminal' })).toBeVisible();
    await expect(terminalStatus(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Enable terminal' }).click();
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await waitForStatus(page, 'running', 25_000);
  });

  test('QA-002 View-menu Terminal item toggles the panel and flips label', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('toggle', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    expect(await viewTerminalLabel(app)).toBe('Show Terminal');
    await revealTerminalSurface(app, terminalSection(page));
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');

    await clickViewTerminalItem(app, page);
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');
  });

  test('native Terminal placement action follows the current home', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('placement-menu', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    expect(await terminalPlacementLabel(app)).toBe('Move Terminal to right');
    await clickTerminalPlacementItem(app, page);
    await expect
      .poll(() => terminalPlacementLabel(app), { timeout: 8_000 })
      .toBe('Move Terminal to bottom');

    await clickTerminalPlacementItem(app, page);
    await expect
      .poll(() => terminalPlacementLabel(app), { timeout: 8_000 })
      .toBe('Move Terminal to right');
  });

  test('Terminal header placement is symmetric', async ({ captureStderrFor }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('header-placement', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await widenEditorWindow(app, page, 1900, 900);
    await openTerminal(app, page);

    const rightTerminal = page.locator('#terminal-column section[aria-label="Terminal"]');
    const moveRightButton = page.getByRole('button', { name: 'Move Terminal to right' });
    await expect(moveRightButton).toBeVisible();
    await moveRightButton.click();
    await expect(rightTerminal).toBeVisible({ timeout: 10_000 });

    const moveBottomButton = page.getByRole('button', { name: 'Move Terminal to bottom' });
    await expect(moveBottomButton).toBeVisible();
    await moveBottomButton.click();
    await expect(rightTerminal).toBeHidden({ timeout: 10_000 });
    await expect(moveRightButton).toBeVisible();
  });

  test('a pointerleave mid-drag resizes the right column by the real delta, never collapsing it', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('divider-pointerleave', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await widenEditorWindow(app, page, 1900, 900);
    await openTerminal(app, page);
    await page.getByRole('button', { name: 'Move Terminal to right' }).click();
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });

    const column = page.locator('#terminal-column');
    const before = await column.evaluate((element) => element.getBoundingClientRect().width);
    expect(before).toBeGreaterThan(0);

    const handle = await column.evaluate((element) => {
      const rect = element.previousElementSibling?.getBoundingClientRect();
      return rect == null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!handle) throw new Error('right Terminal resize handle is unavailable');

    const travel = 40;
    const originX = handle.x + handle.width / 2;
    const originY = handle.y + handle.height / 2;
    await page.mouse.move(originX, originY);
    await page.mouse.down();
    await page.mouse.move(originX - travel, originY, { steps: 4 });

    await page.evaluate(
      ({ x, y }) => {
        document.dispatchEvent(
          new PointerEvent('pointerleave', {
            bubbles: false,
            buttons: 1,
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
          }),
        );
      },
      { x: originX - travel, y: originY },
    );
    await page.mouse.up();

    let after = Number.NaN;
    let stable = 0;
    await expect(async () => {
      const width = await column.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      );
      stable = width === after ? stable + 1 : 0;
      after = width;
      expect(
        stable,
        `column width has not settled (last read ${width}px, before ${before}px)`,
      ).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 10_000, intervals: [100] });
    expect(after).toBeGreaterThan(before + travel * 0.75);
    expect(after).toBeLessThan(before + travel * 1.25);
  });

  test('right Terminal and Agents exclude each other only when the window is infeasible', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('rail-admission', { consent: true, skipRestoreState: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await widenEditorWindow(app, page, 1900, 900);
    await openTerminal(app, page);
    await clickTerminalPlacementItem(app, page);
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });
    await waitForStatus(page, 'running', 25_000);
    await clickViewAgentsItem(app, page);
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          page
            .locator('#terminal-column')
            .evaluate((element) => element.getBoundingClientRect().width),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(739);
    await typeInTerminal(page, `${SHELL_COMMANDS.columns('RAIL_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/RAIL_COLS=\d+/);
    const columns = (await readTerminalText(page)).match(/RAIL_COLS=(\d+)/)?.[1];
    expect(Number(columns)).toBeGreaterThanOrEqual(92);

    const editorWindow = await app.browserWindow(page);
    const shrink = settleBudget('rail admission after the window narrows to 900 px', {
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    });
    await expectNoticeFromTrigger(
      'Agent panel closed to keep Terminal readable.',
      transientNoticeObservation(page, {
        document: 'current',
        trigger: async () => {
          await editorWindow.evaluate((win: unknown) => {
            const target = win as {
              setSize: (width: number, height: number, animate: boolean) => void;
            };
            target.setSize(900, 900, false);
          });
        },
      }),
      { timeout: shrink.remainingMs() },
    );
    await expectSettledReading(
      () => page.evaluate(() => window.innerWidth),
      (width) => expect(width).toBeLessThan(1000),
      { reading: 'innerWidth', of: 'the editor window', budget: shrink },
    );
    await expectCollapsedRailColumn(page, '#agents-column', { budget: shrink });
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible();
    await expectHeaderPanes(page, { Agents: false, Terminal: true });

    await expectNoticeFromTrigger(
      'Terminal closed to make room for the agent panel.',
      transientNoticeObservation(page, {
        document: 'current',
        trigger: () => clickViewAgentsItem(app, page),
      }),
      { timeout: 10_000 },
    );
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expectCollapsedRailColumn(page, '#terminal-column');
    await expectHeaderPanes(page, { Agents: true, Terminal: false });

    await clickViewAgentsItem(app, page);
    await expectCollapsedRailColumn(page, '#agents-column');
    await expectCollapsedRailColumn(page, '#terminal-column');
    await expectHeaderPanes(page, { Agents: false, Terminal: false });

    await headerPaneButton(page, 'Terminal').click();
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });
    await expectHeaderPanes(page, { Agents: false, Terminal: true });
    await expectNoticeFromTrigger(
      'Terminal closed to make room for the agent panel.',
      transientNoticeObservation(page, {
        document: 'current',
        trigger: () => headerPaneButton(page, 'Agents').click(),
      }),
      { timeout: 10_000 },
    );
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expectCollapsedRailColumn(page, '#terminal-column');
    await expectHeaderPanes(page, { Agents: true, Terminal: false });
  });

  test('QA-022 toggle reveals the dock and mounts the terminal inside their liveness budgets', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('perf', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await waitForRendererResponsive(page);

    const t0 = await page.evaluate(() => performance.now());
    const dockElapsed = await measureDockRevealMs({
      armProbe: () => armDockRevealProbe(page, TERMINAL_DOCK_PANEL_ID),
      watchForReveal: () =>
        watchForDockReveal(page, TERMINAL_DOCK_PANEL_ID, DOCK_REVEAL_WATCH_CEILING_MS),
      triggerReveal: async () => {
        expect(await clickViewTerminalItem(app, page)).toBe('Show Terminal');
      },
    });
    console.log(`[dock-reveal] revealMs=${dockElapsed.toFixed(1)}`);
    await expect(page.locator(TERMINAL_DOCK_PANEL_SELECTOR)).toBeVisible();
    expect(dockElapsed).toBeLessThan(DOCK_REVEAL_BUDGET_MS);

    const mountBudgetMs = 15_000;
    await page.waitForSelector('section[aria-label="Terminal"]', {
      state: 'attached',
      timeout: mountBudgetMs * 2,
    });
    const mountElapsed = await page.evaluate((start) => performance.now() - start, t0);
    expect(mountElapsed).toBeLessThan(mountBudgetMs);
  });

  test('QA-003 shell starts at project root and runs commands', async ({ captureStderrFor }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('cmd', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, `${SHELL_COMMANDS.cwd}\r`);
    const tail = basename(s.realProjectDir);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toContain(tail);

    const afterMarker = buildInputReadyProbe();
    await typeInTerminal(page, `${afterMarker.command}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain(afterMarker.marker);
  });

  test('a window-resize storm keeps the shell responsive and settles the PTY at the fitted grid', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('resize-storm', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, `${SHELL_COMMANDS.columns('BEFORE_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/BEFORE_COLS=\d+/);
    const before = (await readTerminalText(page)).match(/BEFORE_COLS=(\d+)/)?.[1];

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window to resize');
      const [w, h] = win.getSize();
      for (let i = 0; i < 24; i++) {
        const dw = (i % 2 === 0 ? -1 : 1) * (8 + (i % 5) * 6);
        win.setSize(w + dw, h, false);
        await new Promise((r) => setTimeout(r, 40));
      }
      win.setSize(w, h, false);
    });

    await waitForTerminalWidthStable(page);

    await typeInTerminal(page, `${SHELL_COMMANDS.columns('AFTER_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/AFTER_COLS=\d+/);
    const beforeColumns = Number(before);
    expect(beforeColumns).toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          const after = (await readTerminalText(page)).match(/AFTER_COLS=(\d+)/)?.[1];
          return after == null ? Number.POSITIVE_INFINITY : Math.abs(Number(after) - beforeColumns);
        },
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(2);
  });

  test('terminal tab strip carries no collapse or legacy dock chrome while the header Terminal button reads on', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('dock-controls', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await expect(page.getByTestId('header-pane-button-terminal')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10_000 },
    );
    await expect(page.getByRole('button', { name: /^Collapse/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Dock terminal to the/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Drag to dock the terminal' })).toHaveCount(0);
  });

  test('the terminal lives in the bottom panel, never in the right column', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('dock-edges', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(page.locator('#terminal-dock-panel section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#agents-column section[aria-label="Terminal"]')).toHaveCount(0);
  });

  test('QA-020 panel exposes region + screen-reader mode + AA contrast', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('a11y', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect(page.locator('section[aria-label="Terminal"] .xterm-accessibility')).toHaveCount(
      1,
    );
  });

  test('QA-019 Escape reaches the terminal; CmdOrCtrl+J is the no-trap exit', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('escape', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const focusInTerminal = () =>
      page.evaluate(() => {
        const sec = document.querySelector('section[aria-label="Terminal"]');
        return sec?.contains(document.activeElement) ?? false;
      });

    await page.locator('section[aria-label="Terminal"] .xterm').click();
    await expect.poll(focusInTerminal).toBe(true);

    await page.keyboard.press('Escape');
    await expect.poll(focusInTerminal).toBe(true);

    await clickViewTerminalItem(app, page);
    await expect.poll(focusInTerminal).toBe(false);
  });

  test('Ctrl+` collapses the dock from inside a focused terminal', async ({ captureStderrFor }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('ctrl-backtick', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true, phaseTrace: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000, {
      onPrimaryPromptFailure: () => attachTerminalStartupDiagnostics(page, s.tmpHome),
    });

    const focusInTerminal = () =>
      page.evaluate(() => {
        const sec = document.querySelector('section[aria-label="Terminal"]');
        return sec?.contains(document.activeElement) ?? false;
      });

    await page.locator('section[aria-label="Terminal"] .xterm').click();
    await expect.poll(focusInTerminal).toBe(true);
    expect(await viewTerminalLabel(app)).toBe('Hide Terminal');

    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');
    await expect.poll(focusInTerminal).toBe(false);

    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');
  });

  test('QA-021 collapsed panel is inert and focus returns on collapse', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('inert', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await ensureBottomDock(page);
    await page.locator('section[aria-label="Terminal"] .xterm').click();

    await clickViewTerminalItem(app, page);
    await expect(page.locator('#terminal-dock-panel')).toHaveAttribute('inert', '', {
      timeout: 10_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const sec = document.querySelector('section[aria-label="Terminal"]');
          return sec?.contains(document.activeElement) ?? false;
        }),
      )
      .toBe(false);
  });

  test('QA-023 panel height persists across reopen', async ({ captureStderrFor }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('resize', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await ensureBottomDock(page);

    const panel = page.locator('#terminal-dock-panel');
    const heightBefore = await panel.evaluate((el) => el.getBoundingClientRect().height);

    const handle = panel.locator('xpath=preceding-sibling::*[@role="separator"][1]');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    if (box == null) throw new Error('bottom terminal resize handle has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 160, { steps: 12 });
    await page.mouse.up();

    await pollSettledReading(() => panel.evaluate((el) => el.getBoundingClientRect().height), {
      reading: 'height',
      of: '#terminal-dock-panel after resize',
      timeout: 10_000 satisfies typeof RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    }).toBeGreaterThan(heightBefore);

    const heightAfter = await panel.evaluate((el) => el.getBoundingClientRect().height);

    await pollSettledReading(
      () => page.evaluate(() => Number(localStorage.getItem('ok-terminal-height-v1') ?? 0)),
      {
        reading: 'persisted height',
        of: 'bottom terminal',
        timeout: 10_000 satisfies typeof RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
      },
    ).toBeGreaterThan(heightBefore);

    await clickViewTerminalItem(app, page);
    await expect(panel).toHaveAttribute('inert', '', { timeout: 10_000 });
    await clickViewTerminalItem(app, page);
    await expect(terminalSection(page)).toBeVisible({ timeout: 10_000 });
    await pollSettledReading(
      async () => {
        const heightReopen = await panel.evaluate((el) => el.getBoundingClientRect().height);
        return Math.abs(heightReopen - heightAfter);
      },
      {
        reading: 'reopened height difference',
        of: '#terminal-dock-panel',
        timeout: 10_000 satisfies typeof RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
      },
    ).toBeLessThan(40);
  });

  test('QA-015/032 shell exit shows restart; banner hidden on exit', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('exit', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, 'exit\r');
    await waitForStatus(page, 'exited', 15_000);
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5_000 });
    const restart = page.getByRole('button', { name: /Restart terminal/i });
    await expect(restart).toBeVisible();
    await expect(readinessBanner(page)).toHaveCount(0);

    await restart.click();
    await waitForStatus(page, 'running', 25_000);
    const afterRestart = buildInputReadyProbe();
    await typeInTerminal(page, `${afterRestart.command}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain(afterRestart.marker);
  });

  test('QA-017 plain terminal stays quiet; missing Claude launch shows Get-Claude-Code banner', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('claude-missing', { consent: true, pinRestrictedPath: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(readinessBanner(page)).toHaveCount(0);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { kind: 'cli', prompt: '', cli: 'claude', stage: false },
        }),
      );
    });

    const banner = page.getByRole('tabpanel').getByTestId('terminal-cli-missing-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('installed or on your PATH');
    await expect(page.getByRole('button', { name: 'Get Claude Code' })).toBeVisible();
  });

  test('QA-018 Connect tools opens Claude setup and can restart the terminal afterward', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('mcp-rewire', {
      consent: true,
      fakeClaudeTui: true,
      claudeJson: { mcpServers: { 'some-other': { command: 'noop' } } },
    });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true, connectionsAvailable: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(readinessBanner(page)).toHaveCount(0);
    const initialSessions = await page.evaluate(() => window.okDesktop?.terminal.list());
    expect(initialSessions).toHaveLength(1);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { kind: 'cli', prompt: '', cli: 'claude', stage: false },
        }),
      );
    });

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('OpenKnowledge tools');
    await page.getByRole('button', { name: 'Connect tools' }).click();
    const setup = page.getByRole('dialog', { name: 'Claude', exact: true });
    await expect(setup).toContainText('Choose what OpenKnowledge sets up for Claude.');
    await expect(page.getByText('Welcome to OpenKnowledge', { exact: true })).toHaveCount(0);
    await setup.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(banner).toBeVisible();

    await page.getByRole('button', { name: 'Connect tools' }).click();
    await setup.getByRole('checkbox', { name: 'Global MCP server', exact: true }).uncheck();
    await setup
      .getByRole('checkbox', { name: 'OpenKnowledge discovery skill', exact: true })
      .uncheck();
    await setup.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(setup).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    const restartNotice = page.getByTestId('terminal-restart-banner');
    await expect(restartNotice).toContainText(
      'Restart this terminal session to use the newly installed OpenKnowledge tools.',
    );
    const beforeRestart = await page.evaluate(() => window.okDesktop?.terminal.list());
    expect(beforeRestart).toHaveLength(2);
    const terminalOutput = activeTerminalOutput(page);
    await expect(terminalOutput).toContainText('FAKE_CLAUDE_TUI_READY');
    await restartNotice.getByRole('button', { name: 'Restart terminal' }).click();
    await expect(restartNotice).toHaveCount(0);
    await expect
      .poll(async () => {
        const sessions = await page.evaluate(() => window.okDesktop?.terminal.list());
        return sessions?.filter(
          (session) => !beforeRestart?.some((old) => old.ptyId === session.ptyId),
        ).length;
      })
      .toBe(1);
    const afterRestart = await page.evaluate(() => window.okDesktop?.terminal.list());
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart).toEqual(expect.arrayContaining(initialSessions ?? []));
    await expect(terminalOutput).toContainText('FAKE_CLAUDE_TUI_READY');
    await expect(banner).toHaveCount(0);
    expect(
      JSON.parse(readFileSync(join(s.projectDir, '.mcp.json'), 'utf8')).mcpServers[
        'open-knowledge'
      ],
    ).toBeDefined();
    expect(existsSync(join(s.projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('Settings installation prompts both running Claude terminals to restart', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('settings-agent-tools', {
      consent: true,
      fakeClaudeTui: true,
      claudeJson: { mcpServers: { 'some-other': { command: 'noop' } } },
    });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true, connectionsAvailable: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    for (let index = 0; index < 2; index += 1) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('open-knowledge:terminal-launch', {
            detail: { kind: 'cli', prompt: '', cli: 'claude', stage: false },
          }),
        );
      });
      await expect(
        page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab'),
      ).toHaveCount(index + 2);
      await expect(readinessBanner(page)).toBeVisible({ timeout: 15_000 });
      await expect(activeTerminalOutput(page)).toContainText('FAKE_CLAUDE_TUI_READY', {
        timeout: 15_000,
      });
    }
    const sessionsBefore = await page.evaluate(() => window.okDesktop?.terminal.list());
    expect(sessionsBefore).toHaveLength(3);
    await page.evaluate(() => {
      window.location.hash = '#settings/agent-connections';
    });
    await page
      .getByTestId('configure-agents-terminal-row-claude')
      .getByRole('button', { name: 'Add MCP & skill for Claude CLI', exact: true })
      .click();
    const setup = page.getByRole('dialog', { name: 'Claude', exact: true });
    await expect(setup).toContainText('Choose what OpenKnowledge sets up for Claude.');
    await setup.getByRole('checkbox', { name: 'Project MCP server', exact: true }).check();
    await setup.getByRole('checkbox', { name: 'Project skill', exact: true }).check();
    await setup.getByRole('checkbox', { name: 'Global MCP server', exact: true }).uncheck();
    await setup
      .getByRole('checkbox', { name: 'OpenKnowledge discovery skill', exact: true })
      .uncheck();
    await setup.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(setup).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const restart = page.getByRole('tabpanel').getByTestId('terminal-restart-banner');
    await expect(restart).toBeVisible();
    await expect(readinessBanner(page)).toHaveCount(0);
    const tabs = page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');
    await tabs.nth(1).click();
    await expect(restart).toBeVisible();
    await expect(readinessBanner(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.okDesktop?.terminal.list())).toEqual(sessionsBefore);
    await restart.getByRole('button', { name: 'Restart terminal', exact: true }).click();
    await expect(restart).toHaveCount(0);
    await expect
      .poll(async () => {
        const sessions = await page.evaluate(() => window.okDesktop?.terminal.list());
        return sessions?.filter(
          (session) => !sessionsBefore?.some((old) => old.ptyId === session.ptyId),
        ).length;
      })
      .toBe(1);
    await expect(readinessBanner(page)).toHaveCount(0);
    await tabs.nth(2).click();
    await expect(restart).toBeVisible();
    await expect(readinessBanner(page)).toHaveCount(0);
    expect(existsSync(join(s.projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(s.projectDir, '.mcp.json'), 'utf8')).mcpServers[
        'open-knowledge'
      ],
    ).toBeDefined();
  });

  test('a renderer reload preserves the open terminal and its live session', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('reload-survival', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.setEnvironment('OK_RELOAD_MARKER', 'OKRELOAD_SURVIVED_351')}\r`,
    );
    await typeInTerminal(page, `${SHELL_COMMANDS.readEnvironment('OK_RELOAD_MARKER', 'before')}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('before=[OKRELOAD_SURVIVED_351]');

    await page.reload();

    await expect(terminalSection(page)).toBeVisible({ timeout: 20_000 });
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, `${SHELL_COMMANDS.readEnvironment('OK_RELOAD_MARKER', 'marker')}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('marker=[OKRELOAD_SURVIVED_351]');
  });

  test('the primary-modifier J shortcuts stage a new CLI tab and toggle visibility', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('stage', { consent: true, fakeClaudeTui: true, skipRestoreState: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await configureDesktopGitRepositories(page, s.realProjectDir);

    await page.evaluate(() => {
      localStorage.setItem('ok-ask-ai-agent-v2', 'terminal-cli:claude');
      window.dispatchEvent(new StorageEvent('storage', { key: 'ok-ask-ai-agent-v2' }));
    });

    const editor = page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)');
    await expect(editor).toContainText('Seed document', { timeout: 30_000 });
    await editor.focus();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
    await expect
      .poll(() => page.evaluate(() => String(window.getSelection() ?? '')))
      .toContain('Seed document');
    await waitForMenuSelectionState(page, true);

    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+j`);
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await waitForStatus(page, 'running', 25_000, { foreground: 'program' });
    await expect.poll(() => readTerminalText(page), { timeout: 20_000 }).toContain('start.md');
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toContain('Seed document');
    const terminalTabs = () => terminalSection(page).getByRole('tab');
    const tabsAfterLaunch = await terminalTabs().count();

    await editor.focus();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
    await page.keyboard.type('Reuse marker OKSTAGE_REUSE_742 body');
    await waitForMenuSelectionState(page, false);
    await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
    await expect
      .poll(() => page.evaluate(() => String(window.getSelection() ?? '')))
      .toContain('OKSTAGE_REUSE_742');
    await waitForMenuSelectionState(page, true);

    expect(await clickViewTerminalItem(app, page)).toBe('Hide Terminal');
    await expect(terminalSection(page)).toBeHidden();
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');

    expect(await clickViewTerminalItem(app, page)).toBe('Show Terminal');
    await expect(terminalSection(page)).toBeVisible();
    await waitForStatus(page, 'running', 25_000, { foreground: 'program' });
    expect(await terminalTabs().count()).toBe(tabsAfterLaunch);
    expect(await readTerminalText(page)).toContain('Seed document');
    expect(await readTerminalText(page)).not.toContain('OKSTAGE_REUSE_742');
  });

  test('the header Terminal button starts a focused shell and keeps it across a hide and show', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('header-shell', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    const terminalButton = headerPaneButton(page, 'Terminal');

    await expect(terminalButton).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });
    await expect(terminalSection(page)).toBeHidden();

    await terminalButton.click();
    await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => terminalHasFocus(page), { timeout: 15_000 }).toBe(true);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.setEnvironment('OK_HEADER_MARKER', 'OKHEADER_KEPT_418')}\r`,
    );
    await typeInTerminal(page, `${SHELL_COMMANDS.readEnvironment('OK_HEADER_MARKER', 'before')}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('before=[OKHEADER_KEPT_418]');

    await terminalButton.click();
    await expect(terminalButton).toHaveAttribute('aria-pressed', 'false');
    await expect(terminalSection(page)).toBeHidden();
    await expect
      .poll(() => activeElementTestId(page), { timeout: 5_000 })
      .toBe('header-pane-button-terminal');

    await page.keyboard.press('Enter');
    await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => terminalHasFocus(page), { timeout: 15_000 }).toBe(true);
    await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', 'running');
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('before=[OKHEADER_KEPT_418]');
    await typeInTerminal(page, `${SHELL_COMMANDS.readEnvironment('OK_HEADER_MARKER', 'after')}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('after=[OKHEADER_KEPT_418]');
  });

  test('a running shell completes output while Terminal is hidden at the native minimum', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('narrow-shell-continuity', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1000, 700);
    await expect(terminalSection(page)).toBeHidden();
    await headerPaneButton(page, 'Terminal').click();
    await expect(terminalSection(page)).toBeVisible();
    await waitForStatus(page, 'running', 25_000);

    const initialSessions = await page.evaluate(() => window.okDesktop?.terminal.list());
    expect(initialSessions).toHaveLength(1);
    const ptyId = initialSessions?.[0]?.ptyId;
    expect(ptyId).toBeTruthy();
    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.setEnvironment('OK_RESPONSIVE_SHELL', 'OK_SHELL_SURVIVED_628')}\r`,
    );
    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.readEnvironment('OK_RESPONSIVE_SHELL', 'before')}\r`,
    );
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('before=[OK_SHELL_SURVIVED_628]');

    await widenEditorWindow(app, page, 720, 480);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(768);
    await expect
      .poll(() => app.browserWindow(page).then((win) => win.evaluate((w) => w.getSize())))
      .toEqual([720, 480]);
    await expect(headerPaneButton(page, 'Terminal')).toHaveAttribute('aria-pressed', 'true');
    await expect(terminalSection(page)).toBeVisible();
    await typeInTerminal(page, `${SHELL_COMMANDS.columns('NARROW_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/NARROW_COLS=\d+/);
    const narrowColumns = Number((await readTerminalText(page)).match(/NARROW_COLS=(\d+)/)?.[1]);
    expect(narrowColumns).toBeGreaterThan(0);

    const waitingPath = join(s.projectDir, 'terminal-waiting');
    const releasePath = join(s.projectDir, 'terminal-release');
    const acknowledgementPath = join(s.projectDir, 'terminal-completed');
    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.waitForFileThenOutput(releasePath, waitingPath, acknowledgementPath, 'OK_TERMINAL_WAITING_628')}\r`,
    );
    await expect.poll(() => existsSync(waitingPath), { timeout: 15_000 }).toBe(true);

    await editorPaneButton(page).click();
    await expect(terminalSection(page)).toBeHidden();
    await expect(editorPaneButton(page)).toHaveAttribute('aria-pressed', 'true');
    writeFileSync(releasePath, 'OK_TERMINAL_COMPLETED_628\n');
    await expect.poll(() => existsSync(acknowledgementPath), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(acknowledgementPath, 'utf8')).toContain('OK_TERMINAL_COMPLETED_628');
    expect((await page.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(ptyId);

    await headerPaneButton(page, 'Terminal').click();
    await expect(terminalSection(page)).toBeVisible();
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('OK_TERMINAL_COMPLETED_628');
    expect((await readTerminalRows(page)).split('OK_TERMINAL_COMPLETED_628')).toHaveLength(2);
    await typeInTerminal(
      page,
      `${SHELL_COMMANDS.readEnvironment('OK_RESPONSIVE_SHELL', 'after')}\r`,
    );
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('after=[OK_SHELL_SURVIVED_628]');

    expect(await clickViewTerminalItem(app, page)).toBe('Hide Terminal');
    await expect(terminalSection(page)).toBeHidden();
    expect((await page.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(ptyId);
    await headerPaneButton(page, 'Terminal').click();
    await expect(terminalSection(page)).toBeVisible();
    await widenEditorWindow(app, page, 1000, 700);
    await expect(terminalSection(page)).toBeVisible();
    await expect.poll(() => restoredDockState(page)).toMatchObject({ terminalVisible: true });
    expect((await page.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(ptyId);
    expect((await readTerminalRows(page)).split('OK_TERMINAL_COMPLETED_628')).toHaveLength(2);
    await typeInTerminal(page, `${SHELL_COMMANDS.columns('WIDE_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/WIDE_COLS=\d+/);
    const wideColumns = Number((await readTerminalText(page)).match(/WIDE_COLS=(\d+)/)?.[1]);
    expect(wideColumns).toBeGreaterThan(narrowColumns);
  });

  test('the header pane buttons follow the View and Terminal menus', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('header-menus', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    const terminalTabs = page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');

    await expectHeaderPanes(page, { Agents: false, Terminal: false }, 20_000);
    expect(await viewTerminalLabel(app)).toBe('Show Terminal');

    expect(await clickViewTerminalItem(app, page)).toBe('Show Terminal');
    await expectHeaderPanes(page, { Agents: false, Terminal: true });
    await waitForStatus(page, 'running', 25_000);
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');
    expect(await clickViewTerminalItem(app, page)).toBe('Hide Terminal');
    await expectHeaderPanes(page, { Agents: false, Terminal: false });

    await clickViewAgentsItem(app, page);
    await expectHeaderPanes(page, { Agents: true, Terminal: false });
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await viewMenuPaneLabels(app)).agents, { timeout: 8_000 })
      .toBe('Hide Agents');
    await clickViewAgentsItem(app, page);
    await expectHeaderPanes(page, { Agents: false, Terminal: false });

    await clickTerminalMenuItem(app, page, { label: 'New Terminal', action: 'new-terminal' });
    await expectHeaderPanes(page, { Agents: false, Terminal: true });
    await expect(terminalTabs).toHaveCount(2, { timeout: 15_000 });
    await clickTerminalMenuItem(app, page, { label: 'Kill Terminal', action: 'kill-terminal' });
    await expect(terminalTabs).toHaveCount(1, { timeout: 15_000 });
    await expectHeaderPanes(page, { Agents: false, Terminal: true });
    await clickTerminalMenuItem(app, page, { label: 'Kill Terminal', action: 'kill-terminal' });
    await expectHeaderPanes(page, { Agents: false, Terminal: false });
    await expect(terminalSection(page)).toBeHidden();

    if (process.platform !== 'darwin') {
      await clickInWindowViewTerminalItem(page);
      await expectHeaderPanes(page, { Agents: false, Terminal: true });
      await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');
      await clickInWindowViewTerminalItem(page);
      await expectHeaderPanes(page, { Agents: false, Terminal: false });
    }
  });

  test('narrow View menu Hide commands keep wide dock visibility while selecting Editor or Nothing Open', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('narrow-view-menu', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 900, 700);
    await expect(editorPaneButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => restoredDockState(page))
      .toMatchObject({
        editorVisible: true,
        agentPanelVisible: false,
        terminalVisible: false,
      });

    await widenEditorWindow(app, page, 720, 480);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(768);
    await headerPaneButton(page, 'Agents').click();
    await expectHeaderPanes(page, { Agents: true, Terminal: false });
    await expect.poll(async () => (await viewMenuPaneLabels(app)).agents).toBe('Hide Agents');
    await expect.poll(() => restoredDockState(page)).toMatchObject({ agentPanelVisible: false });

    await clickViewAgentsItem(app, page);
    await expect(editorPaneButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expectHeaderPanes(page, { Agents: false, Terminal: false });
    await expect.poll(() => restoredDockState(page)).toMatchObject({ agentPanelVisible: false });

    await clickViewEditorItem(app, page);
    await expect(page.getByRole('region', { name: 'Nothing open' })).toBeVisible();
    await expect.poll(() => viewMenuEditorLabel(app)).toBe('Show Editor');
    await expect.poll(() => restoredDockState(page)).toMatchObject({ editorVisible: true });

    await clickViewEditorItem(app, page);
    await expect(editorPaneButton(page)).toHaveAttribute('aria-pressed', 'true');
    await headerPaneButton(page, 'Terminal').click();
    await expectHeaderPanes(page, { Agents: false, Terminal: true });
    await waitForStatus(page, 'running', 25_000);
    await expect.poll(() => viewTerminalLabel(app)).toBe('Hide Terminal');
    await expect.poll(() => restoredDockState(page)).toMatchObject({ terminalVisible: false });
    await clickViewTerminalItem(app, page);
    await expect(editorPaneButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expectHeaderPanes(page, { Agents: false, Terminal: false });
    await expect.poll(() => restoredDockState(page)).toMatchObject({ terminalVisible: false });
    await widenEditorWindow(app, page, 900, 700);
    await expectHeaderPanes(page, { Agents: false, Terminal: false });
    await expect
      .poll(() => restoredDockState(page))
      .toMatchObject({
        editorVisible: true,
        agentPanelVisible: false,
        terminalVisible: false,
      });
  });

  test('the header hides Terminal while the project has it turned off and restores it on enable', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('header-opt-out', { optOut: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await expect(headerPaneButton(page, 'Agents')).toBeVisible({ timeout: 20_000 });
    await expect(headerPaneButton(page, 'Terminal')).toHaveCount(0, { timeout: 15_000 });

    await revealTerminalSurface(app, page.getByRole('region', { name: 'Terminal disabled' }));
    const enableTerminal = page.getByRole('button', { name: 'Enable terminal' });
    await expect(enableTerminal).toBeVisible();
    await expect(headerPaneButton(page, 'Terminal')).toHaveCount(0);

    await page.evaluate(() => Reflect.set(window, '__okHeaderSameDocument', true));
    await enableTerminal.click();
    await expect(headerPaneButton(page, 'Terminal')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 15_000,
    });
    expect(await page.evaluate(() => Reflect.get(window, '__okHeaderSameDocument'))).toBe(true);
    await waitForStatus(page, 'running', 25_000);
  });

  test('header show and hide survive a relaunch on the same profile', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(300_000);
    const s = seed('header-relaunch', { consent: true });
    track(s.tmpHome, s.projectDir);
    const launchOnProfile = async (): Promise<{ app: ElectronApplication; page: Page }> => {
      const app = await launchApp(s, { restrictPath: true });
      captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
      return { app, page: await findEditorWindow(app) };
    };
    const quitAfterMenuReads = async (
      app: ElectronApplication,
      labels: { agents: string; terminal: string },
    ): Promise<void> => {
      await expect.poll(() => viewMenuPaneLabels(app), { timeout: 8_000 }).toEqual(labels);
      await closeAppForRelaunch(app);
    };

    const first = await launchOnProfile();
    await expectHeaderPanes(first.page, { Agents: false, Terminal: false }, 20_000);
    await headerPaneButton(first.page, 'Terminal').click();
    await headerPaneButton(first.page, 'Agents').click();
    await expectHeaderPanes(first.page, { Agents: true, Terminal: true });
    await quitAfterMenuReads(first.app, { agents: 'Hide Agents', terminal: 'Hide Terminal' });

    const second = await launchOnProfile();
    await expectHeaderPanes(second.page, { Agents: true, Terminal: true }, 25_000);
    await expect(terminalSection(second.page)).toBeVisible();
    await expect(second.page.locator('#agents-column')).toBeVisible();
    await headerPaneButton(second.page, 'Agents').click();
    await expectHeaderPanes(second.page, { Agents: false, Terminal: true });
    await quitAfterMenuReads(second.app, { agents: 'Show Agents', terminal: 'Hide Terminal' });

    const third = await launchOnProfile();
    await expect(headerPaneButton(third.page, 'Terminal')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 25_000,
    });
    await expect(headerPaneButton(third.page, 'Agents')).toHaveAttribute('aria-pressed', 'false');
    await expectCollapsedRailColumn(third.page, '#agents-column');
    await headerPaneButton(third.page, 'Agents').click();
    await headerPaneButton(third.page, 'Terminal').click();
    await expectHeaderPanes(third.page, { Agents: true, Terminal: false });
    await quitAfterMenuReads(third.app, { agents: 'Hide Agents', terminal: 'Show Terminal' });

    const fourth = await launchOnProfile();
    await expect(headerPaneButton(fourth.page, 'Agents')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 25_000,
    });
    await expect(headerPaneButton(fourth.page, 'Terminal')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(terminalSection(fourth.page)).toBeHidden();
  });

  test('a hidden editor survives a relaunch, and the View menu hides and shows it', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const s = seed('editor-relaunch', { consent: true });
    track(s.tmpHome, s.projectDir);
    const launchOnProfile = async (): Promise<{ app: ElectronApplication; page: Page }> => {
      const app = await launchApp(s, { restrictPath: true });
      captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
      return { app, page: await findEditorWindow(app) };
    };

    const first = await launchOnProfile();
    await expect(editorPaneButton(first.page)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 20_000,
    });
    await expect.poll(() => viewMenuEditorLabel(first.app), { timeout: 8_000 }).toBe('Hide Editor');
    await clickViewEditorItem(first.app, first.page);
    await expect(editorPaneButton(first.page)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => viewMenuEditorLabel(first.app), { timeout: 8_000 }).toBe('Show Editor');
    await closeAppForRelaunch(first.app);

    const second = await launchOnProfile();
    await expect
      .poll(() => restoredDockState(second.page), { timeout: 25_000 })
      .toMatchObject({ editorVisible: false });
    await expect(editorPaneButton(second.page)).toHaveAttribute('aria-pressed', 'false', {
      timeout: 25_000,
    });
    await expect(second.page.getByRole('region', { name: 'Nothing open' })).toBeVisible();
    await expect
      .poll(() => viewMenuEditorLabel(second.app), { timeout: 8_000 })
      .toBe('Show Editor');
    await clickViewEditorItem(second.app, second.page);
    await expect(editorPaneButton(second.page)).toHaveAttribute('aria-pressed', 'true');
    await closeAppForRelaunch(second.app);

    const third = await launchOnProfile();
    await expect(editorPaneButton(third.page)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 25_000,
    });
    await expect(third.page.getByRole('region', { name: 'Nothing open' })).toHaveCount(0);
  });
});
