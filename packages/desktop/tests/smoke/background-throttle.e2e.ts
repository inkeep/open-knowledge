import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const BUILD_EXISTS = existsSync(MAIN_ENTRY);

interface SeededHome {
  tmpHome: string;
  projectDir: string;
}

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function seedHomeWithLastOpenedProject(prefix: string): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-bg-throttle-${prefix}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ok-bg-throttle-${prefix}-project-`));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        {
          path: projectDir,
          name: 'Background Throttle Smoke',
          lastOpenedAt: new Date().toISOString(),
        },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectDir };
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
    timeout: 30_000,
    env: {
      ...process.env,
      ...homeEnv(tmpHome),
      OK_DESKTOP_E2E_SMOKE: '1',
    },
  });
}

async function findWindow(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
  timeoutMs = 20_000,
): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const m = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (m === mode) return true;
        }
        return false;
      },
      {
        timeout: timeoutMs,
        message: `${mode} window did not appear within timeout`,
      },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) return page;
  }
  throw new Error(`${mode} window vanished between poll resolution and read`);
}

async function readBackgroundThrottling(app: ElectronApplication, page: Page): Promise<boolean> {
  const winHandle: JSHandle = await app.browserWindow(page);
  return winHandle.evaluate((win: unknown) => {
    const w = win as { webContents: { backgroundThrottling: boolean } };
    return w.webContents.backgroundThrottling;
  });
}

interface ThrottleSignal {
  hasPendingWork: boolean;
  enabled: boolean;
}

async function pushSignal(page: Page, signal: ThrottleSignal): Promise<void> {
  await page.evaluate((s) => {
    window.okDesktop?.editor.notifyBackgroundThrottle(s);
  }, signal);
}

async function pushAndExpectThrottling(
  app: ElectronApplication,
  page: Page,
  signal: ThrottleSignal,
  expected: boolean,
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await pushSignal(page, signal);
        return readBackgroundThrottling(app, page);
      },
      {
        timeout: 10_000,
        message: `${label}: expected webContents.backgroundThrottling === ${expected} after pushing ${JSON.stringify(signal)}`,
      },
    )
    .toBe(expected);
}

test.describe('background-throttle smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop" first.`,
  );

  test('a window holding unsynced work opts out of Chromium background throttling until it is clean', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject('happy');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findWindow(app, 'editor');

    await expect
      .poll(() => readBackgroundThrottling(app, editor), {
        timeout: 10_000,
        message: 'baseline: expected the OS default (backgroundThrottling === true)',
      })
      .toBe(true);

    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: true, enabled: true },
      false,
      'pending work',
    );

    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: false, enabled: true },
      true,
      'work drained',
    );

    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: true, enabled: true },
      false,
      're-armed pending work',
    );
    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: true, enabled: false },
      true,
      'kill-switch off',
    );
  });
});
