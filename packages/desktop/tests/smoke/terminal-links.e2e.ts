import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper';
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
const SHELL_COMMANDS = terminalSmokeShellCommands();

interface Seed {
  tmpHome: string;
  projectDir: string;
  pathPrefix: string;
  userDataDir: string;
}

function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-termlink-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-termlink-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  writeFileSync(join(projectDir, 'notes.md'), '# Notes\n\nClickable link target.\n');

  const binDir = join(tmpHome, 'fakebin');
  writeFakeClaudeShim(binDir, 'version');
  seedTerminalShellProfiles(tmpHome, { pathPrefix: binDir });

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Term Links', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );

  return { tmpHome, projectDir, pathPrefix: binDir, userDataDir };
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
        ...terminalSmokeEnvironment(s.tmpHome, { pathPrefix: s.pathPrefix }),
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

async function openRunningTerminal(app: ElectronApplication, page: Page): Promise<void> {
  const label = await app.evaluate(async ({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View');
    const item = view?.submenu?.items.find(
      (i) => i.label === 'Show Terminal' || i.label === 'Hide Terminal',
    );
    if (!item) throw new Error('View menu is missing the required Terminal visibility item');
    if (item.label === 'Show Terminal') item.click();
    return item.label;
  });
  expect(label).toMatch(/^(Show|Hide) Terminal$/);
  await expect(page.locator('section[aria-label="Terminal"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
  await waitForShellReady(
    () => page.locator('section[aria-label="Terminal"] .xterm-rows').innerText(),
    (command) => typeTerminalCommand(page, command),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

async function typeTerminalCommand(page: Page, command: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function runInTerminal(page: Page, command: string, marker: string): Promise<void> {
  await typeTerminalCommand(page, command);
  await expect(page.locator('section[aria-label="Terminal"] .xterm-rows')).toContainText(marker, {
    timeout: 10_000,
  });
}

async function clickTerminalLink(page: Page, linkText: string): Promise<void> {
  await expect(async () => {
    const span = page
      .locator('section[aria-label="Terminal"] .xterm-rows span', { hasText: linkText })
      .last();
    await span.scrollIntoViewIfNeeded();
    const box = await span.boundingBox();
    if (box == null) throw new Error(`terminal link ${JSON.stringify(linkText)} has no layout box`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  }).toPass({ timeout: 15_000 });
}

async function stubOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedExternal?: string[] };
    g.__openedExternal = [];
    shell.openExternal = async (url: string) => {
      g.__openedExternal?.push(url);
    };
  });
}

async function readOpenedExternal(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __openedExternal?: string[] }).__openedExternal ?? [],
  );
}

const cleanup: string[] = [];
function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Terminal clickable links — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.afterAll(() => {
    for (const p of cleanup.splice(0)) removeTempDirBestEffort(p);
  });

  test.fixme('clicking a printed URL opens it via shell.openExternal', async ({
    captureStderrFor,
  }) => {
    const s = seed('url');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await stubOpenExternal(app);
    await openRunningTerminal(app, page);

    const url = 'https://ok-smoke.example/link';
    await runInTerminal(page, SHELL_COMMANDS.output(url), 'ok-smoke.example');

    await expect(async () => {
      await clickTerminalLink(page, 'ok-smoke.example');
      expect(await readOpenedExternal(app)).toContain(url);
    }).toPass({ timeout: 20_000 });
  });

  test.fixme('clicking an in-project markdown path opens the doc in the editor', async ({
    captureStderrFor,
  }) => {
    const s = seed('doc');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openRunningTerminal(app, page);

    await runInTerminal(page, SHELL_COMMANDS.output('notes.md'), 'notes.md');

    await expect(async () => {
      await clickTerminalLink(page, 'notes.md');
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toBe('#/notes');
    }).toPass({ timeout: 20_000 });
  });
});
