import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, ElementHandle, Page } from '@playwright/test';
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
  seedTerminalShellProfiles(tmpHome, { restrictPath: true });

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
 * rediscovery poll. That poll re-evaluates `window.okDesktop.config.mode` in
 * the renderer, so it waits on whatever the renderer's main thread is busy
 * with. Any caller that has armed a settlement observer should pass the page:
 * the poll otherwise sits between arming and dispatch, widening the window the
 * observer has to survive for no reason the app is responsible for. On darwin
 * the menu click happens inside main and never pays it at all.
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
      // its own rediscovery poll, and the settlement being awaited spans all
      // of them.
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

/**
 * The rendered rows of the active terminal, and NOTHING else.
 *
 * Use this wherever being wrong about what is on screen would be wrong in the
 * ASSERTION's direction: anything checking a marker is ABSENT, and anything
 * PARSING what it reads. `readActiveTerminal`'s union with the announcement
 * buffer can only make those two fail — it holds lines the rows no longer show,
 * and it truncates mid-token under a burst.
 *
 * WAITING is the case that TOLERATES the union, which is why the waits
 * elsewhere in this file still use it — both the marker polls and the
 * shell-readiness wait. Extra content can only ever delay a wait, never satisfy
 * one wrongly: a stale line cannot contain a token that has not been printed.
 */
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
 * Pages with the keyboard, NOT the wheel. The panel sets
 * `smoothScrollDuration`, so a wheel notch does not move the rows — it
 * retargets an animation the renderer interpolates over the following frames,
 * and each further notch restarts that animation from wherever it had got to.
 * Reading straight after the last notch therefore reads a view still in flight,
 * and how far along it is depends on how many frames the runner could spare:
 * a made-up dependency on the machine for an assertion about retained lines.
 *
 * `Shift+PageUp` is animated too — `scrollPages` reaches the same viewport the
 * wheel does — so this does not escape the animation, it stops racing it. Each
 * press asks for one page rather than the wheel's several, then two animation
 * frames let xterm advance before the loop samples and presses again. Paging
 * past the top is inert, so the presses converge on the top instead of repeatedly
 * retargeting from a position that has not painted yet. The ceiling is several
 * times the pages either home needs to cross this fixture's scrollback, so it
 * bounds a stuck loop rather than the travel.
 */
async function expectScrollbackRetains(page: Page, ...markers: string[]): Promise<void> {
  // Focus the node xterm actually reads keys from. Clicking the row grid would
  // do it too, but a click lands on whatever the session last printed, and the
  // panel activates file links on a plain click — so the first path-shaped
  // token in this output would navigate the editor and take the focus that
  // every press below depends on.
  await visibleTerminal(page).locator('.xterm-helper-textarea').focus();
  let text = await readTerminalRows(page);
  for (let step = 0; step < 40 && !markers.every((marker) => text.includes(marker)); step += 1) {
    await page.keyboard.press('Shift+PageUp');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    text = await readTerminalRows(page);
  }
  for (const marker of markers) {
    expect(text, `terminal scrollback is missing ${marker}`).toContain(marker);
  }
  await settleScrollPosition(page);
}

/**
 * Wait until the rows stop moving.
 *
 * The paging above is animated, so the position after the last press is a
 * target rather than a fact — and this is the only thing in the file that
 * leaves the view mid-flight, which is why the settle lives here rather than at
 * whichever caller happens to resize next. A resize refits the grid against
 * whatever line the buffer shows AT THAT INSTANT, so a move taken mid-animation
 * shrinks from a position that varies run to run, and every assertion about
 * what the shrink did to the scrollback inherits that variance.
 *
 * Each sample sits behind an animation frame, so consecutive reads cannot all
 * land inside one paint and report a stillness that is really just a fast round
 * trip. Best-effort by design: if the rows never settle inside the bound, the
 * assertions that follow are what fail, and they say something about the
 * product rather than about the sampling.
 */
async function settleScrollPosition(page: Page): Promise<void> {
  let previous = '';
  let stable = 0;
  for (let step = 0; step < 60 && stable < 2; step += 1) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const current = await readTerminalRows(page);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
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
  // The observer is already armed inside the renderer, so the dispatch must not
  // re-discover the window before sending.
  await clickTerminalPlacementItem(app, page);
  await settlement;
}

/**
 * The live terminal surface, held so a later assertion can prove the SAME node
 * is what ended up at the other home. Follows `.xterm` rather than the section
 * wrapping it, so the node being tracked is the terminal itself.
 */
async function captureLiveTerminal(page: Page): Promise<ElementHandle<Element>> {
  const handle = await visibleTerminal(page).locator('.xterm').elementHandle();
  if (!handle) throw new Error('no visible Terminal surface to follow across the move');
  return handle;
}

/**
 * Moving the terminal must RE-PARENT the live surface, never tear it down and
 * build a fresh one at the other home. That is the property this file exists to
 * defend — a rebuilt surface is a dead PTY, a lost scrollback and a visible
 * stall — and following one node across the move states it outright.
 *
 * It stands where a wall-clock budget on the settlement used to, which could
 * only claim the property by proxy. That budget measured the harness as much as
 * the app: the observer arms in the renderer BEFORE the dispatch is sent, so
 * its number spanned a Playwright round trip and, on darwin, a main-process
 * menu click and its IPC too. Node identity does not move with how busy the
 * machine is.
 *
 * Nothing here bounds how LONG the move takes, deliberately: the only clock
 * this harness can read spans its own round trip to the renderer, so any number
 * it produces is partly a measurement of the runner. What remains is
 * `waitForTerminalHome`'s 5s rejection, which catches a move that never lands
 * rather than one that is merely slow — a move that became four seconds slower
 * would pass here. A budget worth having would have to be taken inside the app,
 * against a clock the harness does not sit on.
 */
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

/**
 * The live shell's pid, read from the terminal ROWS alone.
 *
 * This one PARSES rather than substring-matching a whole marker, which makes
 * the announcement buffer's truncation dangerous rather than merely slow: a
 * `MARKER=67818` cut short there yields `67`, which clears the
 * `toBeGreaterThan(0)` gate and is then compared against the real pid as proof
 * the session survived a move. Rows carry no such truncation.
 *
 * Which reader any given site wants is set out on `readTerminalRows`.
 */
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

/**
 * A move must not leave a scrolled-back reader at the bottom.
 *
 * Both callers reach this straight after `expectScrollbackRetains`, so the view
 * is parked back in the scrollback and the newest line is off screen. Any
 * restore that ends up at the bottom — the shape a scroll pair takes when its
 * second half is swallowed — puts that line back in view. That is the one
 * outcome distinguishable from a healthy move without asserting an exact
 * landing line the reflow is entitled to choose.
 *
 * Reads the ROWS. `readActiveTerminal` would fold in the announcement buffer,
 * which still holds the newest line from when it was printed, so an absence
 * assertion against it would contradict the presence assertion its own caller
 * just made.
 */
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
    // The static calibration parser totals 235s of sequential condition
    // budgets, which are worst-case ceilings rather than expected costs. The
    // 260s outer budget leaves 25s for everything the parser cannot see: the
    // Electron launch, every focus and keystroke, and the paging round trips.
    test.setTimeout(260_000);
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
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
    const processId = await readShellPid(page, processMarker);
    await typeInActiveTerminal(
      page,
      `${SHELL_COMMANDS.scroll(sentinel, scrollStart, `SCROLL_${token}_`, 120)}\r`,
    );
    await expect
      .poll(() => readActiveTerminal(page), { timeout: 15_000 })
      .toContain(`SCROLL_${token}_120`);
    await expectScrollbackRetains(page, sentinel, scrollStart);

    const liveSurface = await captureLiveTerminal(page);
    await moveTerminal(app, page, 'right');
    await expectTerminalMovedNotRebuilt(liveSurface, 'right');
    await expectStillScrolledBack(page, `SCROLL_${token}_120`);
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    // Content retention across the GROW, not reach: the view enters this move
    // at the top of the buffer, and growing 15 rows to 52 leaves almost nothing
    // above it for a broken restore to swallow. The shrink leg below is where
    // reach is actually exercised.
    await expectScrollbackRetains(page, sentinel, scrollStart);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const rightOutput = `RIGHT_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(rightOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(rightOutput);

    // The shrink is the leg that can lose reach: 52 rows down to 15 anchors the
    // newest visible line and lands tens of rows below the markers, so the
    // re-read after it has to page all the way back up.
    await expectScrollbackRetains(page, sentinel, scrollStart);
    await moveTerminal(app, page, 'bottom');
    await expectTerminalMovedNotRebuilt(liveSurface, 'bottom');
    await expectStillScrolledBack(page, `SCROLL_${token}_120`);
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
    await expectScrollbackRetains(page, sentinel, scrollStart);
    expect(await readShellPid(page, processMarker)).toBe(processId);
    const bottomOutput = `BOTTOM_OUTPUT_${token}`;
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(bottomOutput)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(bottomOutput);

    const rapidSettlement = waitForTerminalHome(page, 'right');
    await clickTerminalPlacementItemRapidly(app, 7, page);
    await rapidSettlement;
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
    await expectScrollbackRetains(page, sentinel, scrollStart);
  });

  test('renderer restart restores the right layout and its live active terminal', async ({
    captureStderrFor,
  }) => {
    // The static calibration parser totals 265s across both reload cycles,
    // which are worst-case ceilings rather than expected costs. The 290s outer
    // budget leaves 25s for the untimed interaction work between them.
    test.setTimeout(290_000);
    const s = seed({ skipRestoreState: true });
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await widenEditorWindow(app, page, 1900, 900);

    await openTerminal(app, page);
    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await renameTerminalTab(page, terminalTabById(page, firstTabId), 'restart first');
    // Preserve the default-ordinal reload assertion where shell titles are
    // stable; ConPTY can replace it with an OSC title on Windows.
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

    // This test owns restart persistence; the dedicated terminal-tabs smoke
    // owns pointer-drag behavior. Reordering in the bottom dock keeps this
    // setup independent of right-column overlay geometry.
    await visibleTerminal(page).locator('.xterm').click();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowLeft`);
    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    await expect(terminalTabById(page, secondTabId)).toHaveAttribute('aria-selected', 'true');
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
    await expect(terminalTabs(page)).toHaveText([secondLabel, 'restart first'], {
      timeout: 25_000,
    });
    await expect(page.getByRole('tab', { name: secondLabel })).toHaveAttribute(
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
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(afterRestart)}\r`);
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
    await typeInActiveTerminal(page, `${SHELL_COMMANDS.output(output)}\r`);
    await expect.poll(() => readActiveTerminal(page), { timeout: 15_000 }).toContain(output);
  });
});
