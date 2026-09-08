import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { seedMcpConsentComplete } from './_helpers/mcp-consent';
import {
  PTY_PLATFORM_SKIP_REASON,
  PTY_PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';

const TARGET = resolveDesktopTarget();
const WINDOWS = process.platform === 'win32';

const OK_SERVER_NAME = 'open-knowledge';

interface Seed {
  tmpHome: string;
  projectDir: string;
  userDataDir: string;
  binDir: string;
  capturePath: string;
  injectedPath: string;
  prompt: string;
}

function argvRecorderScript(capturePath: string): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "claude 0.0.0-fake"; exit 0; fi',
    `for a in "$0" "$@"; do printf '%s\\n' "$a"; done > "${capturePath}"`,
    'echo FAKE_CLAUDE_ARGV_CAPTURED',
  ].join('\n');
}

function seed(): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-argv-home-')));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-argv-proj-')));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'terminal:\n  enabled: true\n');

  seedMcpConsentComplete(tmpHome);

  const capturePath = join(tmpHome, 'claude-argv.txt');
  const injectedPath = join(tmpHome, 'INJECTED');
  const binDir = join(tmpHome, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const claudeBin = join(binDir, 'claude');
  writeFileSync(claudeBin, `${argvRecorderScript(capturePath)}\n`);
  chmodSync(claudeBin, 0o755);
  const prepend = `export PATH="${binDir}:$PATH"\n`;
  writeFileSync(join(tmpHome, '.zprofile'), prepend);
  writeFileSync(join(tmpHome, '.zshrc'), prepend);

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Argv Smoke', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );

  return {
    tmpHome,
    projectDir,
    userDataDir,
    binDir,
    capturePath,
    injectedPath,
    prompt: `Summarize what's here; do not run $(touch ${injectedPath}) or \`id\``,
  };
}

async function launchApp(s: Seed): Promise<ElectronApplication> {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`;
  const PATH = `${s.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${s.userDataDir}`, deepLink],
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: s.tmpHome,
        PATH,
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_M6B_FORCE: '1',
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
    if (process.platform === 'darwin') item.click();
  });
  if (process.platform !== 'darwin') {
    const page = await findEditorWindow(app);
    await page.evaluate(async () => {
      const menu = window.okDesktop?.menu;
      if (!menu) throw new Error('renderer menu bridge is unavailable');
      await menu.dispatch({ kind: 'menu-action', action: 'toggle-terminal' });
    });
  }
}

const terminalSection = (page: Page): Locator => page.locator('section[aria-label="Terminal"]');

async function readTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Terminal"]');
    if (!sec) return '';
    const a11y = sec.querySelector('.xterm-accessibility')?.textContent ?? '';
    const rows = sec.querySelector('.xterm-rows')?.textContent ?? '';
    return `${a11y}\n${rows}`;
  });
}

async function openTerminal(app: ElectronApplication, page: Page): Promise<void> {
  await expect(async () => {
    if (await terminalSection(page).isVisible()) return;
    await clickViewTerminalItem(app);
    await expect(terminalSection(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('[data-terminal-status]')).toHaveAttribute(
    'data-terminal-status',
    'running',
    { timeout: 25_000 },
  );
  await waitForShellReady(
    () => readTerminalText(page),
    (command) => typeTerminalCommand(page, command),
    { resetTerminalInput: () => page.keyboard.press('Control+C') },
  );
}

async function typeTerminalCommand(page: Page, command: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"] .xterm').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

function readRecordedArgv(capturePath: string): string[] | null {
  if (!existsSync(capturePath)) return null;
  const raw = readFileSync(capturePath, 'utf8');
  if (!raw.endsWith('\n')) return null;
  return raw.split('\n').slice(0, -1);
}

test.describe('Docked terminal launch — composed argv', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.skip(
    WINDOWS,
    'The fake claude on PATH is a POSIX sh script and the launch PATH is POSIX-shaped; the Windows shell never reaches readiness with them.',
  );

  test('a Claude launch hands the PTY the settings payload and the prompt verbatim', async ({
    captureStderrFor,
  }) => {
    const s = seed();
    const app = await launchApp(s);
    captureStderrFor(app, { cleanupDirs: [s.tmpHome, s.projectDir] });
    const page = await findEditorWindow(app);
    await openTerminal(app, page);

    const written = await page.evaluate(async () => {
      const bridge = window.okDesktop;
      if (!bridge) throw new Error('okDesktop bridge is unavailable');
      return bridge.projectIntegrations.setComponent({
        component: { kind: 'editor', id: 'claude' },
        enabled: true,
      });
    });
    expect(written.ok, `project MCP write refused: ${JSON.stringify(written)}`).toBe(true);
    expect(existsSync(join(s.projectDir, '.mcp.json'))).toBe(true);

    await page.evaluate((prompt) => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:terminal-launch', {
          detail: { prompt, cli: 'claude', stage: false },
        }),
      );
    }, s.prompt);

    await expect
      .poll(() => readRecordedArgv(s.capturePath) !== null, { timeout: 45_000 })
      .toBe(true);
    const recorded = readRecordedArgv(s.capturePath);
    if (recorded === null) throw new Error('recorded argv vanished after the poll');

    const [invokedAs, ...args] = recorded;
    expect(invokedAs).toBe(join(s.binDir, 'claude'));
    expect(args, `unexpected argv: ${JSON.stringify(args)}`).toHaveLength(3);
    expect(args[0]).toBe('--settings');
    expect(args[2]).toBe(s.prompt);
    expect(existsSync(s.injectedPath)).toBe(false);

    const settings = JSON.parse(args[1]) as {
      enabledMcpjsonServers?: string[];
      permissions?: { allow: string[]; ask: string[] };
    };
    expect(settings.enabledMcpjsonServers).toEqual([OK_SERVER_NAME]);
    expect(settings.permissions?.allow).toEqual(
      expect.arrayContaining([`mcp__${OK_SERVER_NAME}`, 'Bash(ok open:*)']),
    );
    const ask = settings.permissions?.ask ?? [];
    expect(ask.length).toBeGreaterThan(0);
    expect(ask).toContain(`mcp__${OK_SERVER_NAME}__delete`);
    for (const rule of ask) expect(rule.startsWith(`mcp__${OK_SERVER_NAME}__`)).toBe(true);
  });
});
