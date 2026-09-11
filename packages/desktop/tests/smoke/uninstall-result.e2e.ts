import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OkUninstallBridge } from '@inkeep/open-knowledge-core';
import { type Browser, chromium, _electron as electron, expect, test } from '@playwright/test';
import { buildDesktopUninstallHandoffScript } from '../../src/main/desktop-uninstall-handoff';
import { captureAppProcess, closeAppBounded } from './_helpers/electron-cleanup';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';

const TARGET = resolveDesktopTarget();
const DARWIN = process.platform === 'darwin';
const owned: string[] = [];
const cleanupFailures: string[] = [];
test.afterEach(() => {
  expect(cleanupFailures.splice(0)).toEqual([]);
});
test.afterEach(() => {
  for (const dir of owned.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  }
});

function closeOrRecord(proc: Parameters<typeof closeAppBounded>[0]): Promise<void> {
  return closeAppBounded(proc).catch((error: unknown) => {
    cleanupFailures.push(error instanceof Error ? error.message : String(error));
  });
}

test.describe('isolated uninstall completion', () => {
  test.skip(!DARWIN, 'macOS uninstall handoff');
  test.skip(!TARGET.exists, TARGET.missingReason);
  for (const success of [true, false]) {
    test(`renders the ${success ? 'success' : 'failure'} result in the handed-off language`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-locale-test-'));
      owned.push(home);
      const app = await electron.launch(
        desktopLaunchOptions({
          target: TARGET,
          args: [
            `--user-data-dir=${join(home, 'profile')}`,
            '--ok-uninstall-locale=es',
            '--ok-uninstall-result',
            success ? 'OpenKnowledge files were removed' : 'Cleanup didn’t finish',
            'Details in the log.',
            success ? 'Reveal in Finder' : 'Close',
          ],
          env: { ...process.env, HOME: home },
        }),
      );
      const child = captureAppProcess(app);
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('heading', {
            name: success
              ? 'Se eliminaron los archivos de OpenKnowledge'
              : 'La limpieza no terminó',
          }),
        ).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', 'es');
        await expect(page.getByRole('listitem')).toHaveCount(success ? 3 : 0);
        await expect(page.getByText('Kept your content')).toHaveCount(0);
        const exited = once(child, 'exit');
        await page.keyboard.down('Escape');
        expect(await exited).toEqual([0, null]);
        expect(existsSync(join(home, '.ok'))).toBe(false);
      } finally {
        await closeOrRecord(child);
      }
    });
  }
  test('keeps the normal desktop entry available', async () => {
    test.skip(TARGET.mode === 'packaged', 'The notice preview is development-only.');
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-normal-entry-'));
    owned.push(home);
    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${join(home, 'profile')}`],
        env: { ...process.env, HOME: home, OK_UNINSTALL_UI_PREVIEW: 'notice' },
      }),
    );
    const child = captureAppProcess(app);
    try {
      await expect(async () => {
        const headings = await Promise.all(
          app.windows().map((page) => page.locator('h1').allTextContents()),
        );
        expect(headings.flat()).toContain('Uninstall OpenKnowledge?');
      }).toPass({ timeout: 20_000 });
    } finally {
      await closeOrRecord(child);
    }
  });
  for (const [success, action, exitCode] of [
    [true, 'Reveal in Finder', 11],
    [true, 'Cleanup log', 10],
    [true, 'Escape', 0],
    [false, 'Cleanup log', 10],
    [false, 'Close', 0],
  ] as const) {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    test(`renders ${success ? 'success' : 'failure'} and exits on ${action}`, async ({}, testInfo) => {
      const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-result-test-'));
      owned.push(home);
      const profile = join(home, 'result-profile');
      mkdirSync(profile);
      const note = join(home, 'notes.md');
      writeFileSync(note, '# Keep my notes');
      const app = await electron.launch(
        desktopLaunchOptions({
          target: TARGET,
          args: [
            `--user-data-dir=${profile}`,
            '--ok-uninstall-result',
            success ? 'OpenKnowledge files were removed' : 'Cleanup didn’t finish',
            success ? 'Settings removed.' : 'A server remains alive. Project state was retained.',
            success ? 'Reveal in Finder' : 'Close',
          ],
          env: { ...process.env, HOME: home },
        }),
      );
      const child = captureAppProcess(app);
      try {
        const page = await app.firstWindow();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        if (success) {
          await expect(page.getByRole('listitem')).toHaveCount(3);
          await expect(page.getByText('Kept your content')).toBeVisible();
          await expect(page.getByRole('button', { name: 'Reveal in Finder' })).toBeFocused();
          if (action === 'Reveal in Finder') {
            await page.screenshot({ path: testInfo.outputPath('completion.png') });
            await page.keyboard.press('Tab');
            await expect(page.getByRole('button', { name: 'Cleanup log' })).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(page.getByRole('button', { name: 'Reveal in Finder' })).toBeFocused();
          }
        } else {
          await expect(page.getByRole('listitem')).toHaveCount(0);
          await expect(
            page.getByText(
              'Some files may not have been removed. Open the cleanup log for details. You can reopen OpenKnowledge to try again.',
            ),
          ).toBeVisible();
        }
        const exited = once(child, 'exit');
        if (action === 'Escape') await page.keyboard.down('Escape');
        else await page.getByRole('button', { name: action }).click();
        const [code] = await exited;
        expect(code).toBe(exitCode);
        expect(existsSync(join(home, '.ok'))).toBe(false);
        expect(existsSync(join(home, 'Library', 'Application Support', 'OpenKnowledge'))).toBe(
          false,
        );
        expect(readFileSync(note, 'utf8')).toBe('# Keep my notes');
      } finally {
        await closeOrRecord(child);
      }
    });
  }
});

test.describe('continuous uninstall handoff', () => {
  test.skip(!DARWIN, 'macOS uninstall handoff');
  test.skip(!TARGET.exists, TARGET.missingReason);
  for (const success of [true, false]) {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    test(`keeps the same window through shutdown, cleanup and ${success ? 'success' : 'failure'}`, async ({}, testInfo) => {
      const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-progress-test-'));
      owned.push(home);
      const logPath = join(home, 'cleanup.log');
      const state = join(home, 'settings');
      const note = join(home, 'notes.md');
      const appBundlePath = join(home, 'OpenKnowledge.app');
      mkdirSync(appBundlePath);
      writeFileSync(note, '# Keep my notes');
      const parent = spawn(
        '/bin/sh',
        [
          '-c',
          `while [ ! -f '${home}/quit' ]; do /bin/sleep 0.05; done
printf 'final shutdown write' > '${state}'`,
        ],
        { detached: true, stdio: 'ignore' },
      );
      let helper: ReturnType<typeof spawn> | null = null;
      let browser: Browser | undefined;
      try {
        const parentPid = parent.pid;
        if (parentPid === undefined) throw new Error('No parent process');
        const parentStartedAt = execFileSync(
          '/bin/ps',
          ['-p', String(parentPid), '-o', 'lstart='],
          { encoding: 'utf8' },
        ).trim();
        const server = createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('No debug port');
        const port = address.port;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const cliPath = join(home, 'cleanup');
        writeFileSync(
          cliPath,
          `#!/bin/sh
[ -f '${state}' ] || exit 2
touch '${home}/cleaning'
while [ ! -f '${home}/finish-cleanup' ]; do /bin/sleep 0.05; done
${success ? `rm '${state}'` : 'exit 31'}
`,
          { mode: 0o700 },
        );
        const open = join(home, 'open');
        writeFileSync(open, `#!/bin/sh\nprintf '%s' "$2" > '${home}/revealed'\n`, { mode: 0o700 });
        const require = createRequire(import.meta.url);
        const result =
          TARGET.mode === 'packaged'
            ? [TARGET.targetPath, `--remote-debugging-port=${port}`]
            : [String(require('electron')), TARGET.targetPath, `--remote-debugging-port=${port}`];
        const script = buildDesktopUninstallHandoffScript(
          {
            cliPath,
            projectPaths: [],
            logPath,
            appBundlePath,
            parentPid,
            parentStartedAt,
          },
          { result, open },
        );
        helper = spawn('/bin/sh', ['-c', script], {
          detached: true,
          env: { ...process.env, HOME: home, TMPDIR: home, OK_LANG: 'en' },
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let output = '';
        helper.stdout?.on('data', (chunk) => {
          output += String(chunk);
        });
        await expect.poll(() => output, { timeout: 35_000 }).toContain('OK_UNINSTALL_READY');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const page = browser.contexts()[0]?.pages()[0];
        if (page === undefined) throw new Error('No progress window');
        await expect(
          page.getByRole('heading', { name: 'Removing OpenKnowledge files…' }),
        ).toBeVisible();
        expect(parent.exitCode).toBeNull();
        expect(existsSync(join(home, 'cleaning'))).toBe(false);
        await page.evaluate(() => {
          window.name = 'continuous-progress';
        });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('status')).toBeVisible();
        expect(
          await page.evaluate(() => {
            const host = window as typeof window & { okUninstall?: OkUninstallBridge };
            return host.okUninstall?.send({ kind: 'notice-confirm' });
          }),
        ).toEqual({ kind: 'refused', reason: 'invalid-intent' });
        writeFileSync(join(home, 'quit'), 'quit');
        await expect.poll(() => existsSync(join(home, 'cleaning'))).toBe(true);
        await expect(page.getByRole('status')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('progress.png') });
        expect(await page.getByRole('alertdialog').count()).toBe(0);
        writeFileSync(join(home, 'finish-cleanup'), 'finish');
        await expect(
          page.getByRole('heading', {
            name: success ? 'OpenKnowledge files were removed' : 'Cleanup didn’t finish',
          }),
        ).toBeVisible();
        expect(await page.evaluate(() => window.name)).toBe('continuous-progress');
        expect(browser.contexts()[0]?.pages()).toHaveLength(1);
        await expect(page.getByRole('listitem')).toHaveCount(success ? 3 : 0);
        await page.screenshot({ path: testInfo.outputPath('completion.png') });
        const closed = once(helper, 'close');
        await page
          .getByRole('button', { name: success ? 'Reveal in Finder' : 'Cleanup log' })
          .click();
        expect(await closed).toEqual([success ? 0 : 1, null]);
        expect(readFileSync(join(home, 'revealed'), 'utf8')).toBe(
          success ? appBundlePath : logPath,
        );
        expect(readFileSync(logPath, 'utf8')).toContain(
          `Cleanup result: ${success ? 'succeeded' : 'failed'}`,
        );
        expect(existsSync(state)).toBe(!success);
        expect(readFileSync(note, 'utf8')).toBe('# Keep my notes');
        expect(readdirSync(home).filter((name) => name.startsWith('ok-uninstall-result.'))).toEqual(
          [],
        );
        expect(existsSync(join(home, '.ok'))).toBe(false);
        expect(existsSync(join(home, 'Library', 'Application Support', 'OpenKnowledge'))).toBe(
          false,
        );
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          const closed = once(parent, 'close');
          parent.kill('SIGKILL');
          await closed;
        }
        if (helper !== null && helper.exitCode === null && helper.signalCode === null) {
          const closed = once(helper, 'close');
          helper.kill('SIGTERM');
          await closed;
        }
        await closeOrRecord(parent);
        await closeOrRecord(helper);
        await browser?.close().catch(() => {});
      }
    });
  }
});
