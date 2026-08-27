/**
 * Docked-terminal live-Electron smoke harness (the `_electron.launch()` rung
 * left to QA). Drives the real renderer + real
 * preload bridge + real main + the per-window utilityProcess hosting node-pty,
 * exercising the surfaces the mocked dom tests cannot reach: the View-menu
 * toggle, opt-out terminal consent (default-on; the shell is refused only on an
 * explicit `terminal.enabled === false`), a real PTY at the project root,
 * resize/persist, focus/inert a11y, exit + restart, and the claude-readiness
 * banner.
 *
 * Skip gates mirror the sibling smokes: opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * a PTY-capable platform, and the electron-vite build must exist
 * (out/main/index.js).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { PTY_PLATFORM_SKIP_REASON, PTY_PLATFORM_SUPPORTED } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

interface SeedOpts {
  /** Pre-grant consent by seeding .ok/local/config.yml terminal.enabled: true. */
  consent?: boolean;
  /** Explicitly opt out — seed .ok/local/config.yml terminal.enabled: false (the
   *  one state that refuses the shell under the default-on/opt-out model). */
  optOut?: boolean;
  /** Seed a ~/.claude.json in the test HOME (object) or omit (none). */
  claudeJson?: Record<string, unknown> | null;
  /** Put a fake executable `claude` on PATH (so the readiness probe resolves it). */
  fakeClaudeOnPath?: boolean;
  /** Like `fakeClaudeOnPath`, but the fake is a TUI stand-in that stays open
   *  reading stdin (`exec cat`), so bytes staged into the launched CLI's PTY are
   *  observable in xterm instead of landing in a post-exit shell. */
  fakeClaudeTui?: boolean;
  /** Skip the state.json last-project restore. A cold start then opens the
   *  window from the argv deep-link alone, routed to its `doc=` — the restore
   *  window otherwise wins the race and lands on the empty state with the
   *  deep-link's doc dropped. Needed by tests that drive the DOC EDITOR. */
  skipRestoreState?: boolean;
  /** Pin the login-shell PATH to the bare system dirs via the test HOME's rc
   *  files. `launchApp({ restrictPath })` alone is NOT enough for a
   *  "claude absent" premise: /etc/zprofile's `path_helper` re-adds
   *  /etc/paths.d dirs (incl. /opt/homebrew/bin, where a real `claude` cask
   *  may live) ahead of the restricted env PATH. */
  pinRestrictedPath?: boolean;
}

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
  /** Realpathed project root (macOS /var → /private/var) — what `pwd` prints. */
  realProjectDir: string;
  /** Extra PATH prefix (fake-claude bin dir) or null. */
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
    const claudeBin = join(binDir, 'claude');
    // The TUI variant still answers `--version` and exits (keeps any probe that
    // executes the binary from hanging on `cat`).
    writeFileSync(
      claudeBin,
      opts.fakeClaudeTui
        ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-fake"; exit 0; fi\necho FAKE_CLAUDE_TUI_READY\nexec cat\n'
        : '#!/bin/sh\necho "claude 0.0.0-fake"\n',
    );
    chmodSync(claudeBin, 0o755);
    pathPrefix = binDir;
    // The PTY runs `$SHELL -l -i`, whose /etc/zprofile `path_helper` REORDERS
    // PATH: /etc/paths + /etc/paths.d dirs (incl. /opt/homebrew/bin, where a
    // real `claude` cask may live) jump AHEAD of the env's fakebin prefix.
    // Re-prepend fakebin from the test HOME's own rc files — they source after
    // path_helper, so the fake wins deterministically in probe and PTY alike.
    const prepend = `export PATH="${binDir}:$PATH"\n`;
    writeFileSync(join(tmpHome, '.zprofile'), prepend);
    writeFileSync(join(tmpHome, '.zshrc'), prepend);
  } else if (opts.pinRestrictedPath) {
    // No fakebin: pin the bare system PATH after path_helper so a host-machine
    // claude (e.g. the /opt/homebrew/bin cask) cannot leak into the probe.
    const pin = 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"\n';
    writeFileSync(join(tmpHome, '.zprofile'), pin);
    writeFileSync(join(tmpHome, '.zshrc'), pin);
  }

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
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
  /** Replace PATH so the login-shell probe cannot find the host's real claude. */
  restrictPath?: boolean;
}

async function launchApp(s: Seed, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  // A clean, system-only PATH so the readiness probe's `command -v claude`
  // verdict is determined solely by the test's fakebin (not the dev's
  // ~/.local/bin). The fake-claude prefix, when present, is prepended.
  const basePath = opts.restrictPath ? '/usr/bin:/bin:/usr/sbin:/sbin' : (process.env.PATH ?? '');
  const PATH = s.pathPrefix ? `${s.pathPrefix}:${basePath}` : basePath;
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      // No --disable-gpu: blanket software rendering starves CPU on constrained CI
      // runners. Instead TerminalPanel forces xterm's DOM renderer (not WebGL) when
      // the e2eSmoke config flag is set (from OK_DESKTOP_E2E_SMOKE=1, below), so
      // these DOM-based assertions can read the terminal while Electron keeps GPU.
      args: [`--user-data-dir=${s.userDataDir}`, deepLink],
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: s.tmpHome,
        PATH,
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

/**
 * `editorPage` lets a caller that already holds the editor window skip the
 * rediscovery poll. That poll is not free: it re-evaluates
 * `window.okDesktop.config.mode` in the renderer, so it costs whatever the
 * renderer's main thread is busy with — measured at ~400ms on a loaded CI
 * runner. Any caller TIMING this dispatch must pass the page, or it charges
 * the app for the harness's own round trip.
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

/** Click the View → Show/Hide Terminal application-menu item (real toggle path
 *  on desktop — CmdOrCtrl+J is its OS-captured accelerator). Returns the item label.
 *  Pass `editorPage` when timing the toggle; see `dispatchRendererMenuAction`. */
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
// The editor page carries several app-wide role="status" nodes (SelectionAnnouncer,
// ConnectingBanner), so a bare getByRole('status') is ambiguous under Playwright
// strict mode. Scope the claude-readiness banner by its stable test seam instead.
const readinessBanner = (page: Page) => page.getByTestId('terminal-readiness-banner');

/**
 * Hold until the renderer's main thread is answering promptly, so a genuinely
 * un-booted app fails HERE with that name rather than as a puzzling downstream
 * timeout.
 *
 * This is a liveness check and nothing more. It is NOT a proxy for the renderer
 * having committed its first render, nor for main having registered the
 * window's project context: `findEditorWindow` resolves as soon as PRELOAD
 * answers, and preload answers from a document that has not finished loading,
 * so all three probes can clear inside the boot window. Measured on a failing
 * Linux run, the three round-trips cost 70ms total and cleared
 * 240ms after the window first became discoverable — the earlier claim that
 * three in a row "rules out catching a gap between two chunks of boot work"
 * was disproven by that trace. Ordering against main's state is main's job, not
 * this helper's.
 *
 * An idle renderer answers a round-trip in single-digit ms; 100ms is slack
 * rather than a budget.
 */
async function waitForRendererResponsive(page: Page): Promise<void> {
  await expect(async () => {
    for (let probe = 0; probe < 3; probe += 1) {
      const startedAt = Date.now();
      await page.evaluate(() => performance.now());
      expect(Date.now() - startedAt).toBeLessThan(100);
    }
    // 15s: the measured worst case for a loaded CI runner to reach a settled
    // renderer is under 5s. Past 15s the app is not slow, it is broken — and
    // failing HERE names that, instead of surfacing as a puzzling downstream
    // timeout.
  }).toPass({ timeout: 15_000, intervals: [250] });
}

/**
 * Widen the editor window and PROVE the width stuck.
 *
 * The rail tests below assert a layout the app only owes at the width they ask
 * for, so the width is a precondition rather than setup. `setSize` past the
 * display's work area is honored in the renderer for a beat and then clamped
 * back, and a bare `innerWidth >= n` poll happily catches that beat — after
 * which the assertions measure a narrower window and blame the app. On a 1512pt
 * laptop that reads as the right terminal column resolving to its 324px drag
 * floor instead of its 740px preferred width, which is CORRECT behavior for the
 * window it actually had.
 *
 * So: sample until the width settles, then check it settled where it was asked
 * to. A display that cannot hold the window SKIPS, the same way the suite skips
 * a platform without a PTY — it is a fact about the machine, not a verdict on
 * the app, and CI runners are wide enough that the coverage stays real. A
 * display that COULD have held it and did not FAILS, because that is the app
 * mis-sizing its own window and a skip would bury it.
 */
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

async function revealTerminalSurface(app: ElectronApplication, target: Locator): Promise<void> {
  await expect(async () => {
    // Observe before acting. A dispatch that arrived before the renderer had a
    // listener is QUEUED by the preload and replayed on subscribe, so a retry
    // fired while one is still in flight would land a SECOND toggle and hide
    // the surface this call was asked to reveal. This check is the actual
    // defence; the 5s inner window only makes a retry unlikely enough that the
    // outer budget still has attempts left when one is genuinely needed.
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

/** Open the dock (via the real menu toggle) and wait for the panel to mount. */
async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await revealTerminalSurface(app, terminalSection(page));
}

/**
 * Wait until the terminal panel has stopped resizing and the throttled PTY
 * resize behind it has had its window to land.
 *
 * The panel width is the observable half: it stops changing once the panel
 * group finishes reflowing. The PTY resize is coalesced behind a trailing
 * throttle in the renderer, so it lands after the final fit — the settle beat
 * covers that tail. Both matter because `tput cols` samples the winsize once,
 * when the shell evaluates it.
 */
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
  // Trailing PTY resize: the renderer coalesces on a ~100ms window, so give it
  // several windows plus IPC and SIGWINCH delivery before sampling the winsize.
  await page.waitForTimeout(500);
}

async function waitForStatus(page: Page, status: string, timeoutMs = 20_000): Promise<void> {
  await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', status, {
    timeout: timeoutMs,
  });
  // `running` means the PTY spawned, not that the shell has reached its read
  // loop. Typing before it does swallows the keystrokes.
  if (status === 'running') await waitForShellReady(() => readTerminalText(page));
}

/** Wait for the bottom terminal panel. The terminal owns the bottom edge outright
 *  now — there is no dock position to flip — so this only settles the panel. */
async function ensureBottomDock(page: Page): Promise<void> {
  await expect(page.locator('#terminal-dock-panel')).toBeVisible({ timeout: 10_000 });
}

/** Type into the focused xterm (its hidden helper textarea receives keys). */
async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(text);
}

/** Read all rendered terminal text (screen-reader live region + rows). */
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
      } catch {
        // best-effort
      }
    }
  });

  // First open of a never-chosen project mounts the live panel directly.
  // The consent model is opt-out (default-on): there is no just-in-time consent
  // dialog, so the panel mounts and the shell spawns with nothing gating it.
  test('QA-004 first open mounts the live panel (no consent dialog)', async ({
    captureStderrFor,
  }) => {
    const s = seed('default-on'); // terminal.enabled absent => default-on
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    // openTerminal waits on the panel section, so its return already proves the
    // panel mounted with no prompt in the way.
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    // The removed JIT consent dialog must not appear.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  // A plain first open spawns the shell but persists nothing: default-on
  // requires no stored grant, and a mere open never writes terminal.enabled.
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

    // A mere open persists no grant — default-on needs none (the inverse of the
    // old assumption that opening wrote enabled=true via a consent dialog).
    const localCfg = join(s.projectDir, '.ok', 'local', 'config.yml');
    const persisted = existsSync(localCfg) ? readFileSync(localCfg, 'utf8') : '';
    expect(persisted).not.toMatch(/enabled:\s*true/);
  });

  // An explicitly opted-out project (terminal.enabled: false) shows the
  // not-enabled notice instead of the panel; no shell spawns. Clicking "Enable
  // terminal" lifts the opt-out and the shell comes up.
  test('QA-006 opted-out shows not-enabled notice; Enable re-enables the shell', async ({
    captureStderrFor,
  }) => {
    const s = seed('opt-out', { optOut: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    // The opted-out gate renders the "Terminal disabled" region, NOT the panel
    // section — so openTerminal() (which waits on the panel) would never resolve.
    await revealTerminalSurface(app, page.getByRole('region', { name: 'Terminal disabled' }));
    await expect(page.getByRole('button', { name: 'Enable terminal' })).toBeVisible();
    // No PTY/panel in the opted-out state.
    await expect(terminalStatus(page)).toHaveCount(0);

    // Lift the opt-out: the panel mounts and the shell spawns.
    await page.getByRole('button', { name: 'Enable terminal' }).click();
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await waitForStatus(page, 'running', 25_000);
  });

  // View-menu toggle reveals/hides the panel and the label flips.
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
    await typeInTerminal(page, 'echo RAIL_COLS=$(tput cols)\r');
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/RAIL_COLS=\d+/);
    const columns = (await readTerminalText(page)).match(/RAIL_COLS=(\d+)/)?.[1];
    expect(Number(columns)).toBeGreaterThanOrEqual(92);

    // Shrinking always takes, so this direction needs no settle proof.
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

  // The menu-to-mount path stays responsive; the 150ms visual transition is
  // cosmetic and is not part of this assertion.
  test('QA-022 toggle mounts within 2 seconds', async ({ captureStderrFor }) => {
    const s = seed('perf', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    // Boot must be OVER before the stopwatch starts, or this budget is charged
    // for it: the dispatch and the mount are both serviced by the renderer's
    // main thread, so a thread still booting shows up as toggle latency.
    // Measured on a loaded Linux runner without this barrier: 1.6-2.0s of a
    // 3.3-4.0s "toggle" was the dispatch round-trip alone.
    await waitForRendererResponsive(page);

    const t0 = await page.evaluate(() => performance.now());
    // `page` is handed over so the non-darwin dispatch path does not re-discover
    // the editor window on the clock. That rediscovery is harness cost, and it
    // is why this budget read ~400ms higher on Linux than on macOS.
    await clickViewTerminalItem(app, page);
    // The section becomes present synchronously on the state flip.
    await page.waitForSelector('section[aria-label="Terminal"]', {
      state: 'attached',
      timeout: 5_000,
    });
    const elapsed = await page.evaluate((start) => performance.now() - start, t0);
    // Generous ceiling: IPC round-trip (menu→main→renderer) + synchronous flip.
    // The visual transition (150ms) is cosmetic; we measure mount, not animation.
    expect(elapsed).toBeLessThan(2000);
  });

  // Terminal opens at the project root and runs an arbitrary command.
  test('QA-003 shell starts at project root and runs commands', async ({ captureStderrFor }) => {
    const s = seed('cmd', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await typeInTerminal(page, 'pwd\r');
    const tail = s.realProjectDir.split('/').slice(-1)[0];
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toContain(tail);

    await typeInTerminal(page, 'echo OK_E2E_MARKER_123\r');
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('OK_E2E_MARKER_123');
  });

  // Resize storm at real-PTY fidelity: a section/window drag resizes the
  // terminal container on every pointer frame; the panel fits xterm per event
  // but coalesces the PTY resize (leading + trailing throttle), so a storm
  // must (1) never wedge the shell and (2) always settle the PTY at the final
  // fitted grid — a dropped trailing resize would leave the shell's winsize at
  // a mid-drag width. Chromium may reclaim a scrollbar-width sliver when the
  // window returns to its starting size, so the fitted grid can legitimately
  // differ by a couple of columns.
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

    await typeInTerminal(page, 'echo BEFORE_COLS=$(tput cols)\r');
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toMatch(/BEFORE_COLS=\d+/);
    const before = (await readTerminalText(page)).match(/BEFORE_COLS=(\d+)/)?.[1];

    // Real window resizes from main — each one reflows the panel group and
    // fires the terminal container's ResizeObserver, like a drag frame.
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

    // Let the storm settle BEFORE asking the shell how wide it is. Two things
    // are still in flight when the last `setSize` returns: the panel group is
    // reflowing (a window step can cross a responsive breakpoint, which swings
    // the terminal's width by far more than the step itself), and the PTY
    // resize is throttled, so the final one lands after the final fit.
    // `tput cols` is evaluated once, at the moment the shell runs it — ask too
    // early and a mid-storm width is baked into the output, and no amount of
    // re-reading the buffer afterwards can change it.
    await waitForTerminalWidthStable(page);

    // The shell still echoes (no wedged PTY, no dead renderer), and its
    // winsize settled back to the pre-storm width — the trailing throttled
    // resize landed. Polled: the trailing PTY resize lands within ~100ms of
    // the last step, but the storm's queued SIGWINCH redraws drain async.
    await typeInTerminal(page, 'echo AFTER_COLS=$(tput cols)\r');
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

  // Dock controls in the live build keep the explicit Terminal collapse name.
  // Placement now lives in the contextual/native actions, while the old direct
  // dock-toggle and drag grip stay gone.
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

  // The terminal is bottom-only now, and the agents panel owns the right column.
  // A live-build guard that the two never share an edge.
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
    // The right column is the agents panel's; no terminal ever renders there.
    await expect(page.locator('#agents-column section[aria-label="Terminal"]')).toHaveCount(0);
  });

  // Panel is a labeled region; xterm screen-reader mode + contrast set.
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

    // Implicit ARIA region via <section aria-label="Terminal">.
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    // screenReaderMode:true renders the .xterm-accessibility live tree.
    await expect(page.locator('section[aria-label="Terminal"] .xterm-accessibility')).toHaveCount(
      1,
    );
  });

  // Escape is delivered to the terminal (NOT swallowed): terminal apps
  // (vim, the `claude` TUI) need it. The no-keyboard-trap exit (WCAG 2.1.2) is
  // CmdOrCtrl+J — the View → Hide Terminal toggle — which collapses the dock
  // and returns focus to the editor.
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
    // Focus is inside the terminal section.
    await expect.poll(focusInTerminal).toBe(true);

    // Escape is NOT intercepted: focus stays in the terminal so the keystroke
    // reaches the PTY (vim / claude rely on it). The terminal does not "leave"
    // on Escape any more.
    await page.keyboard.press('Escape');
    await expect.poll(focusInTerminal).toBe(true);

    // The documented keyboard exit is CmdOrCtrl+J (here via its View-menu
    // accelerator): it collapses the dock and returns focus to the editor —
    // satisfying WCAG 2.1.2 without consuming Escape.
    await clickViewTerminalItem(app);
    await expect.poll(focusInTerminal).toBe(false);
  });

  // ⌃` is the dock's second chord and the only one the RENDERER delivers on
  // desktop — CmdOrCtrl+J is an OS-captured menu accelerator, and a menu item
  // may hold only one. That makes this the case no unit test can stand in for: the
  // listener is capture-phase on `window` precisely so a focused xterm's hidden
  // textarea cannot consume the chord first. If it ever regressed to bubble
  // phase, or the listener went back to skipping the desktop host, the dock
  // would become a keyboard trap for this chord — you could open it and never
  // close it without the mouse.
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

    // The chord under test, pressed with the pty holding focus.
    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');
    await expect.poll(focusInTerminal).toBe(false);

    // It toggles rather than open-only (VS Code / Zed convention), so the same
    // chord brings the dock back.
    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');
  });

  // Collapsed panel is inert and focus returns to the editor on collapse.
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

    // Collapse via the menu toggle.
    await clickViewTerminalItem(app);
    // The terminal panel becomes inert (removed from focus order) and focus
    // leaves it.
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

  // Drag resize persists across hide/reopen and clamps.
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

    // Drag the resize handle upward to grow the panel.
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

    // localStorage carries the persisted height.
    await expect
      .poll(() => page.evaluate(() => Number(localStorage.getItem('ok-terminal-height-v1') ?? 0)))
      .toBeGreaterThan(heightBefore);

    // Hide + reopen: reopens at the persisted (grown) height.
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

  // Shell exit shows a visible state + Restart respawns; the
  // readiness banner is hidden once the shell exits (no impossible state).
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
    // Visible exit alert + Restart control. The 'exited' status above is already
    // confirmed, so the notice renders on the next tick — a short ceiling is safe.
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5_000 });
    const restart = page.getByRole('button', { name: /Restart terminal/i });
    await expect(restart).toBeVisible();
    // No readiness banner alongside the exit notice (status!=='running').
    await expect(readinessBanner(page)).toHaveCount(0);

    // Restart spawns a fresh PTY at the same cwd.
    await restart.click();
    await waitForStatus(page, 'running', 25_000);
    await typeInTerminal(page, 'echo RESTARTED_OK\r');
    await expect.poll(() => readTerminalText(page), { timeout: 10_000 }).toContain('RESTARTED_OK');
  });

  // A plain terminal never asks about Claude. An explicit Claude launch still
  // surfaces the actionable not-found banner when the CLI is absent.
  test('QA-017 plain terminal stays quiet; missing Claude launch shows Get-Claude-Code banner', async ({
    captureStderrFor,
  }) => {
    // No fake claude, restricted PATH pinned past path_helper → probe resolves
    // not-found even when the host machine has a real claude cask.
    const s = seed('claude-missing', { consent: true, pinRestrictedPath: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    await expect(readinessBanner(page)).toHaveCount(0);

    // Drive the same window-scoped launch request emitted by the product's
    // Claude launchers. This creates a fresh Claude-targeting terminal tab and
    // crosses renderer → preload → main before the banner verdict renders.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { prompt: '', cli: 'claude', stage: false },
        }),
      );
    });

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // Apostrophe-free substring — the rendered copy uses a straight quote that an
    // i18n pass can restyle; assert the distinctive, stable part of the message.
    await expect(banner).toContainText('installed or on your PATH');
    await expect(page.getByRole('button', { name: 'Get Claude Code' })).toBeVisible();
  });

  // Claude present but OK MCP entry missing → Connect-tools affordance.
  test('QA-018 missing OK MCP entry shows Connect-tools affordance', async ({
    captureStderrFor,
  }) => {
    const s = seed('mcp-rewire', {
      consent: true,
      fakeClaudeOnPath: true,
      // ~/.claude.json present but WITHOUT an open-knowledge MCP server entry.
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
    // Apostrophe-free substring (same rationale as the not-found banner) — distinctive
    // to the MCP-rewire banner variant, which the 'Connect tools' affordance below confirms.
    await expect(banner).toContainText('OpenKnowledge tools');
    // Trial click, not `toBeVisible()`: this is the only tier with a real layout
    // engine, so it is the only one whose hit-target check can catch the button
    // being painted over by an overlay — `toBeVisible()` passes on a covered
    // element, and jsdom has no layout at all. `trial: true` runs the full
    // actionability sequence (attached / visible / stable / receives-events /
    // enabled) and then skips the dispatch, so it buys the occlusion signal
    // without invoking `rewireClaudeMcp` and dismissing the banner on the way
    // out, neither of which this test asserts anything about.
    await page.getByRole('button', { name: 'Connect tools' }).click({ trial: true });
  });

  // A renderer reload (View → Reload, or an OS resume-triggered reload) must
  // NOT lose the open terminal. The PTY survives in the main
  // process; the reloaded renderer must rehydrate the dock from it — same shell,
  // not a fresh spawn. This is the canonical reload-survival contract. It
  // RED-fails on origin/main, where the dock comes back collapsed/empty: the
  // renderer reads no surviving-session inventory on mount, so the live shell is
  // orphaned and the dock seeds nothing.
  //
  // Desktop-only — the dock renders only on the Electron host (it needs the real
  // preload bridge + the per-window PTY host), so this runs in a real desktop
  // Electron process (OK_DESKTOP_E2E_SMOKE=1), never headless. It is intentionally the
  // highest-fidelity rung for this fix; the renderer + main-process halves are
  // pinned headless in the reload-survival dom test and main-process test.
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

    // Mark the live shell's process state so we can prove the SAME shell survives:
    // an env var set here lives only in this exact PTY process, so a fresh spawn
    // after the reload would not carry it.
    await typeInTerminal(page, 'export OK_RELOAD_MARKER=OKRELOAD_SURVIVED_351\r');

    // The bug trigger: reload the renderer page. Main and the per-window PTY host
    // are untouched (a reload emits neither 'closed' nor 'will-quit'); only the
    // renderer tree is torn down and recreated from initial module state.
    await page.reload();

    // FIXED behavior: the dock comes back with its terminal — expanded and running,
    // not collapsed/empty — without the user re-opening it. RED on origin/main: no
    // surviving-session rehydration path exists, so the section never reappears.
    await expect(terminalSection(page)).toBeVisible({ timeout: 20_000 });
    await waitForStatus(page, 'running', 25_000);

    // And it is the SAME surviving shell, not a fresh spawn: the env marker set
    // before the reload is still readable. The typed command carries only the
    // unexpanded `$OK_RELOAD_MARKER`, so the literal value can appear in the
    // rendered output only when the live shell expanded it — a fresh shell prints
    // an empty value.
    await typeInTerminal(page, 'echo "marker=[$OK_RELOAD_MARKER]"\r');
    await expect
      .poll(() => readTerminalText(page), { timeout: 15_000 })
      .toContain('marker=[OKRELOAD_SURVIVED_351]');
  });

  // Shortcut behavior at the live-Electron rung: the platform's primary
  // modifier + Shift+J stages a REAL editor selection into a REAL CLI PTY,
  // then the View-menu route proves primary-modifier+J remains a pure
  // visibility toggle even while another selection is live. The fake
  // `claude` is a TUI stand-in (`exec cat`) that holds the PTY open reading
  // stdin, so staged bytes and session survival stay observable in xterm.
  test('the primary-modifier J shortcuts stage a new CLI tab and toggle visibility', async ({
    captureStderrFor,
  }) => {
    // This composed flow walks doc-load + launch + staged write + menu delivery,
    // so opt into a budget above the suite's 150s default.
    test.setTimeout(200_000);
    // skipRestoreState: with a state.json restore the cold-start window wins and
    // lands on the empty state, dropping the deep-link's `doc=` (and its collab
    // connection never recovers for a later hash-route). A restore-free cold
    // start opens the window from the deep link, routed to the doc.
    const s = seed('stage', { consent: true, fakeClaudeTui: true, skipRestoreState: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    // The shortcut targets the user's preferred AI. Pin that preference to the
    // fake Claude CLI supplied by this fixture so host-machine agent settings
    // cannot redirect the request into the Agents panel.
    await page.evaluate(() => {
      localStorage.setItem('ok-ask-ai-agent-v2', 'terminal-cli:claude');
      window.dispatchEvent(new StorageEvent('storage', { key: 'ok-ask-ai-agent-v2' }));
    });

    // Select the seeded doc's body in the real editor (ProseMirror select-all).
    // The selection-context registry publishes on a 120ms debounce
    // (SELECTION_STATS_DEBOUNCE_MS) — wait it out before firing the chord, or
    // the send reads an empty snapshot and degrades to a plain new-chat launch.
    // NOT `.ProseMirror.first()` — the Ask-AI composer is its own (empty)
    // ProseMirror; the doc editor is the non-composer one (sibling-smoke idiom).
    const editor = page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)');
    // The editor mounts before the CRDT doc body arrives — select-all on the
    // empty doc publishes an empty snapshot, so wait for the seeded text first.
    await expect(editor).toContainText('Seed document', { timeout: 30_000 });
    await editor.click();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
    await expect
      .poll(() => page.evaluate(() => String(window.getSelection() ?? '')))
      .toContain('Seed document');
    await waitForMenuSelectionState(page, true);

    // The renderer-owned chord (capture-phase window keydown — no menu item
    // claims it) opens a NEW CLI tab with the grounded passage staged into its
    // input once the PTY is live.
    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+j`);
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await waitForStatus(page, 'running', 25_000);
    // The staged bytes reached the CLI's PTY: the composed prompt names the doc
    // and carries the selected passage verbatim (short selections inline).
    await expect.poll(() => readTerminalText(page), { timeout: 20_000 }).toContain('start.md');
    await expect.poll(() => readTerminalText(page), { timeout: 15_000 }).toContain('Seed document');
    const terminalTabs = () => terminalSection(page).getByRole('tab');
    const tabsAfterLaunch = await terminalTabs().count();

    // Grow the doc with a distinguishing marker and re-select, then take the
    // CmdOrCtrl+J route via its View-menu accelerator item (the real menu→IPC→renderer
    // chain; raw OS key capture is not synthesizable from Playwright). A live
    // selection must not change the toggle contract or leak into the PTY.
    await editor.click();
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
    await waitForStatus(page, 'running', 25_000);
    expect(await terminalTabs().count()).toBe(tabsAfterLaunch);
    expect(await readTerminalText(page)).toContain('Seed document');
    expect(await readTerminalText(page)).not.toContain('OKSTAGE_REUSE_742');
  });
});
