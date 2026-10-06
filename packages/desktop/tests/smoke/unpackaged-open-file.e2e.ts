import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import {
  configureDesktopGitRepositories,
  configureEphemeralGitRepositories,
  findEphemeralTestProject,
} from '../support/git-fixture.test-helper';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { readBootLogLines } from './_helpers/launch-readiness';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

function launchOptions(tmpHome: string) {
  return desktopLaunchOptions({
    target: TARGET,
    args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
    env: {
      ...homeEnv(tmpHome),
      TMPDIR: tmpHome,
      TMP: tmpHome,
      TEMP: tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
    },
  });
}

test.describe('unpackaged single-file open', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(TARGET.mode !== 'unpackaged', 'This regression is specific to unpackaged Electron.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('opens a standalone Markdown file in an editor window', async ({ captureStderrFor }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-unpackaged-open-file-'));
    const notesDir = join(tmpHome, 'notes');
    mkdirSync(notesDir);
    const filePath = join(notesDir, 'standalone.md');
    writeFileSync(filePath, '# Ephemeral file opened\n\nA standalone note.\n');

    const app = await electron.launch(launchOptions(tmpHome));
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome] });

    const navigator = await app.firstWindow();
    await expect(navigator.getByTestId('nav-open-file')).toBeVisible();

    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.emit('open-file', { preventDefault() {} }, file);
    }, filePath);

    await expect
      .poll(
        async () => {
          for (const page of app.windows()) {
            const singleFile = await page
              .evaluate(() => window.okDesktop?.config?.singleFile)
              .catch(() => false);
            if (singleFile) return true;
          }
          return false;
        },
        { timeout: 45_000, message: 'the standalone file never opened in an editor window' },
      )
      .toBe(true);

    const editor = app.windows().find((window) => window !== navigator);
    if (editor === undefined) throw new Error('the single-file editor window vanished');
    await expect(editor.getByRole('heading', { name: 'Ephemeral file opened' })).toBeVisible();
    const apiOrigin = await editor.evaluate(() => window.okDesktop?.config.apiOrigin);
    if (!apiOrigin) throw new Error('the single-file editor has no server origin');
    const projectDir = findEphemeralTestProject(tmpHome, apiOrigin);
    await configureEphemeralGitRepositories(projectDir, apiOrigin);
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.quit());
    });
  });

  test('keeps normal project opens on the utility process', async ({ captureStderrFor }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-unpackaged-project-server-'));
    const projectDir = join(tmpHome, 'project');
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'note.md'), '# Project note\n');

    const app = await electron.launch(launchOptions(tmpHome));
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome] });
    const navigator = await app.firstWindow();
    await expect(navigator.getByTestId('nav-open')).toBeVisible();
    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({ path, target: 'new-window', entryPoint: 'recents' });
    }, projectDir);

    await expect
      .poll(
        async () => {
          for (const page of app.windows()) {
            const mode = await page
              .evaluate(() => window.okDesktop?.config?.mode)
              .catch(() => null);
            if (mode === 'editor') return true;
          }
          return false;
        },
        { timeout: 45_000, message: 'project editor did not appear after opening the folder' },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          readBootLogLines(tmpHome).some((line) =>
            line.includes('"event":"desktop-project-server-forked"'),
          ),
        { timeout: 30_000, message: 'unpackaged project never logged a utility fork' },
      )
      .toBe(true);

    const editor = app.windows().find((window) => window !== navigator);
    if (editor === undefined) throw new Error('the project editor window vanished');
    await configureDesktopGitRepositories(editor, projectDir);

    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.quit());
    });
  });
});
