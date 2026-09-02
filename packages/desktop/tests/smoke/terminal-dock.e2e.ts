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
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';
import {
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
  writeFakeClaudeShim,
} from './_helpers/terminal-smoke-shell';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHELL_COMMANDS = terminalSmokeShellCommands();

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
  if (pathPrefix || opts.pinRestrictedPath) {
    seedTerminalShellProfiles(tmpHome, {
      ...(pathPrefix ? { pathPrefix } : {}),
      restrictPath: opts.pinRestrictedPath,
    });
  }

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
}

async function launchApp(s: Seed, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  return electron.launch(
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
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 25_000): Promise<Page> {
  let page: Page | undefined;
  await expect(async () => {
    for (const p of app.windows()) {
      const mode = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (mode === 'editor') {
        page = p;
        return;
      }
    }
    throw new Error('no editor window yet');
  }).toPass({ timeout: timeoutMs });
  if (!page) throw new Error('editor window vanished after readiness poll');
  return page;
}

async function dispatchRendererMenuAction(
  app: ElectronApplication,
  action: 'move-terminal' | 'toggle-agent-panel' | 'toggle-terminal',
  editorPage?: Page,
): Promise<void> {
  const page = editorPage ?? (await findEditorWindow(app));
  await page.evaluate(async (menuAction) => {
    const menu = window.okDesktop?.menu;
    if (!menu) throw new Error('renderer menu bridge is unavailable');
    await menu.dispatch({ kind: 'menu-action', action: menuAction });
  }, action);
}

async function clickViewTerminalItem(app: ElectronApplication, editorPage?: Page): Promise<string> {
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
    await dispatchRendererMenuAction(app, 'toggle-terminal', editorPage);
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

async function clickTerminalPlacementItem(app: ElectronApplication): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction(app, 'move-terminal');
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

async function clickViewAgentsItem(app: ElectronApplication): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction(app, 'toggle-agent-panel');
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

const terminalSection = (page: Page) => page.locator('section[aria-label="Terminal"]');
const terminalStatus = (page: Page) => page.locator('[data-terminal-status]');
const readinessBanner = (page: Page) => page.getByTestId('terminal-readiness-banner');

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
    await clickViewTerminalItem(app);
    await expect(target).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 15_000 });
}

async function expectCollapsedRailColumn(page: Page, selector: string): Promise<void> {
  const column = page.locator(selector);
  await expect(column).toHaveCount(1);
  await expect
    .poll(() => column.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(0);
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
  { foreground = 'shell' }: { foreground?: 'shell' | 'program' } = {},
): Promise<void> {
  await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', status, {
    timeout: timeoutMs,
  });
  if (status === 'running' && foreground === 'shell') {
    await waitForShellReady(
      () => readTerminalText(page),
      (command) => typeInTerminal(page, `${command}\r`),
      { resetTerminalInput: () => page.keyboard.press('Control+C') },
    );
  }
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
    const s = seed('default-on');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('QA-005 default-on spawns without writing terminal.enabled', async ({
    captureStderrFor,
  }) => {
    const s = seed('default-on-no-write');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const localCfg = join(s.projectDir, '.ok', 'local', 'config.yml');
    const persisted = existsSync(localCfg) ? readFileSync(localCfg, 'utf8') : '';
    expect(persisted).not.toMatch(/enabled:\s*true/);
  });

  test('QA-006 opted-out shows not-enabled notice; Enable re-enables the shell', async ({
    captureStderrFor,
  }) => {
    const s = seed('opt-out', { optOut: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

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
    const s = seed('toggle', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    expect(await viewTerminalLabel(app)).toBe('Show Terminal');
    await revealTerminalSurface(app, terminalSection(page));
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');

    await clickViewTerminalItem(app);
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');
  });

  test('native Terminal placement action follows the current home', async ({
    captureStderrFor,
  }) => {
    const s = seed('placement-menu', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    await findEditorWindow(app);

    expect(await terminalPlacementLabel(app)).toBe('Move Terminal to right');
    await clickTerminalPlacementItem(app);
    await expect
      .poll(() => terminalPlacementLabel(app), { timeout: 8_000 })
      .toBe('Move Terminal to bottom');

    await clickTerminalPlacementItem(app);
    await expect
      .poll(() => terminalPlacementLabel(app), { timeout: 8_000 })
      .toBe('Move Terminal to right');
  });

  test('Terminal header placement is symmetric and clears the Agents reveal tab', async ({
    captureStderrFor,
  }) => {
    const s = seed('header-placement', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await widenEditorWindow(app, page, 1900, 900);
    await openTerminal(app, page);

    const moveRightButton = page.getByRole('button', { name: 'Move Terminal to right' });
    await expect(moveRightButton).toBeVisible();
    await moveRightButton.click();
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });

    const moveBottomButton = page.getByRole('button', { name: 'Move Terminal to bottom' });
    const collapseButton = page.getByRole('button', { name: 'Collapse Terminal' });
    const revealAgentsButton = page.getByRole('button', { name: 'Open agents panel' });
    await expect(moveBottomButton).toBeVisible();
    await expect(collapseButton).toBeVisible();
    await expect(revealAgentsButton).toBeVisible();
    const [moveBottomBox, collapseBox, revealAgentsBox] = await Promise.all([
      moveBottomButton.boundingBox(),
      collapseButton.boundingBox(),
      revealAgentsButton.boundingBox(),
    ]);
    if (!moveBottomBox || !collapseBox || !revealAgentsBox) {
      throw new Error('terminal rail controls did not produce measurable geometry');
    }
    expect(
      Math.max(moveBottomBox.x + moveBottomBox.width, collapseBox.x + collapseBox.width),
    ).toBeLessThanOrEqual(revealAgentsBox.x);
  });

  test('a pointerleave mid-drag resizes the right column by the real delta, never collapsing it', async ({
    captureStderrFor,
  }) => {
    const s = seed('divider-pointerleave', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

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
    const s = seed('rail-admission', { consent: true, skipRestoreState: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await widenEditorWindow(app, page, 1900, 900);
    await openTerminal(app, page);
    await clickTerminalPlacementItem(app);
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });
    await clickViewAgentsItem(app);
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        page
          .locator('#terminal-column')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(739);
    await waitForStatus(page, 'running', 25_000);
    await typeInTerminal(page, `${SHELL_COMMANDS.columns('RAIL_COLS')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/RAIL_COLS=\d+/);
    const columns = (await readTerminalText(page)).match(/RAIL_COLS=(\d+)/)?.[1];
    expect(Number(columns)).toBeGreaterThanOrEqual(92);

    const editorWindow = await app.browserWindow(page);
    await editorWindow.evaluate((win: unknown) => {
      const target = win as { setSize: (width: number, height: number, animate: boolean) => void };
      target.setSize(900, 900, false);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(1000);
    await expectCollapsedRailColumn(page, '#agents-column');
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible();
    await expect(page.getByText('Agent panel closed to keep Terminal readable.')).toBeVisible();

    await clickViewAgentsItem(app);
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Terminal closed to make room for the agent panel.')).toBeVisible();
    await expectCollapsedRailColumn(page, '#terminal-column');

    await clickViewAgentsItem(app);
    await expectCollapsedRailColumn(page, '#agents-column');
    await expectCollapsedRailColumn(page, '#terminal-column');
  });

  test('QA-022 toggle reveals the dock within 2 seconds and mounts within 15 seconds', async ({
    captureStderrFor,
  }) => {
    const s = seed('perf', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await waitForRendererResponsive(page);

    const t0 = await page.evaluate(() => performance.now());
    expect(await clickViewTerminalItem(app, page)).toBe('Show Terminal');
    await page.waitForSelector('#terminal-dock-panel', {
      state: 'visible',
      timeout: 5_000,
    });
    const dockElapsed = await page.evaluate((start) => performance.now() - start, t0);
    expect(dockElapsed).toBeLessThan(2000);

    const mountBudgetMs = 15_000;
    await page.waitForSelector('section[aria-label="Terminal"]', {
      state: 'attached',
      timeout: mountBudgetMs * 2,
    });
    const mountElapsed = await page.evaluate((start) => performance.now() - start, t0);
    expect(mountElapsed).toBeLessThan(mountBudgetMs);
  });

  test('QA-003 shell starts at project root and runs commands', async ({ captureStderrFor }) => {
    const s = seed('cmd', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, `${SHELL_COMMANDS.cwd}\r`);
    const tail = basename(s.realProjectDir);
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toContain(tail);

    await typeInTerminal(page, `${SHELL_COMMANDS.output('OK_E2E_MARKER_123')}\r`);
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('OK_E2E_MARKER_123');
  });

  test('a window-resize storm keeps the shell responsive and settles the PTY at the fitted grid', async ({
    captureStderrFor,
  }) => {
    const s = seed('resize-storm', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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

  test('terminal tab strip exposes collapse without legacy dock chrome', async ({
    captureStderrFor,
  }) => {
    const s = seed('dock-controls', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await expect(page.getByRole('button', { name: 'Collapse Terminal' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: /Dock terminal to the/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Drag to dock the terminal' })).toHaveCount(0);
  });

  test('the terminal lives in the bottom panel, never in the right column', async ({
    captureStderrFor,
  }) => {
    const s = seed('dock-edges', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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
    const s = seed('a11y', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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
    const s = seed('escape', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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

    await clickViewTerminalItem(app);
    await expect.poll(focusInTerminal).toBe(false);
  });

  test('Ctrl+` collapses the dock from inside a focused terminal', async ({ captureStderrFor }) => {
    const s = seed('ctrl-backtick', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

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
    const s = seed('inert', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await ensureBottomDock(page);
    await page.locator('section[aria-label="Terminal"] .xterm').click();

    await clickViewTerminalItem(app);
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
    const s = seed('resize', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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

    await expect
      .poll(() => panel.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(heightBefore);

    const heightAfter = await panel.evaluate((el) => el.getBoundingClientRect().height);

    await expect
      .poll(() => page.evaluate(() => Number(localStorage.getItem('ok-terminal-height-v1') ?? 0)))
      .toBeGreaterThan(heightBefore);

    await clickViewTerminalItem(app);
    await expect(panel).toHaveAttribute('inert', '', { timeout: 10_000 });
    await clickViewTerminalItem(app);
    await expect(terminalSection(page)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => {
        const heightReopen = await panel.evaluate((el) => el.getBoundingClientRect().height);
        return Math.abs(heightReopen - heightAfter);
      })
      .toBeLessThan(40);
  });

  test('QA-015/032 shell exit shows restart; banner hidden on exit', async ({
    captureStderrFor,
  }) => {
    const s = seed('exit', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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
    await typeInTerminal(page, `${SHELL_COMMANDS.output('RESTARTED_OK')}\r`);
    await expect.poll(() => readTerminalText(page), { timeout: 10_000 }).toContain('RESTARTED_OK');
  });

  test('QA-017 plain terminal stays quiet; missing Claude launch shows Get-Claude-Code banner', async ({
    captureStderrFor,
  }) => {
    const s = seed('claude-missing', { consent: true, pinRestrictedPath: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(readinessBanner(page)).toHaveCount(0);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { prompt: '', cli: 'claude', stage: false },
        }),
      );
    });

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('installed or on your PATH');
    await expect(page.getByRole('button', { name: 'Get Claude Code' })).toBeVisible();
  });

  test('QA-018 missing OK MCP entry shows Connect-tools affordance', async ({
    captureStderrFor,
  }) => {
    const s = seed('mcp-rewire', {
      consent: true,
      fakeClaudeOnPath: true,
      claudeJson: { mcpServers: { 'some-other': { command: 'noop' } } },
    });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(readinessBanner(page)).toHaveCount(0);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { prompt: '', cli: 'claude', stage: false },
        }),
      );
    });

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('OpenKnowledge tools');
    await page.getByRole('button', { name: 'Connect tools' }).click({ trial: true });
  });

  test('a renderer reload preserves the open terminal and its live session', async ({
    captureStderrFor,
  }) => {
    const s = seed('reload-survival', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
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
    test.setTimeout(200_000);
    const s = seed('stage', { consent: true, fakeClaudeTui: true, skipRestoreState: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

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

    expect(await clickViewTerminalItem(app)).toBe('Hide Terminal');
    await expect(terminalSection(page)).toBeHidden();
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');

    expect(await clickViewTerminalItem(app)).toBe('Show Terminal');
    await expect(terminalSection(page)).toBeVisible();
    await waitForStatus(page, 'running', 25_000, { foreground: 'program' });
    expect(await terminalTabs().count()).toBe(tabsAfterLaunch);
    expect(await readTerminalText(page)).toContain('Seed document');
    expect(await readTerminalText(page)).not.toContain('OKSTAGE_REUSE_742');
  });
});
