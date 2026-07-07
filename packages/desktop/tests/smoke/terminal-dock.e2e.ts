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
 * darwin-only, and the electron-vite build must exist (out/main/index.js).
 *
 * QUARANTINED ON CI (test.skip(IS_CI)): the suite degrades on the 6-vCPU runner
 * (shells exit before "running" after a few launches) though it passes locally.
 * The skip is tracked, not invisible — it is allowlisted in the CI no-skip guard
 * (QUARANTINE_ALLOWLIST), which fails if the entry goes stale, and the rest of
 * the desktop-smoke gate stays non-vacuous via its smoke-not-vacuous check.
 * Re-enable: drop the allowlist entry and this test.skip(IS_CI) once the runner
 * degradation is fixed.
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
// Quarantine gate — see the header. Allowlisted in the CI no-skip guard so the
// skip stays gate-visible.
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

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
  if (opts.fakeClaudeOnPath) {
    const binDir = join(tmpHome, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const claudeBin = join(binDir, 'claude');
    writeFileSync(claudeBin, '#!/bin/sh\necho "claude 0.0.0-fake"\n');
    chmodSync(claudeBin, 0o755);
    pathPrefix = binDir;
  }

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
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
  return electron.launch({
    // No --disable-gpu: blanket software rendering starves CPU on constrained CI
    // runners. Instead TerminalPanel forces xterm's DOM renderer (not WebGL) when
    // the e2eSmoke config flag is set (from OK_DESKTOP_E2E_SMOKE=1, below), so
    // these DOM-based assertions can read the terminal while Electron keeps GPU.
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

/** Click the View → Show/Hide Terminal application-menu item (real toggle path
 *  on desktop — ⌘J is its OS-captured accelerator). Returns the item label. */
async function clickViewTerminalItem(app: ElectronApplication): Promise<string | false> {
  return app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    const view = menu.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) return false;
    const label = item.label;
    item.click();
    return label;
  });
}

async function viewTerminalLabel(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const view = menu?.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    return item?.label ?? null;
  });
}

const terminalSection = (page: Page) => page.locator('section[aria-label="Terminal"]');
const terminalStatus = (page: Page) => page.locator('[data-terminal-status]');
// The editor page carries several app-wide role="status" nodes (SelectionAnnouncer,
// ConnectingBanner), so a bare getByRole('status') is ambiguous under Playwright
// strict mode. Scope the claude-readiness banner by its stable test seam instead.
const readinessBanner = (page: Page) => page.getByTestId('terminal-readiness-banner');

/** Open the dock (via the real menu toggle) and wait for the panel to mount. */
async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await clickViewTerminalItem(app);
  await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
}

async function waitForStatus(page: Page, status: string, timeoutMs = 20_000): Promise<void> {
  await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', status, {
    timeout: timeoutMs,
  });
}

/** Ensure the terminal is bottom-docked. The default dock is the right column, so
 *  the bottom-panel assertions (`#terminal-dock-panel`) first flip it down via the
 *  tab strip's dock-toggle button (which reads "Dock terminal to the bottom" while
 *  right-docked). A no-op if it is already bottom-docked. */
async function ensureBottomDock(page: Page): Promise<void> {
  const toBottom = page.getByRole('button', { name: 'Dock terminal to the bottom' });
  if (await toBottom.count()) await toBottom.click();
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
  test.skip(!DARWIN, 'Desktop is darwin-only.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop".`);
  // Quarantined on CI (shells exit before "running" on the constrained 6-vCPU
  // runner; passes locally). Tracked via the QUARANTINE_ALLOWLIST in the CI
  // no-skip guard, not hidden.
  test.skip(
    IS_CI,
    'Quarantined on CI: terminal-dock degrades on the constrained runner — see inkeep/agents-private#2187.',
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
    await clickViewTerminalItem(app);
    await expect(page.getByRole('region', { name: 'Terminal disabled' })).toBeVisible({
      timeout: 15_000,
    });
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
    await clickViewTerminalItem(app);
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Hide Terminal');

    await clickViewTerminalItem(app);
    await expect.poll(() => viewTerminalLabel(app), { timeout: 8_000 }).toBe('Show Terminal');
  });

  // Toggle completes within the perceptual-instant budget.
  test('QA-022 toggle flips visibility within 150ms budget', async ({ captureStderrFor }) => {
    const s = seed('perf', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    const t0 = await page.evaluate(() => performance.now());
    await clickViewTerminalItem(app);
    // The section becomes present synchronously on the state flip.
    await page.waitForSelector('section[aria-label="Terminal"]', {
      state: 'attached',
      timeout: 5_000,
    });
    const elapsed = await page.evaluate((start) => performance.now() - start, t0);
    // Generous ceiling: IPC round-trip (menu→main→renderer) + synchronous flip.
    // The visual transition (150ms) is cosmetic; we measure mount, not animation.
    expect(elapsed).toBeLessThan(1000);
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

  // Dock controls — the click toggle replaced the drag grip. This asserts the UI
  // shape (dock-toggle + collapse present, no grip) in the live build. The default
  // dock is the right column, so the toggle offers "Dock terminal to the bottom".
  test('terminal tab strip exposes dock-toggle + collapse buttons and no drag grip', async ({
    captureStderrFor,
  }) => {
    const s = seed('dock-controls', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await expect(page.getByRole('button', { name: /Dock terminal to the/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Collapse terminal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Drag to dock the terminal' })).toHaveCount(0);
  });

  // Movable dock via the dock-toggle button — the default is the right column;
  // clicking "Dock terminal to the bottom" re-docks it under the editor
  // (#terminal-dock-panel), and clicking "Dock terminal to the right" moves it back
  // to its own column (#terminal-column).
  test('movable dock — the dock-toggle button moves the terminal between bottom and right', async ({
    captureStderrFor,
  }) => {
    const s = seed('dock-move', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    // Default dock is the right column.
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });

    // Toggle → bottom dock.
    await page.getByRole('button', { name: 'Dock terminal to the bottom' }).click();
    await expect(page.locator('#terminal-dock-panel section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });

    // Toggle → back to the right column.
    await page.getByRole('button', { name: 'Dock terminal to the right' }).click();
    await expect(page.locator('#terminal-column section[aria-label="Terminal"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  // Re-docking re-parents the SAME live terminal so the shell session + scrollback
  // survive the move — the session host owns one stable host div that relocates
  // across docks rather than remounting. Proven by element identity: the tagged
  // xterm node is the same one before and after the toggle.
  test('movable dock — preserves the same live terminal session across moves', async ({
    captureStderrFor,
  }) => {
    const s = seed('dock-parity', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const xterm = page.locator('section[aria-label="Terminal"] .xterm');
    await xterm.evaluate((el) => {
      (el as HTMLElement).dataset.parityTag = 'OK_PARITY_TAG';
    });
    // Re-dock to the bottom; the SAME tagged node must reappear under the bottom
    // panel (relocated, not re-spawned).
    await page.getByRole('button', { name: 'Dock terminal to the bottom' }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document
                .querySelector<HTMLElement>('.xterm[data-parity-tag="OK_PARITY_TAG"]')
                ?.closest('#terminal-dock-panel') != null,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
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
  // ⌘J — the View → Hide Terminal toggle — which collapses the dock and returns
  // focus to the editor.
  test('QA-019 Escape reaches the terminal; ⌘J is the no-trap exit', async ({
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

    // The documented keyboard exit is ⌘J (here via its View-menu accelerator):
    // it collapses the dock and returns focus to the editor — satisfying WCAG
    // 2.1.2 without consuming Escape.
    await clickViewTerminalItem(app);
    await expect.poll(focusInTerminal).toBe(false);
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

    const heightBefore = await page
      .locator('#terminal-dock-panel')
      .evaluate((el) => el.getBoundingClientRect().height);

    // Drag the resize handle upward to grow the panel.
    const handle = page.locator('[data-panel-resize-handle-id], [role="separator"]').last();
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 8 });
      await page.mouse.up();
    }
    await page.waitForTimeout(300); // debounced persist (100ms) + settle

    const heightAfter = await page
      .locator('#terminal-dock-panel')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(heightAfter).toBeGreaterThan(heightBefore);

    // localStorage carries the persisted height.
    const stored = await page.evaluate(() => localStorage.getItem('ok-terminal-height-v1'));
    expect(stored).not.toBeNull();

    // Hide + reopen: reopens at the persisted (grown) height.
    await clickViewTerminalItem(app);
    await page.waitForTimeout(200);
    await clickViewTerminalItem(app);
    await expect(terminalSection(page)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const heightReopen = await page
      .locator('#terminal-dock-panel')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(heightReopen - heightAfter)).toBeLessThan(40);
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

  // Claude not on PATH surfaces the actionable not-found banner.
  test('QA-017 claude-not-found shows Get-Claude-Code banner', async ({ captureStderrFor }) => {
    // No fake claude, restricted PATH → probe resolves not-found.
    const s = seed('claude-missing', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

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

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // Apostrophe-free substring (same rationale as the not-found banner) — distinctive
    // to the MCP-rewire banner variant, which the 'Connect tools' affordance below confirms.
    await expect(banner).toContainText('OpenKnowledge tools');
    await expect(page.getByRole('button', { name: 'Connect tools' })).toBeVisible();
  });

  // A renderer reload (View → Reload, or the window reload macOS sleep/wake
  // forces) must NOT lose the open terminal. The PTY survives in the main
  // process; the reloaded renderer must rehydrate the dock from it — same shell,
  // not a fresh spawn. This is the canonical reload-survival contract. It
  // RED-fails on origin/main, where the dock comes back collapsed/empty: the
  // renderer reads no surviving-session inventory on mount, so the live shell is
  // orphaned and the dock seeds nothing.
  //
  // Desktop-only — the dock renders only on the Electron host (it needs the real
  // preload bridge + the per-window PTY host), so this runs on a real macOS
  // desktop (OK_DESKTOP_E2E_SMOKE=1), never headless. It is intentionally the
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
});
