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
        ...terminalSmokeEnvironment(s.tmpHome, { restrictPath: true }),
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 15_000): Promise<Page> {
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

const visibleSection = (page: Page) => page.locator('section[aria-label="Terminal"]:visible');
const activeTerminalPanel = (page: Page) =>
  page.locator('[data-terminal-session][data-state="active"]').first();
async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await expect(async () => {
    if (!(await visibleSection(page).isVisible())) await clickViewTerminalItem(app);
    await expect(visibleSection(page)).toBeVisible({ timeout: 5_000 });
    await expect(activeTerminalPanel(page).locator('[data-terminal-status]')).toHaveAttribute(
      'data-terminal-status',
      'running',
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 15_000, intervals: [2_000] });
  await waitForShellReady(
    () => readActiveText(page),
    (command) => typeInActive(page, `${command}\r`),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

async function waitActiveRunning(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect(visibleSection(page)).toBeVisible({ timeout: 5_000 });
  await expect(activeTerminalPanel(page).locator('[data-terminal-status]')).toHaveAttribute(
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

async function openBareTab(page: Page): Promise<void> {
  await openBareTerminalTab(page, () => waitActiveRunning(page));
}

async function activateTab(tab: Locator): Promise<void> {
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function dragTabOnto(page: Page, fromTab: Locator, toTab: Locator): Promise<void> {
  const from = await fromTab.boundingBox();
  const to = await toTab.boundingBox();
  if (!from || !to) throw new Error('terminal tab bounding box missing');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 14, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function typeInActive(page: Page, text: string): Promise<void> {
  const term = activeTerminalPanel(page).locator('.xterm').first();
  await expect(term).toBeVisible({ timeout: 5_000 });
  await term.click();
  await page.keyboard.type(text);
}

async function readActiveText(page: Page): Promise<string> {
  const panel = activeTerminalPanel(page);
  await expect(panel).toBeVisible({ timeout: 5_000 });
  return panel.evaluate((root) => {
    const a11y = root.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = root.querySelector('.xterm-rows')?.textContent ?? '';
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
      } catch {}
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

    const marker1 = `TAB1_PID_${Date.now().toString(36)}`;
    await typeInActive(page, `${SHELL_COMMANDS.processId(marker1)}\r`);
    let pid1 = '';
    await expect
      .poll(
        async () => {
          const match = (await readActiveText(page)).match(new RegExp(`${marker1}=(\\d+)`));
          pid1 = match?.[1] ?? '';
          return pid1.length > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await openBareTab(page);
    await expect(terminalTabs(page)).toHaveCount(2);

    const marker2 = `TAB2_PID_${Date.now().toString(36)}`;
    await typeInActive(page, `${SHELL_COMMANDS.processId(marker2)}\r`);
    let pid2 = '';
    await expect
      .poll(
        async () => {
          const match = (await readActiveText(page)).match(new RegExp(`${marker2}=(\\d+)`));
          pid2 = match?.[1] ?? '';
          return pid2.length > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(pid2).not.toBe(pid1);
    await expect
      .poll(async () => (await readActiveText(page)).includes(`${marker1}=`), {
        timeout: 15_000,
      })
      .toBe(false);
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
    await openBareTab(page);
    const [, survivingTabId] = await terminalTabIds(page);
    if (survivingTabId === undefined) throw new Error('second terminal tab was not created');

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

    await terminalTabs(page).first().dblclick();
    const input = page.getByRole('textbox', { name: /^Rename/ });
    await input.fill('my build');
    await input.press('Enter');
    await expect(page.getByRole('tab', { name: 'my build' })).toBeVisible({ timeout: 5_000 });

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

    await typeInActive(page, `${SHELL_COMMANDS.setEnvironment('OK_TABMARK', 'SURVIVED_888')}\r`);
    await typeInActive(page, `${SHELL_COMMANDS.output('BEFORE_REORDER_DDD')}\r`);
    await expect
      .poll(() => readActiveText(page), { timeout: 15_000 })
      .toContain('BEFORE_REORDER_DDD');

    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await activateTab(terminalTabById(page, firstTabId));
    await visibleSection(page).locator('.xterm').click();

    await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+ArrowRight`);

    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    if (process.platform !== 'win32') {
      await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);
    }

    await expect(terminalTabById(page, firstTabId)).toHaveAttribute('aria-selected', 'true');
    if (process.platform !== 'win32') {
      await expect
        .poll(() => readActiveText(page), { timeout: 15_000 })
        .toContain('BEFORE_REORDER_DDD');
    }
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

    await typeInActive(
      page,
      `${SHELL_COMMANDS.setEnvironment('OK_DRAGMARK', 'DRAG_SURVIVED_444')}\r`,
    );
    await typeInActive(page, `${SHELL_COMMANDS.output('BEFORE_DRAG_EEE')}\r`);
    await expect.poll(() => readActiveText(page), { timeout: 15_000 }).toContain('BEFORE_DRAG_EEE');

    const [firstTabId] = await terminalTabIds(page);
    if (firstTabId === undefined) throw new Error('first terminal tab was not created');
    await openBareTab(page);
    const [, secondTabId] = await terminalTabIds(page);
    if (secondTabId === undefined) throw new Error('second terminal tab was not created');
    await expectTerminalTabOrder(page, [firstTabId, secondTabId]);
    await dragTabOnto(page, terminalTabById(page, firstTabId), terminalTabById(page, secondTabId));

    await expectTerminalTabOrder(page, [secondTabId, firstTabId]);
    if (process.platform !== 'win32') {
      await expect(terminalTabs(page)).toHaveText(['Terminal 2', 'Terminal 1']);
    }

    await activateTab(terminalTabById(page, firstTabId));
    await visibleSection(page).locator('.xterm').click();
    if (process.platform !== 'win32') {
      expect(await readActiveText(page)).toContain('BEFORE_DRAG_EEE');
    }
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

    await page.reload();
    await expect(visibleSection(page)).toBeVisible({ timeout: 20_000 });
    await expect(terminalTabs(page)).toHaveText([secondLabel, 'build'], { timeout: 25_000 });
  });
});
