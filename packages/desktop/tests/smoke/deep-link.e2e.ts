import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

test.describe('deep-link warm-start smoke (M4 US-009 / AC7)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link URL scheme is macOS-only in v0 (D51 NOT NOW).');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('open(1) shell-out post-launch routes extension-less docName to renderer hash', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(join(projectDir, 'target.md'), '# Target Doc\n\nDeep-link smoke content.\n');

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [projectDir, tmpHome] });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=target`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith('#/target')) return;
      }
      throw new Error('no window has hash matching the extension-less producer form yet');
    }).toPass({ timeout: 15_000 });
  });

  test('open(1) shell-out with nested docName round-trips encoded slash', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-nested-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-nested-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    writeFileSync(
      join(projectDir, 'notes', 'meeting.md'),
      '# Meeting Notes\n\nNested doc smoke.\n',
    );

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [projectDir, tmpHome] });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=notes%2Fmeeting`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash === '#/notes%2Fmeeting' || hash === '#/notes/meeting') return;
      }
      throw new Error('no window has nested-doc hash yet');
    }).toPass({ timeout: 15_000 });
  });
});
