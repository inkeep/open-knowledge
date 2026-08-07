/**
 * Standalone terminal-window live-Electron smoke (SPEC §9 seam 4). Drives the
 * real menu → main `createTerminalWindow` → a dedicated `--ok-mode=terminal`
 * BrowserWindow → the renderer's TerminalWindowApp → a per-window utilityProcess
 * hosting node-pty. Asserts the surfaces the mocked dom tests cannot reach: the
 * Terminal → New Terminal Window menu command opens a real window, a live shell
 * spawns at the inherited project cwd, multiple windows coexist, and closing the
 * last tab closes the window (D7). Per-window PTY reap on close is unit-covered
 * (terminal-window.test.ts asserts killForWindow on 'closed'; terminal-manager
 * kills the host); this asserts the observable window-close.
 *
 * Skip gates mirror terminal-dock.e2e.ts: opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * darwin-only, and the electron-vite build must exist. Not part of `pnpm check`;
 * run via `pnpm exec playwright test` or `pnpm run check:full:parallel`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

/** Seed a consented project (so the shell spawns without the JIT consent dialog). */
function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-termwin-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-termwin-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');

  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Terminal Window Smoke', lastOpenedAt: new Date().toISOString() },
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
        HOME: s.tmpHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findWindowByMode(
  app: ElectronApplication,
  mode: 'editor' | 'terminal',
  timeoutMs = 25_000,
): Promise<Page> {
  let page: Page | undefined;
  await expect(async () => {
    for (const p of app.windows()) {
      const m = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (m === mode) {
        page = p;
        return;
      }
    }
    throw new Error(`no ${mode} window yet`);
  }).toPass({ timeout: timeoutMs });
  if (!page) throw new Error(`${mode} window vanished after readiness poll`);
  return page;
}

async function clickNewTerminalWindow(
  app: ElectronApplication,
  sourceWebContentsId?: number,
): Promise<boolean> {
  return app.evaluate(async ({ BrowserWindow, Menu }, expectedSourceId) => {
    const menu = Menu.getApplicationMenu();
    const terminal = menu?.items.find((i) => i.label === 'Terminal');
    const item = terminal?.submenu?.items.find((i) => i.label === 'New Terminal Window');
    if (!item) return false;
    if (expectedSourceId === undefined) {
      item.click();
      return true;
    }
    const source = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedSourceId,
    );
    if (!source) return false;
    // Electron's headless test runner cannot establish native macOS focus, while
    // the production menu command intentionally resolves project context from
    // BrowserWindow.getFocusedWindow(). Scope that platform seam to this click so
    // the test still exercises the real menu and project-inheritance path.
    const getFocusedWindow = BrowserWindow.getFocusedWindow;
    Reflect.set(BrowserWindow, 'getFocusedWindow', () => source);
    try {
      item.click();
    } finally {
      Reflect.set(BrowserWindow, 'getFocusedWindow', getFocusedWindow);
    }
    return true;
  }, sourceWebContentsId);
}

async function terminalWindowCount(app: ElectronApplication): Promise<number> {
  let count = 0;
  for (const p of app.windows()) {
    const mode = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'terminal') count += 1;
  }
  return count;
}

const cleanup: string[] = [];
function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Standalone terminal window — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Desktop is darwin-only.');
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

  test('New Terminal Window opens a window with a live shell at the project root; close-last closes it', async ({
    captureStderrFor,
  }) => {
    const s = seed('open-close');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    // The main-process command inherits project context from the source editor.
    const editor = await findWindowByMode(app, 'editor');
    const editorWindow = await app.browserWindow(editor);
    const editorWebContentsId = await editorWindow.evaluate(
      (win: unknown) => (win as { webContents: { id: number } }).webContents.id,
    );

    expect(await clickNewTerminalWindow(app, editorWebContentsId)).toBe(true);
    const term = await findWindowByMode(app, 'terminal');
    expect(await term.evaluate(() => window.okDesktop?.config.collabUrl)).not.toBe('');

    // A live shell tab spawned in the new window.
    await expect(term.locator('[data-terminal-status]').first()).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 25_000 },
    );
    await expect(term.getByRole('tab', { name: 'Terminal 1' })).toBeVisible();

    // The shell's cwd is the inherited project root (the registry resolution
    // reaching a real shell).
    await term.locator('section[aria-label="Terminal"] .xterm').first().click();
    await term.keyboard.type('pwd\r');
    const tail = s.projectDir.split('/').slice(-1)[0] ?? '';
    await expect
      .poll(
        () =>
          term.evaluate(() => {
            const sec = document.querySelector('section[aria-label="Terminal"]');
            const a11y = sec?.querySelector('.xterm-accessibility')?.textContent ?? '';
            const rows = sec?.querySelector('.xterm-rows')?.textContent ?? '';
            return `${a11y}\n${rows}`;
          }),
        { timeout: 15_000 },
      )
      .toContain(tail);

    // Closing the last tab closes the window (it does not collapse a panel).
    await term.getByRole('button', { name: 'Close Terminal 1' }).click();
    await expect.poll(() => terminalWindowCount(app), { timeout: 15_000 }).toBe(0);
  });

  test('opening New Terminal Window twice yields two independent terminal windows', async ({
    captureStderrFor,
  }) => {
    const s = seed('multi');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    await findWindowByMode(app, 'editor');

    expect(await clickNewTerminalWindow(app)).toBe(true);
    await findWindowByMode(app, 'terminal');
    expect(await clickNewTerminalWindow(app)).toBe(true);

    // Both windows coexist — terminal windows are not deduped per project the
    // way editor windows are (windowsByPath focus-existing).
    await expect.poll(() => terminalWindowCount(app), { timeout: 20_000 }).toBe(2);
  });
});
