import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import {
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
} from './_helpers/terminal-smoke-shell';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const SHELL_COMMANDS = terminalSmokeShellCommands();

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-termwin-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-termwin-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  seedTerminalShellProfiles(tmpHome, { restrictPath: true });

  const userDataDir = userDataDirFor(tmpHome);
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
        ...terminalSmokeEnvironment(s.tmpHome, { restrictPath: true }),
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

async function waitForRendererResponsive(page: Page): Promise<void> {
  await expect(async () => {
    for (let probe = 0; probe < 3; probe += 1) {
      const startedAt = Date.now();
      await page.evaluate(() => performance.now());
      expect(Date.now() - startedAt).toBeLessThan(100);
    }
  }).toPass({ timeout: 15_000, intervals: [250] });
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
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.afterEach(() => {
    for (const target of cleanup.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  test('New Terminal Window opens a window with a live shell at the project root; close-last closes it', async ({
    captureStderrFor,
  }) => {
    const s = seed('open-close');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await waitForRendererResponsive(editor);
    const editorWindow = await app.browserWindow(editor);
    const editorWebContentsId = await editorWindow.evaluate(
      (win: unknown) => (win as { webContents: { id: number } }).webContents.id,
    );

    expect(await clickNewTerminalWindow(app, editorWebContentsId)).toBe(true);
    const term = await findWindowByMode(app, 'terminal');
    expect(await term.evaluate(() => window.okDesktop?.config.collabUrl)).not.toBe('');

    await expect(term.locator('[data-terminal-status]').first()).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 25_000 },
    );
    await expect(term.getByRole('tab')).toHaveCount(1);

    await term.locator('section[aria-label="Terminal"] .xterm').first().click();
    await term.keyboard.type(`${SHELL_COMMANDS.cwd}\r`);
    const tail = basename(s.projectDir);
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

    await term.getByRole('button', { name: /^Close / }).click();
    await expect.poll(() => terminalWindowCount(app), { timeout: 15_000 }).toBe(0);
  });

  test('opening New Terminal Window twice yields two independent terminal windows', async ({
    captureStderrFor,
  }) => {
    const s = seed('multi');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    await waitForRendererResponsive(await findWindowByMode(app, 'editor'));

    expect(await clickNewTerminalWindow(app)).toBe(true);
    await findWindowByMode(app, 'terminal');
    expect(await clickNewTerminalWindow(app)).toBe(true);

    await expect.poll(() => terminalWindowCount(app), { timeout: 20_000 }).toBe(2);
  });
});
