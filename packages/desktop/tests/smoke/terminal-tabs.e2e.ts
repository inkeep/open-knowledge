/**
 * Multi-tab terminal live-Electron smoke. Drives the real
 * renderer + preload bridge + main + per-window utilityProcess hosting node-pty,
 * exercising the TAB surface the mocked dom tests cannot reach at real fidelity:
 *
 *   - a second tab spawns its OWN live node-pty shell (independent sessions);
 *   - closing a tab reaps only that tab's shell — the survivor stays interactive;
 *   - a manual rename pins over the program's OSC 0/2 title (the running shell
 *     sets a title; the user's custom name wins);
 *   - keyboard reorder (CmdOrCtrl+Shift+Left/Right) changes tab order, keeps
 *     each session's sticky number, and PRESERVES the moved tab's live shell + scrollback — the
 *     regression that shipped ("reorder resets my terminal"): reordering moved
 *     the panel's xterm container in the DOM, disrupting the running program.
 *
 * These seams are real-PTY + real-xterm: the dom tests mock TerminalGate, so a
 * shell that never spawns (the #2472 node-pty-bundling class) or an xterm that
 * resets on a DOM move is invisible below this rung. The dom tests pin the
 * deterministic half (TerminalDock.dom.test.tsx: panels stay in ordinal order on
 * reorder); this pins the live-session outcome.
 *
 * Skip gates mirror the sibling terminal smokes: opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * a PTY-capable platform, and the electron-vite build must exist
 * (out/main/index.js). Runs in local dev / the release gate. Not part of
 * `pnpm check`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from './_helpers/terminal-smoke-shell';
import {
  expectTerminalTabOrder,
  openBareTerminalTab,
  renameTerminalTab,
  terminalTabById,
  terminalTabIds,
  terminalTabRow,
  terminalTabs,
} from './_helpers/terminal-tabs.test-helper';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHELL_COMMANDS = terminalSmokeShellCommands();

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-tabs-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-tabs-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  // Pre-grant terminal consent so the shell spawns without the enable gate.
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  seedTerminalShellProfiles(tmpHome, { restrictPath: true });

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Terminal Tabs Smoke', lastOpenedAt: new Date().toISOString() },
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

async function launchApp(s: Seed): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${s.userDataDir}`, deepLink],
      timeout: 30_000,
      env: {
        ...process.env,
        // Restricted, system-only PATH: the New-chat carat opens a BARE shell
        // so no host `claude` install participates in the fixture.
        ...terminalSmokeEnvironment(s.tmpHome, { restrictPath: true }),
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

async function clickViewTerminalItem(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) throw new Error('application menu is unavailable');
    const view = menu.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) throw new Error('View menu is missing the required Terminal visibility item');
    item.click();
  });
}

// The active tab's panel is the only VISIBLE one — inactive panels are
// data-[state=inactive]:hidden (display:none) — so `:visible` targets the active
// session's <section> (and the status/xterm nested inside it) without assuming
// tab order. Scoping the status query WITHIN the visible section is what keeps it
// unambiguous once a second tab exists (each session mounts its own section +
// status via forceMount).
const visibleSection = (page: Page) => page.locator('section[aria-label="Terminal"]:visible');
/**
 * Open the dock and wait for the first session's shell to be running. The live
 * shell occasionally exits before reaching "running" on constrained hardware
 * (the documented terminal-smoke degradation) — retry the View toggle until a
 * running shell settles rather than fail on a transient exit.
 */
async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await expect(async () => {
    // Observe before acting: a queued dispatch from a previous attempt can land
    // between attempts, and a blind second toggle would hide the section again.
    // Only the CLICK is conditional — the assertions below still run, so a
    // section that came up without a live shell keeps retrying.
    if (!(await visibleSection(page).isVisible())) await clickViewTerminalItem(app);
    await expect(visibleSection(page)).toBeVisible({ timeout: 8_000 });
    await expect(visibleSection(page).locator('[data-terminal-status]')).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 8_000 },
    );
  }).toPass({ timeout: 40_000, intervals: [2_000] });
  await waitForShellReady(
    () => readActiveText(page),
    (command) => typeInActive(page, `${command}\r`),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

/**
 * `running` means the PTY spawned, not that the shell behind it has reached its
 * read loop — so the shell-ready wait is part of the contract here, not an
 * optional extra. Without it, keystrokes typed while the shell is still sourcing
 * profile scripts (macOS runners print the bash-to-zsh banner) are swallowed,
 * and the caller times out on a marker whose command never ran.
 */
async function waitActiveRunning(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(visibleSection(page)).toBeVisible({ timeout: 15_000 });
  await expect(visibleSection(page).locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: timeoutMs },
  );
  await waitForShellReady(
    () => readActiveText(page),
    (command) => typeInActive(page, `${command}\r`),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

/** Open a second (or further) tab running a BARE shell via the New-chat carat →
 *  "Terminal" pick. The new tab activates; wait for its shell to be running. */
async function openBareTab(page: Page): Promise<void> {
  await openBareTerminalTab(page, () => waitActiveRunning(page));
}

async function activateTab(tab: Locator): Promise<void> {
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Pointer-drag one tab onto another and drop. Mirrors the real dnd-kit gesture:
 * press on the source, exceed the PointerSensor's 8px activation distance, drag
 * over the target in steps, then release. Used to exercise the pointer path
 * (the keyboard chord is covered separately).
 */
async function dragTabOnto(page: Page, fromTab: Locator, toTab: Locator): Promise<void> {
  const from = await fromTab.boundingBox();
  const to = await toTab.boundingBox();
  if (!from || !to) throw new Error('terminal tab bounding box missing');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Cross the 8px activation threshold before moving to the target so the drag
  // actually lifts (a sub-8px move stays a click).
  await page.mouse.move(from.x + from.width / 2 + 14, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Type into the ACTIVE tab's xterm (its hidden helper textarea receives keys). */
async function typeInActive(page: Page, text: string): Promise<void> {
  await visibleSection(page).locator('.xterm').click();
  await page.keyboard.type(text);
}

/** Read the ACTIVE tab's rendered terminal text (a11y live region + rows). */
async function readActiveText(page: Page): Promise<string> {
  return visibleSection(page).evaluate((sec) => {
    const a11y = sec.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = sec.querySelector('.xterm-rows')?.textContent ?? '';
    return `${a11y}\n${rows}`;
  });
}

const cleanup: string[] = [];
function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Terminal tabs — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.afterEach(() => {
    for (const target of cleanup.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  test('a second tab spawns its own live shell (independent sessions)', async ({
    captureStderrFor,
  }) => {
    const s = seed('two-shells');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Tab 1: write a marker into its shell.
    await typeInActive(page, `${SHELL_COMMANDS.output('TAB1_ONLY_AAA')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('TAB1_ONLY_AAA');

    // Open a second bare tab — it gets its own PTY and becomes active.
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveCount(2);

    // Tab 2 is a distinct shell: it has never seen tab 1's marker, and its own
    // marker is independent.
    await typeInActive(page, `${SHELL_COMMANDS.output('TAB2_ONLY_BBB')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('TAB2_ONLY_BBB');
    expect(await readActiveText(page)).not.toContain('TAB1_ONLY_AAA');
  });

  test('closing a tab reaps only that shell; the survivor stays interactive', async ({
    captureStderrFor,
  }) => {
    const s = seed('close-one');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await openBareTab(page); // Terminal 1 + Terminal 2
    const [, survivingTabId] = await terminalTabIds(page);
    if (survivingTabId === undefined) throw new Error('second terminal tab was not created');

    // Close Terminal 1; Terminal 2 remains and its shell is still live.
    await terminalTabRow(page)
      .getByRole('button', { name: /^Close / })
      .first()
      .click();
    await expectTerminalTabOrder(page, [survivingTabId]);
    await waitActiveRunning(page);
    await typeInActive(page, `${SHELL_COMMANDS.output('SURVIVOR_CCC')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('SURVIVOR_CCC');
  });

  test('a manual rename pins over the program’s OSC title', async ({ captureStderrFor }) => {
    const s = seed('rename-pin');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Double-click the tab to rename it, commit with Enter.
    await terminalTabs(page).first().dblclick();
    const input = page.getByRole('textbox', { name: /^Rename/ });
    await input.fill('my build');
    await input.press('Enter');
    await expect(page.getByRole('tab', { name: 'my build' })).toBeVisible({ timeout: 5_000 });

    // The running shell now sets an OSC 0/2 title. With a custom label pinned,
    // the visible tab name must NOT change to the program title. Emit the OSC
    // title and a scrollback marker in one write: xterm parses the byte stream
    // in order, so once the marker is on screen the OSC title has definitely
    // been fed through xterm → onTitleChange. Waiting on that marker (instead of
    // a fixed sleep) is what keeps the pin assertion from passing vacuously — if
    // the OSC were slow, the challenge simply hasn't landed yet and we keep
    // polling rather than asserting into an empty window.
    await typeInActive(page, `${SHELL_COMMANDS.oscTitle('PROGRAM_TITLE_ZZZ', 'OSC_FED_QQQ')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('OSC_FED_QQQ');
    await expect(terminalTabs(page)).toHaveText(['my build']);
    await expect(page.getByRole('tab', { name: 'PROGRAM_TITLE_ZZZ' })).toHaveCount(0);
  });

  test('keyboard reorder changes order, keeps sticky numbers, and preserves the live shell', async ({
    captureStderrFor,
  }) => {
    const s = seed('reorder-survive');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Terminal 1: pin the live shell with an env marker (survives only in THIS
    // PTY process) and print a scrollback marker (survives only if the xterm is
    // not reset/cleared by the reorder).
    await typeInActive(page, `${SHELL_COMMANDS.setEnvironment('OK_TABMARK', 'SURVIVED_888')}\r`);
    await typeInActive(page, `${SHELL_COMMANDS.output('BEFORE_REORDER_DDD')}\r`);
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('BEFORE_REORDER_DDD');

    // Open a second tab, then re-activate Terminal 1 and focus its shell.
    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await activateTab(terminalTabById(page, firstTabId));
    await visibleSection(page).locator('.xterm').click();

    // CmdOrCtrl+Shift+Right moves the active tab (Terminal 1) one slot right.
    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowRight`);

    // Order changed; the sticky numbers rode with their sessions (NOT renumbered
    // by position).
    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    // ConPTY can replace default labels with OSC shell titles on Windows.
    if (process.platform !== 'win32') {
      await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);
    }

    // Terminal 1 is still the active tab and STILL THE SAME LIVE SHELL: the env
    // marker (same PTY) and the pre-reorder scrollback both survive. On the
    // pre-fix code the panel's xterm moved in the DOM and the running program
    // reset — here it is untouched.
    await expect(terminalTabById(page, firstTabId)).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('BEFORE_REORDER_DDD');
    await typeInActive(page, `${SHELL_COMMANDS.readEnvironment('OK_TABMARK', 'mk')}\r`);
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('mk=[SURVIVED_888]');
  });

  test('pointer-drag reorder changes order and preserves the live shell', async ({
    captureStderrFor,
  }) => {
    const s = seed('drag-survive');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Terminal 1: pin its live shell with an env marker + a scrollback marker.
    await typeInActive(
      page,
      `${SHELL_COMMANDS.setEnvironment('OK_DRAGMARK', 'DRAG_SURVIVED_444')}\r`,
    );
    await typeInActive(page, `${SHELL_COMMANDS.output('BEFORE_DRAG_EEE')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('BEFORE_DRAG_EEE');

    // Open a second tab, then DRAG Terminal 1 onto Terminal 2 with the pointer.
    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await dragTabOnto(page, terminalTabById(page, firstTabId), terminalTabById(page, secondTabId));

    // Order changed via the real drag; sticky numbers rode with their sessions.
    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    // ConPTY can replace default labels with OSC shell titles on Windows.
    if (process.platform !== 'win32') {
      await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);
    }

    // Terminal 1's shell is the SAME live session (env marker) with intact
    // scrollback (the pre-drag echo) — a pointer drag must not reset it either.
    await activateTab(terminalTabById(page, firstTabId));
    await visibleSection(page).locator('.xterm').click();
    expect(await readActiveText(page)).toContain('BEFORE_DRAG_EEE');
    await typeInActive(page, `${SHELL_COMMANDS.readEnvironment('OK_DRAGMARK', 'dm')}\r`);
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('dm=[DRAG_SURVIVED_444]');
  });

  test('a renderer reload preserves tab labels and order', async ({ captureStderrFor }) => {
    const s = seed('reload-preserve');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Keep one default label on POSIX to cover ordinal rehydration. ConPTY can
    // replace default labels with OSC titles, so Windows uses a durable custom
    // label for the same order assertion.
    await openBareTab(page);
    const [firstTabId, secondTabId] = await terminalTabIds(page);
    if (firstTabId === undefined || secondTabId === undefined) {
      throw new Error('two terminal tabs were not created');
    }
    await renameTerminalTab(page, terminalTabById(page, firstTabId), 'build');
    const secondLabel = process.platform === 'win32' ? 'shell' : 'Terminal 2';
    if (process.platform === 'win32') {
      await renameTerminalTab(page, terminalTabById(page, secondTabId), secondLabel);
    }
    await dragTabOnto(page, terminalTabById(page, firstTabId), terminalTabById(page, secondTabId));
    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);

    // Reload the renderer (⌘R). Main + the per-window PTY host — and the tab name
    // + order they now retain — survive the reload; the reloaded dock rehydrates
    // from main rather than resetting to positional creation order (the bug fixed).
    await page.reload();
    await expect(visibleSection(page)).toBeVisible({ timeout: 20_000 });
    await expect(terminalTabs(page)).toHaveText([secondLabel, 'build'], { timeout: 25_000 });
  });
});
