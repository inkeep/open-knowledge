
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
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

interface SeedOpts {
  consent?: boolean;
  /** Explicitly opt out — seed .ok/local/config.yml terminal.enabled: false (the
   *  one state that refuses the shell under the default-on/opt-out model). */
  optOut?: boolean;
  claudeJson?: Record<string, unknown> | null;
  fakeClaudeOnPath?: boolean;
}

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
  realProjectDir: string;
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
  restrictPath?: boolean;
}

async function launchApp(s: Seed, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  const basePath = opts.restrictPath ? '/usr/bin:/bin:/usr/sbin:/sbin' : (process.env.PATH ?? '');
  const PATH = s.pathPrefix ? `${s.pathPrefix}:${basePath}` : basePath;
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
const readinessBanner = (page: Page) => page.getByTestId('terminal-readiness-banner');

async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await clickViewTerminalItem(app);
  await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
}

async function waitForStatus(page: Page, status: string, timeoutMs = 20_000): Promise<void> {
  await expect(terminalStatus(page)).toHaveAttribute('data-terminal-status', status, {
    timeout: timeoutMs,
  });
}

async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(text);
}

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
  test.skip(
    IS_CI,
    'Quarantined on CI: terminal-dock degrades on the constrained runner — see inkeep/agents-private#2187.',
  );

  test.afterEach(() => {
    for (const target of cleanup.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
      }
    }
  });

  test('QA-004 first open mounts the live panel (no consent dialog)', async ({
    captureStderrFor,
  }) => {
    const s = seed('default-on'); // terminal.enabled absent => default-on
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

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

    const localCfg = join(s.projectDir, '.ok', 'local', 'config.yml');
    const persisted = existsSync(localCfg) ? readFileSync(localCfg, 'utf8') : '';
    expect(persisted).not.toMatch(/enabled:\s*true/);
  });

  test('QA-006 opted-out shows not-enabled notice; Enable re-enables the shell', async ({
    captureStderrFor,
  }) => {
    const s = seed('opt-out', { optOut: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    await clickViewTerminalItem(app);
    await expect(page.getByRole('region', { name: 'Terminal disabled' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Enable terminal' })).toBeVisible();
    await expect(terminalStatus(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Enable terminal' }).click();
    await expect(terminalSection(page)).toBeVisible({ timeout: 15_000 });
    await waitForStatus(page, 'running', 25_000);
  });

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

  test('QA-022 toggle flips visibility within 150ms budget', async ({ captureStderrFor }) => {
    const s = seed('perf', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);

    const t0 = await page.evaluate(() => performance.now());
    await clickViewTerminalItem(app);
    await page.waitForSelector('section[aria-label="Terminal"]', {
      state: 'attached',
      timeout: 5_000,
    });
    const elapsed = await page.evaluate((start) => performance.now() - start, t0);
    expect(elapsed).toBeLessThan(1000);
  });

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

    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect(page.locator('section[aria-label="Terminal"] .xterm-accessibility')).toHaveCount(
      1,
    );
  });

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
    await expect.poll(focusInTerminal).toBe(true);

    await page.keyboard.press('Escape');
    await expect.poll(focusInTerminal).toBe(true);

    await clickViewTerminalItem(app);
    await expect.poll(focusInTerminal).toBe(false);
  });

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
    await page.locator('section[aria-label="Terminal"] .xterm').click();

    await clickViewTerminalItem(app);
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

  test('QA-023 panel height persists across reopen', async ({ captureStderrFor }) => {
    const s = seed('resize', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const heightBefore = await page
      .locator('#terminal-dock-panel')
      .evaluate((el) => el.getBoundingClientRect().height);

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

    const stored = await page.evaluate(() => localStorage.getItem('ok-terminal-height-v1'));
    expect(stored).not.toBeNull();

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
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5_000 });
    const restart = page.getByRole('button', { name: /Restart terminal/i });
    await expect(restart).toBeVisible();
    await expect(readinessBanner(page)).toHaveCount(0);

    await restart.click();
    await waitForStatus(page, 'running', 25_000);
    await typeInTerminal(page, 'echo RESTARTED_OK\r');
    await expect.poll(() => readTerminalText(page), { timeout: 10_000 }).toContain('RESTARTED_OK');
  });

  test('QA-017 claude-not-found shows Get-Claude-Code banner', async ({ captureStderrFor }) => {
    const s = seed('claude-missing', { consent: true });
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s, { restrictPath: true });
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);
    await waitForStatus(page, 'running', 25_000);

    const banner = readinessBanner(page);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('installed or on your PATH');
    await expect(page.getByRole('button', { name: 'Get Claude Code' })).toBeVisible();
  });

  test('QA-018 missing OK MCP entry shows Connect-tools affordance', async ({
    captureStderrFor,
  }) => {
    const s = seed('mcp-rewire', {
      consent: true,
      fakeClaudeOnPath: true,
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
    await expect(banner).toContainText('OpenKnowledge tools');
    await expect(page.getByRole('button', { name: 'Connect tools' })).toBeVisible();
  });
});
