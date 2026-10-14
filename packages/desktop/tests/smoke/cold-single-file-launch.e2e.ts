import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron, expect } from '@playwright/test';
import {
  configureEphemeralGitRepositories,
  configureProjectGitRepositories,
  readTestServerRepository,
} from '../support/git-fixture.test-helper';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { homeEnv, userDataDirFor } from './_helpers/platform-gate';
import { test } from './_helpers/smoke-test';
import { waitForShellReady } from './_helpers/terminal-ready';
import { terminalSmokeShellCommands } from './_helpers/terminal-smoke-shell';

const TARGET = resolveDesktopTarget({ requirePackaged: true });
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const APP_NAME = TARGET.appPath ? basename(TARGET.appPath, '.app') : 'OpenKnowledge';
const LOG_DIR = join(process.env.HOME ?? '', '.ok', 'logs');

function appIsRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', APP_NAME], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function waitForExit(): void {
  const deadline = Date.now() + 15_000;
  while (appIsRunning() && Date.now() < deadline) {
    execFileSync('sleep', ['0.25']);
  }
}

function quitAppCleanly(): void {
  try {
    execFileSync('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { stdio: 'pipe' });
  } catch {}
  waitForExit();
  if (appIsRunning()) {
    throw new Error(
      `${APP_NAME} did not quit after the Apple-Event quit request, and this test does not stop apps by name`,
    );
  }
}

function makeProjectFixture(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-cold-launch-project-')));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  const file = join(dir, 'note.md');
  writeFileSync(file, '# Project note\n');
  return { dir, file };
}

function makeLooseFile(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-cold-launch-loose-')));
  const file = join(dir, 'standalone.md');
  writeFileSync(file, '# Standalone\n\nOutside every project.\n');
  return { dir, file };
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page
    .locator('section[aria-label="Terminal"]:visible')
    .first()
    .evaluate((terminal) => {
      const accessible = terminal.querySelector('.xterm-accessibility')?.textContent ?? '';
      const rows = terminal.querySelector('.xterm-rows')?.textContent ?? '';
      return `${accessible}\n${rows}`;
    });
}

async function typeInVisibleTerminal(page: Page, command: string): Promise<void> {
  await page.locator('section[aria-label="Terminal"]:visible .xterm').click();
  await page.keyboard.type(`${command}\r`);
}

interface BootRestoreDecisionLog {
  urlLaunch: boolean;
  action: string;
  snapshotWindowCount: number;
}

function readLogLinesSince(sinceMs: number): Array<Record<string, unknown>> {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => f.startsWith('desktop.'))
    .flatMap((f) =>
      readFileSync(join(LOG_DIR, f), 'utf8')
        .split('\n')
        .flatMap((line) => {
          if (line.trim().length === 0) return [];
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const t = typeof entry.time === 'string' ? Date.parse(entry.time) : Number.NaN;
            return Number.isFinite(t) && t >= sinceMs ? [entry] : [];
          } catch {
            return [];
          }
        }),
    );
}

async function waitForBootDecision(
  sinceMs: number,
  observeServer?: () => void,
): Promise<BootRestoreDecisionLog> {
  let found: Record<string, unknown> | undefined;
  await expect(() => {
    found = readLogLinesSince(sinceMs).find((e) => e.msg === 'boot-restore decision');
    expect(
      found,
      `no boot-restore decision logged since ${new Date(sinceMs).toISOString()}`,
    ).toBeDefined();
    observeServer?.();
  }).toPass({ timeout: 60_000, intervals: [500] });
  return found as unknown as BootRestoreDecisionLog;
}

function readEphemeralServerLog(sinceMs: number, file: string): { lockDir: string; port: number } {
  const matches = readLogLinesSince(sinceMs).filter(
    (entry) => entry.event === 'desktop-ephemeral-server-spawned' && entry.file === file,
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    !entry ||
    typeof entry.lockDir !== 'string' ||
    typeof entry.port !== 'number'
  ) {
    throw new Error(`Expected one ephemeral server log for ${file}`);
  }
  return { lockDir: entry.lockDir, port: entry.port };
}

function launchViaLaunchServices(target: string): number {
  const since = Date.now();
  execFileSync('open', ['-a', TARGET.appPath as string, target], { stdio: 'pipe' });
  return since;
}

async function establishRestoreSnapshot(projectFile: string): Promise<void> {
  quitAppCleanly();
  const since = launchViaLaunchServices(projectFile);
  const projectDir = dirname(projectFile);
  const lockDir = join(projectDir, '.ok', 'local');
  await waitForBootDecision(since, () => {
    expect(readTestServerRepository(lockDir).projectDir).toBe(projectDir);
  });
  const server = readTestServerRepository(lockDir);
  expect(server.projectDir).toBe(projectDir);
  await configureProjectGitRepositories(projectDir, server.apiOrigin);
  execFileSync('sleep', ['6']);
  quitAppCleanly();
}

test.describe('cold launch with an explicit target owns the initial window set', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Launch Services + Apple Events are macOS-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.skip(
    () => appIsRunning(),
    `${APP_NAME} is already running — a second launch takes the single-instance path and never makes a boot-restore decision.`,
  );

  test('a cold single-file open suppresses a non-empty restore snapshot', async () => {
    test.setTimeout(180_000);

    const project = makeProjectFixture();
    const loose = makeLooseFile();

    try {
      await establishRestoreSnapshot(project.file);

      const since = launchViaLaunchServices(loose.file);
      const decision = await waitForBootDecision(since, () => {
        const spawned = readEphemeralServerLog(since, loose.file);
        expect(readTestServerRepository(spawned.lockDir).port).toBe(spawned.port);
      });

      expect(
        decision.snapshotWindowCount,
        'the app booted with an empty snapshot, so the suppression under test was never exercised',
      ).toBeGreaterThanOrEqual(1);
      expect(decision.urlLaunch).toBe(true);
      expect(decision.action).toBe('none');

      const spawned = readEphemeralServerLog(since, loose.file);
      const server = readTestServerRepository(spawned.lockDir);
      expect(server.port).toBe(spawned.port);
      await configureEphemeralGitRepositories(server.projectDir, server.apiOrigin);
    } finally {
      quitAppCleanly();
      rmSync(project.dir, { recursive: true, force: true });
      rmSync(loose.dir, { recursive: true, force: true });
    }
  });

  test('a cold launch that opens no window of its own still lands on the Navigator', async () => {
    test.setTimeout(180_000);

    const project = makeProjectFixture();
    const share = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';

    try {
      await establishRestoreSnapshot(project.file);

      const since = launchViaLaunchServices(share);
      const decision = await waitForBootDecision(since);
      expect(
        decision.snapshotWindowCount,
        'the app booted with an empty snapshot, so the suppression under test was never exercised',
      ).toBeGreaterThanOrEqual(1);
      expect(decision.action).toBe('none');

      await expect(() => {
        const opened = readLogLinesSince(since).some(
          (e) => e.subsystem === 'navigator' && e.msg === 'opening window',
        );
        expect(opened, 'boot suppressed the restore but opened no window').toBe(true);
      }).toPass({ timeout: 30_000, intervals: [500] });
    } finally {
      quitAppCleanly();
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
});

test.describe('packaged single-file shared shell', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The packaged single-file shell case runs in the macOS packaged lane.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('a packaged single-file window keeps its shared header above cards through narrow selection', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    expect(statSync(TARGET.targetPath).isFile()).toBe(true);
    accessSync(TARGET.targetPath, constants.X_OK);
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-single-file-shell-home-')));
    const loose = makeLooseFile();
    let app: ElectronApplication | null = null;
    let registered = false;

    try {
      app = await electron.launch(
        desktopLaunchOptions({
          target: TARGET,
          args: [
            `--user-data-dir=${userDataDirFor(tmpHome)}`,
            `openknowledge://open?file=${encodeURIComponent(loose.file)}`,
          ],
          env: {
            ...process.env,
            ...homeEnv(tmpHome),
            OK_DESKTOP_E2E_SMOKE: '1',
          },
        }),
      );
      captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, loose.dir] });
      registered = true;
      let editor: Page | undefined;
      await expect
        .poll(
          async () => {
            for (const page of app?.windows() ?? []) {
              const singleFile = await page
                .evaluate(() => window.okDesktop?.config.singleFile)
                .catch(() => false);
              if (singleFile === true) {
                editor = page;
                return true;
              }
            }
            return false;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      if (!editor) throw new Error('the single-file window disappeared after becoming ready');
      const readyEditor = editor;
      const consentSkip = editor.getByTestId('mcp-consent-skip');
      await expect(consentSkip).toBeVisible();
      await consentSkip.click();
      await expect(consentSkip).toBeHidden();

      const globalHeader = editor.locator('header[data-app-header]');
      const editorCard = editor.locator('[data-slot="pane-card"][data-pane="editor"]');
      const chatCard = editor.locator('[data-slot="pane-card"][data-pane="agents"]');
      const editorButton = globalHeader.getByTestId('header-pane-button-editor');
      const chatButton = globalHeader.getByTestId('header-pane-button-agents');
      const terminalButton = globalHeader.getByTestId('header-pane-button-terminal');
      await expect(globalHeader).toHaveCount(1);
      await expect(editorCard).toHaveAttribute('data-variant', 'card');
      await expect(chatCard).toHaveAttribute('data-variant', 'card');
      await expect(editorCard.locator('header[data-editor-header]')).toContainText('standalone');
      await expect(
        editorCard.locator('header[data-editor-header] [data-doc-panel-toggle]'),
      ).toBeVisible();
      await expect(globalHeader.locator('[data-doc-panel-toggle]')).toHaveCount(0);
      await expect(editor.getByTestId('project-switcher-trigger')).toHaveCount(0);
      await expect(editor.getByTestId('share-button')).toHaveCount(0);
      await expect(terminalButton).toBeVisible();
      await expect(chatCard).toBeHidden();

      const winHandle = await app.browserWindow(editor);
      await winHandle.evaluate((win: unknown) => {
        (
          win as { setContentSize: (width: number, height: number, animate: boolean) => void }
        ).setContentSize(1000, 600, false);
      });
      await expect.poll(() => readyEditor.evaluate(() => window.innerWidth)).toBe(1000);
      const panelHandle = editor.locator('[data-doc-panel-handle]');
      const handleBounds = await panelHandle.boundingBox();
      if (!handleBounds) throw new Error('the docked document panel has no resize handle');
      const handleY = handleBounds.y + handleBounds.height / 2;
      await editor.mouse.move(handleBounds.x + handleBounds.width / 2, handleY);
      await editor.mouse.down();
      await editor.mouse.move(handleBounds.x - 280, handleY, { steps: 8 });
      await editor.mouse.up();
      await expect
        .poll(async () => (await readyEditor.locator('#doc-panel').boundingBox())?.width ?? 0)
        .toBeGreaterThan(500);
      await winHandle.evaluate((win: unknown) => {
        (
          win as { setContentSize: (width: number, height: number, animate: boolean) => void }
        ).setContentSize(767, 600, false);
      });
      await expect.poll(() => readyEditor.evaluate(() => window.innerWidth)).toBe(767);
      await expect(editor.locator('#doc-panel')).toBeHidden();
      await editorCard.locator('header[data-editor-header] [data-doc-panel-toggle]').click();
      const informationCover = editor.locator('[data-doc-panel-cover]');
      await expect(informationCover).toBeVisible();
      for (const label of ['Outline', 'Problems', 'Comments']) {
        await expect(informationCover.getByRole('tab', { name: label })).toBeVisible();
      }
      for (const label of ['Links', 'Graph', 'Timeline']) {
        await expect(informationCover.getByRole('tab', { name: label })).toHaveCount(0);
      }
      await editor.locator('[data-doc-panel-back]').click();
      await chatButton.click();
      await expect(chatButton).toHaveAttribute('aria-pressed', 'true');
      await expect(editorCard).toBeHidden();
      await expect(chatCard).toBeVisible();
      await editorButton.click();
      await expect(editorCard).toBeVisible();
      await expect(chatCard).toBeHidden();
      await terminalButton.click();
      await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
      await expect(editorCard).toBeHidden();
      await expect(chatCard).toBeHidden();
      await expect(
        editor.locator('[data-slot="pane-card"][data-pane="terminal"]:visible'),
      ).toHaveCount(1);
      const terminalStatus = editor.locator(
        'section[aria-label="Terminal"]:visible [data-terminal-status]',
      );
      await expect(terminalStatus).toHaveAttribute('data-terminal-status', 'running');
      await waitForShellReady(
        () => readVisibleTerminalText(readyEditor),
        (command) => typeInVisibleTerminal(readyEditor, command),
      );
      const initialSessions = await editor.evaluate(() => window.okDesktop?.terminal.list());
      expect(initialSessions).toHaveLength(1);
      const ptyId = initialSessions?.[0]?.ptyId;
      expect(ptyId).toBeTruthy();
      const shell = terminalSmokeShellCommands();
      await typeInVisibleTerminal(
        readyEditor,
        shell.setEnvironment('OK_SINGLE_FILE_SHELL', 'OK_SINGLE_FILE_SURVIVED_684'),
      );
      await typeInVisibleTerminal(
        readyEditor,
        shell.readEnvironment('OK_SINGLE_FILE_SHELL', 'before'),
      );
      await expect
        .poll(() => readVisibleTerminalText(readyEditor))
        .toContain('before=[OK_SINGLE_FILE_SURVIVED_684]');
      const waitingPath = join(loose.dir, 'single-file-terminal-waiting');
      const releasePath = join(loose.dir, 'single-file-terminal-release');
      const acknowledgementPath = join(loose.dir, 'single-file-terminal-completed');
      await typeInVisibleTerminal(
        readyEditor,
        shell.waitForFileThenOutput(
          releasePath,
          waitingPath,
          acknowledgementPath,
          'OK_SINGLE_FILE_WAITING_684',
        ),
      );
      await expect.poll(() => existsSync(waitingPath)).toBe(true);
      await chatButton.click();
      await expect(chatCard).toBeVisible();
      await expect(terminalStatus).toBeHidden();
      writeFileSync(releasePath, 'OK_SINGLE_FILE_COMPLETED_684\n');
      await expect.poll(() => existsSync(acknowledgementPath)).toBe(true);
      expect(readFileSync(acknowledgementPath, 'utf8')).toContain('OK_SINGLE_FILE_COMPLETED_684');
      expect((await editor.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(
        ptyId,
      );
      await editorButton.click();
      await expect(editorCard).toBeVisible();
      await expect(
        editor.locator('[data-slot="pane-card"][data-pane="terminal"]:visible'),
      ).toHaveCount(0);
      expect((await editor.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(
        ptyId,
      );
      expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      await winHandle.evaluate((win: unknown) => {
        (
          win as { setContentSize: (width: number, height: number, animate: boolean) => void }
        ).setContentSize(720, 480, false);
      });
      await expect.poll(() => readyEditor.evaluate(() => window.innerWidth)).toBe(720);
      await expect(editorButton).toBeVisible();
      await expect(chatButton).toBeVisible();
      await expect(terminalButton).toBeVisible();
      await expect(editorCard).toBeVisible();
      expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      await winHandle.evaluate((win: unknown) => {
        (
          win as { setContentSize: (width: number, height: number, animate: boolean) => void }
        ).setContentSize(900, 600, false);
      });
      await expect.poll(() => readyEditor.evaluate(() => window.innerWidth)).toBe(900);
      await expect(editorCard).toBeVisible();
      await expect(chatCard).toBeHidden();
      await chatButton.click();
      await expect(editorCard).toBeVisible();
      await expect(chatCard).toBeVisible();
      await terminalButton.click();
      await expect(terminalStatus).toHaveAttribute('data-terminal-status', 'running');
      expect((await editor.evaluate(() => window.okDesktop?.terminal.list()))?.[0]?.ptyId).toBe(
        ptyId,
      );
      await expect
        .poll(() => readVisibleTerminalText(readyEditor))
        .toContain('OK_SINGLE_FILE_COMPLETED_684');
      await typeInVisibleTerminal(
        readyEditor,
        shell.readEnvironment('OK_SINGLE_FILE_SHELL', 'after'),
      );
      await expect
        .poll(() => readVisibleTerminalText(readyEditor))
        .toContain('after=[OK_SINGLE_FILE_SURVIVED_684]');
      await expect(globalHeader).toHaveCount(1);
    } finally {
      void app?.close().catch(() => undefined);
      if (!registered) {
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(loose.dir, { recursive: true, force: true });
      }
    }
  });
});
