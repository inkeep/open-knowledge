/**
 * Multi-tab terminal live-Electron smoke. Drives the real
 * renderer + preload bridge + main + per-window utilityProcess hosting node-pty,
 * exercising the TAB surface the mocked dom tests cannot reach at real fidelity:
 *
 *   - a second tab spawns its OWN live node-pty shell (independent sessions);
 *   - closing a tab reaps only that tab's shell — the survivor stays interactive;
 *   - a manual rename pins over the program's OSC 0/2 title (the running shell
 *     sets a title; the user's custom name wins);
 *   - keyboard reorder (⌘⇧←/→) changes tab order, keeps each session's sticky
 *     number, and PRESERVES the moved tab's live shell + scrollback — the
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
 * darwin-only, the electron-vite build must exist (out/main/index.js), and
 * CI-quarantined (the live-Electron terminal surface degrades on the constrained
 * runner — allowlisted in the CI no-skip guard, not hidden). Runs in local dev /
 * the release gate. Not part of `bun run check`.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

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

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
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
  // Restricted, system-only PATH: the New-chat carat opens a BARE shell (the
  // "Terminal" pick) so no `claude` install is needed to spawn a live PTY.
  const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${s.userDataDir}`, deepLink],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: s.tmpHome,
      PATH,
      OK_DESKTOP_E2E_SMOKE: '1',
      OK_RECLAIM_DISABLE: '1',
    },
  });
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
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    item?.click();
  });
}

// The active tab's panel is the only VISIBLE one — inactive panels are
// data-[state=inactive]:hidden (display:none) — so `:visible` targets the active
// session's <section> (and the status/xterm nested inside it) without assuming
// tab order. Scoping the status query WITHIN the visible section is what keeps it
// unambiguous once a second tab exists (each session mounts its own section +
// status via forceMount).
const visibleSection = (page: Page) => page.locator('section[aria-label="Terminal"]:visible');
// Scope to the terminal strip's own tablist — the editor sidebar also renders
// role="tab" (Outline / Links / Graph / Timeline), so an unscoped query is
// ambiguous.
const terminalTabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');

/**
 * Open the dock and wait for the first session's shell to be running. The live
 * shell occasionally exits before reaching "running" on constrained hardware
 * (the documented terminal-smoke degradation) — retry the View toggle until a
 * running shell settles rather than fail on a transient exit.
 */
async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await expect(async () => {
    await clickViewTerminalItem(app);
    await expect(visibleSection(page)).toBeVisible({ timeout: 8_000 });
    await expect(visibleSection(page).locator('[data-terminal-status]')).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 8_000 },
    );
  }).toPass({ timeout: 40_000, intervals: [2_000] });
}

async function waitActiveRunning(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(visibleSection(page)).toBeVisible({ timeout: 15_000 });
  await expect(visibleSection(page).locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: timeoutMs },
  );
}

/** Open a second (or further) tab running a BARE shell via the New-chat carat →
 *  "Terminal" pick. The new tab activates; wait for its shell to be running. */
async function openBareTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose CLI for new chat' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await waitActiveRunning(page);
}

async function activateTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/**
 * Pointer-drag one tab onto another and drop. Mirrors the real dnd-kit gesture:
 * press on the source, exceed the PointerSensor's 8px activation distance, drag
 * over the target in steps, then release. Used to exercise the pointer path
 * (the keyboard chord is covered separately).
 */
async function dragTabOnto(page: Page, fromName: string, toName: string): Promise<void> {
  const from = await page.getByRole('tab', { name: fromName }).boundingBox();
  const to = await page.getByRole('tab', { name: toName }).boundingBox();
  if (!from || !to) throw new Error(`tab bounding box missing (${fromName} → ${toName})`);
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
  test.skip(!DARWIN, 'Desktop is darwin-only.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop".`);
  test.skip(
    IS_CI,
    'Quarantined on CI: the live-Electron terminal surface degrades on the constrained runner — see inkeep/agents-private#2187.',
  );

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
    await typeInActive(page, 'echo TAB1_ONLY_AAA\r');
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('TAB1_ONLY_AAA');

    // Open a second bare tab — it gets its own PTY and becomes active.
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);

    // Tab 2 is a distinct shell: it has never seen tab 1's marker, and its own
    // marker is independent.
    await typeInActive(page, 'echo TAB2_ONLY_BBB\r');
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

    // Close Terminal 1; Terminal 2 remains and its shell is still live.
    await page.getByRole('button', { name: 'Close Terminal 1' }).click();
    await expect(terminalTabs(page)).toHaveText(['Terminal 2']);
    await waitActiveRunning(page);
    await typeInActive(page, 'echo SURVIVOR_CCC\r');
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
    await page.getByRole('tab', { name: 'Terminal 1' }).dblclick();
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
    await typeInActive(page, "printf '\\033]0;PROGRAM_TITLE_ZZZ\\007'; echo OSC_FED_QQQ\r");
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
    await typeInActive(page, 'export OK_TABMARK=SURVIVED_888\r');
    await typeInActive(page, 'echo BEFORE_REORDER_DDD\r');
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('BEFORE_REORDER_DDD');

    // Open a second tab, then re-activate Terminal 1 and focus its shell.
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await activateTab(page, 'Terminal 1');
    await visibleSection(page).locator('.xterm').click();

    // ⌘⇧→ moves the active tab (Terminal 1) one slot right.
    await page.keyboard.press('Meta+Shift+ArrowRight');

    // Order changed; the sticky numbers rode with their sessions (NOT renumbered
    // by position).
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);

    // Terminal 1 is still the active tab and STILL THE SAME LIVE SHELL: the env
    // marker (same PTY) and the pre-reorder scrollback both survive. On the
    // pre-fix code the panel's xterm moved in the DOM and the running program
    // reset — here it is untouched.
    await expect(page.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await readActiveText(page)).toContain('BEFORE_REORDER_DDD');
    await typeInActive(page, 'echo "mk=[$OK_TABMARK]"\r');
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
    await typeInActive(page, 'export OK_DRAGMARK=DRAG_SURVIVED_444\r');
    await typeInActive(page, 'echo BEFORE_DRAG_EEE\r');
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('BEFORE_DRAG_EEE');

    // Open a second tab, then DRAG Terminal 1 onto Terminal 2 with the pointer.
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await dragTabOnto(page, 'Terminal 1', 'Terminal 2');

    // Order changed via the real drag; sticky numbers rode with their sessions.
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);

    // Terminal 1's shell is the SAME live session (env marker) with intact
    // scrollback (the pre-drag echo) — a pointer drag must not reset it either.
    await activateTab(page, 'Terminal 1');
    await visibleSection(page).locator('.xterm').click();
    expect(await readActiveText(page)).toContain('BEFORE_DRAG_EEE');
    await typeInActive(page, 'echo "dm=[$OK_DRAGMARK]"\r');
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('dm=[DRAG_SURVIVED_444]');
  });

  test('a renderer reload preserves custom names and tab order', async ({ captureStderrFor }) => {
    const s = seed('reload-preserve');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    // Two tabs: rename Terminal 1 -> "build", then reorder so Terminal 2 leads.
    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveText(['Terminal 1', 'Terminal 2']);
    await page.getByRole('tab', { name: 'Terminal 1' }).dblclick();
    const input = page.getByRole('textbox', { name: /^Rename/ });
    await input.fill('build');
    await input.press('Enter');
    await expect(terminalTabs(page)).toHaveText(['build', 'Terminal 2']);
    await dragTabOnto(page, 'build', 'Terminal 2');
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'build']);

    // Reload the renderer (⌘R). Main + the per-window PTY host — and the tab name
    // + order they now retain — survive the reload; the reloaded dock rehydrates
    // from main rather than resetting to positional creation order (the bug fixed).
    await page.reload();
    await expect(visibleSection(page)).toBeVisible({ timeout: 20_000 });
    await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'build'], { timeout: 25_000 });
  });
});
