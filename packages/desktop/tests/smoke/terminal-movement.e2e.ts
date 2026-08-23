import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { PTY_PLATFORM_SKIP_REASON, PTY_PLATFORM_SUPPORTED } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';

const TARGET = resolveDesktopTarget();
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

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
  writeFileSync(join(tmpHome, '.zprofile'), 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"\n');
  writeFileSync(join(tmpHome, '.zshrc'), 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"\n');

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
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
        HOME: s.tmpHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        SHELL: '/bin/zsh',
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 25_000): Promise<Page> {
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
    throw new Error('no editor window yet');
  }).toPass({ timeout: timeoutMs });
  if (!page) throw new Error('editor window vanished after readiness poll');
  return page;
}

/**
 * `editorPage` lets a caller that already holds the editor window skip the
 * rediscovery poll. That poll is not free: it re-evaluates
 * `window.okDesktop.config.mode` in the renderer, so it costs whatever the
 * renderer's main thread is busy with, measured at ~400ms on a loaded CI
 * runner. Any caller TIMING this dispatch must pass the page, or it charges the
 * app for the harness's own round trip. On darwin the menu click happens inside
 * main and never pays it at all, so leaving it in makes the same assertion mean
 * two different things per platform.
 */
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

async function clickViewTerminalItem(app: ElectronApplication): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction(app, 'toggle-terminal');
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

async function clickTerminalPlacementItem(
  app: ElectronApplication,
  editorPage?: Page,
): Promise<void> {
  if (process.platform !== 'darwin') {
    await dispatchRendererMenuAction(app, 'move-terminal', editorPage);
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
  editorPage?: Page,
): Promise<void> {
  if (process.platform !== 'darwin') {
    for (let index = 0; index < count; index += 1) {
      // The page matters most here: without it each of these iterations pays
      // its own rediscovery poll, and the settlement being timed spans all of
      // them.
      await dispatchRendererMenuAction(app, 'move-terminal', editorPage);
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
const terminalTabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');

/**
 * Widen the editor window and PROVE the width stuck.
 *
 * `setSize` past the display's work area is honored in the renderer for a beat
 * and then clamped back, and a bare `innerWidth >= n` poll happily catches that
 * beat. The assertions below then measure a window that has since shrunk and
 * blame the app: a right column squeezed to its drag floor reads as a lost
 * width, and `Math.abs(rendered - restored) < 20` fails by hundreds of pixels.
 * Sampling until the width settles is what makes the precondition real; a
 * display that cannot hold the window skips, the same way the suite skips a
 * platform without a PTY.
 */
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
    // Only a display that genuinely cannot hold the window earns a skip. On one
    // that can, a window settling short is the app mis-sizing itself, and
    // calling that "your display is too small" would bury a real regression
    // under a reason that is not true.
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
    // A prior dispatch can land between attempts; observe first so a retry cannot hide it again.
    if (await terminal.isVisible()) return;
    await clickViewTerminalItem(app);
    await expect(terminal).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 15_000 });
  await expect(terminal.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
  // `running` means the PTY spawned, not that the shell has reached its read
  // loop. Typing before it does swallows the keystrokes.
  await waitForShellReady(() => readActiveTerminal(page));
}

async function openBareTab(page: Page): Promise<void> {
  await page.getByTestId('terminal-new-chat-menu').click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await expect(visibleTerminal(page).locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
  // `running` means the PTY spawned, not that the shell has reached its read
  // loop. Typing before it does swallows the keystrokes.
  await waitForShellReady(() => readActiveTerminal(page));
}

async function typeInActiveTerminal(page: Page, text: string): Promise<void> {
  await visibleTerminal(page).locator('.xterm').click();
  await page.keyboard.type(text);
}

async function readActiveTerminal(page: Page): Promise<string> {
  return visibleTerminal(page).evaluate((section) => {
    const accessibility = section.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = section.querySelector('.xterm-rows')?.textContent ?? '';
    return `${accessibility}\n${rows}`;
  });
}

/**
 * Scroll the active terminal's scrollback until every marker is on screen at
 * once — the proof that the lines survived whatever just happened to the panel.
 *
 * Reads `.xterm-rows` ONLY. The `.xterm-accessibility` node beside it is
 * xterm's screen-reader announcement buffer, NOT scrollback: under a burst it
 * collapses to "Too much output to announce, navigate to rows manually to read"
 * and truncates whatever it was mid-way through, token included. Reading it as
 * retained output is what failed this assertion on a loaded runner while the
 * terminal itself was perfectly healthy — the sentinel was found in the
 * announcement buffer, and the line printed right after it had been cut in
 * half there and was not yet scrolled into the rows.
 *
 * Steps are deliberately shorter than one wheel-page for the same reason:
 * markers on adjacent lines must not be able to straddle a step boundary and
 * so never appear together.
 */
async function expectScrollbackRetains(page: Page, ...markers: string[]): Promise<void> {
  const terminal = visibleTerminal(page).locator('.xterm');
  await terminal.hover();
  const readRows = () =>
    visibleTerminal(page).evaluate(
      (section) => section.querySelector('.xterm-rows')?.textContent ?? '',
    );

  let text = await readRows();
  for (let step = 0; step < 40 && !markers.every((marker) => text.includes(marker)); step += 1) {
    await page.mouse.wheel(0, -500);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    text = await readRows();
  }
  for (const marker of markers) {
    expect(text, `terminal scrollback is missing ${marker}`).toContain(marker);
  }
}

function waitForTerminalHome(page: Page, home: TerminalHome): Promise<number> {
  return page.evaluate((targetHome) => {
    return new Promise<number>((resolve, reject) => {
      const startedAt = performance.now();
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
          resolve(performance.now() - startedAt);
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
): Promise<number> {
  const settlement = waitForTerminalHome(page, home);
  // The stopwatch is already running inside the renderer, so the dispatch must
  // not re-discover the window on the clock.
  await clickTerminalPlacementItem(app, page);
  return settlement;
}

/**
 * The live shell's pid, read from the terminal ROWS alone.
 *
 * Every other reader here substring-matches a whole marker, so xterm's
 * `.xterm-accessibility` announcement buffer can only ever delay them — a
 * truncated prefix never satisfies a `toContain`. This one PARSES, which makes
 * truncation dangerous rather than merely slow: a `MARKER=67818` cut short in
 * the announcement buffer yields `67`, which clears the `toBeGreaterThan(0)`
 * gate and then gets compared against the real pid as proof the session
 * survived a move. Rows carry no such truncation.
 */
async function readShellPid(page: Page, marker: string): Promise<number> {
  await typeInActiveTerminal(page, `printf '${marker}=%s\\n' "$$"\r`);
  let processId = 0;
  await expect
    .poll(
      async () => {
        const rows = await visibleTerminal(page).evaluate(
          (section) => section.querySelector('.xterm-rows')?.textContent ?? '',
        );
        const matches = [...rows.matchAll(new RegExp(`${marker}=(\\d+)`, 'g'))];
        processId = Number(matches.at(-1)?.[1] ?? 0);
        return processId;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return processId;
}

async function growRightTerminal(page: Page, deltaPx: number): Promise<number> {
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
  await expect
    .poll(() => column.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(before + deltaPx / 2);
  return column.evaluate((element) => element.getBoundingClientRect().width);
}

async function expectCollapsedRailColumn(page: Page, selector: string): Promise<void> {
  const column = page.locator(selector);
  await expect(column).toHaveCount(1);
  await expect
    .poll(() => column.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(0);
}

test.describe('Terminal placement continuity — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('moving a populated terminal preserves every live session', async ({ captureStderrFor }) => {
    // The static calibration parser totals 225s of sequential condition
    // budgets; the 240s outer budget leaves 15s for untimed interaction work.
    test.setTimeout(240_000);
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);

    await openTerminal(app, page);
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const token = randomUUID().replaceAll('-', '');
    const processMarker = `PROCESS_${token}`;
    const sentinel = `SENTINEL_${token}`;
    const scrollStart = `SCROLL_START_${token}`;
    const processId = await readShellPid(page, processMarker);
    await typeInActiveTerminal(
      page,
      `printf '${sentinel}\\n${scrollStart}\\n'; i=1; while [ "$i" -le 120 ]; do printf 'SCROLL_${token}_%03d\\n' "$i"; i=$((i+1)); done\r`,
    );
    await expect
      .poll(() => readActiveTerminal(page), { timeout: 15_000 })
      .toContain(`SCROLL_${token}_120`);
    await expectScrollbackRetains(page, sentinel, scrollStart);

    const toRightMs = await moveTerminal(app, page, 'right');
    expect(toRightMs).toBeLessThan(300);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectScrollbackRetains(page, sentinel, scrollStart);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rightOutput = `RIGHT_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `printf '${rightOutput}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rightOutput);

    await expectScrollbackRetains(page, sentinel, scrollStart);
    const toBottomMs = await moveTerminal(app, page, 'bottom');
    expect(toBottomMs).toBeLessThan(300);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectScrollbackRetains(page, sentinel, scrollStart);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const bottomOutput = `BOTTOM_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `printf '${bottomOutput}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(bottomOutput);

    const rapidSettlement = waitForTerminalHome(page, 'right');
    await clickTerminalPlacementItemRapidly(app, 7, page);
    expect(await rapidSettlement).toBeLessThan(300);
    await expect(page.locator('section[aria-label="Terminal"]')).toHaveCount(2);
    await expect(visibleTerminal(page)).toHaveCount(1);
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toHaveCount(2);
    await expect(page.locator('#terminal-dock-panel section[aria-label="Terminal"]')).toHaveCount(
      0,
    );
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rapidOutput = `RAPID_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `printf '${rapidOutput}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rapidOutput);
    await expectScrollbackRetains(page, sentinel, scrollStart);
  });

  test('renderer restart restores the right layout and its live active terminal', async ({
    captureStderrFor,
  }) => {
    // The static calibration parser totals 255s across both reload cycles;
    // the 270s outer budget leaves 15s for untimed interaction work.
    test.setTimeout(270_000);
    const s = seed({ skipRestoreState: true });
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);

    await openTerminal(app, page);
    await openBareTab(page);
    const token = randomUUID().replaceAll('-', '');
    const processMarker = `RESTART_PROCESS_${token}`;
    const processId = await readShellPid(page, processMarker);
    const beforeRestart = `BEFORE_RESTART_${token}`;
    await typeInActiveTerminal(page, `printf '${beforeRestart}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(beforeRestart);

    // This test owns restart persistence; the dedicated terminal-tabs smoke
    // owns pointer-drag behavior. Reordering in the bottom dock keeps this
    // setup independent of right-column overlay geometry.
    await visibleTerminal(page).locator('.xterm').click();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowLeft`);
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await moveTerminal(app, page, 'right');
    const restoredWidth = await growRightTerminal(page, 120);

    await expect
      .poll(async () => {
        return page.evaluate(() => localStorage.getItem('ok-terminal-placement-v1'));
      })
      .toBe('right');
    await expect
      .poll(async () => {
        const retainedWidth = await page.evaluate(() =>
          Number(localStorage.getItem('ok-terminal-right-width-v1')),
        );
        return Math.abs(retainedWidth - restoredWidth);
      })
      .toBeLessThan(20);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('#terminal-column')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#terminal-dock-panel')).toHaveCount(0);
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1'], { timeout: 25_000 });
    await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect
      .poll(async () => {
        const width = await page
          .locator('#terminal-column')
          .evaluate((element) => element.getBoundingClientRect().width);
        return Math.abs(width - restoredWidth);
      })
      .toBeLessThan(20);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const afterRestart = `AFTER_RESTART_${token}`;
    await typeInActiveTerminal(page, `printf '${afterRestart}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(afterRestart);

    await clickViewAgentsItem(app);
    await expect(page.locator('#agents-column')).toBeVisible({ timeout: 10_000 });
    // Shrinking always takes, so this direction needs no settle proof.
    const editorWindow = await app.browserWindow(page);
    await editorWindow.evaluate((windowHandle: unknown) => {
      const target = windowHandle as {
        setSize: (width: number, height: number, animate: boolean) => void;
      };
      target.setSize(900, 900, false);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(1000);
    await expectCollapsedRailColumn(page, '#agents-column');
    await page.evaluate(() => {
      window.okDesktop?.editor.notifyViewMenuStateChanged({ agentPanelVisible: true });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('#terminal-column')).toBeVisible({ timeout: 20_000 });
    await expectCollapsedRailColumn(page, '#agents-column');
    await expect(page.getByText('Agent panel closed to keep Terminal readable.')).toBeVisible();
    expect(await readShellPid(page, processMarker)).toBe(processId);
  });

  test('fresh and malformed layout state recover to a usable bottom terminal', async ({
    captureStderrFor,
  }) => {
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
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
    await typeInActiveTerminal(page, `printf '${output}\\n'\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(output);
  });
});
