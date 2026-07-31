/**
 * Runtime verification that Electron actually applies the background-throttling
 * policy main computes from the renderer's unsynced-work signal. The Vitest
 * unit test in `src/main/background-throttle.test.ts` pins the predicate and
 * the toggle call against a `vi.fn()` webContents; this smoke test proves the
 * real chain honors it end to end — renderer `window.okDesktop.editor
 * .notifyBackgroundThrottle` -> preload `invoke` -> the
 * `ok:editor:background-throttle` main handler -> a live Chromium
 * `webContents` — by reading `webContents.backgroundThrottling` back from
 * main-process context.
 *
 * The observable is the Chromium-side property, not a spy: a window holding
 * unsynced work opts OUT of background throttling (`false`), and a clean
 * window (or one whose kill-switch is off) sits at the OS default (`true`).
 *
 * Pattern mirrors `window-min-size.e2e.ts`:
 *   - Seed a tmp HOME with `lastOpenedProject` so the Editor window opens
 *     first (Navigator stays closed).
 *   - Launch with `--user-data-dir=<tmpHome>/electron-userdata`.
 *   - Find the Editor window, drive the real preload API from its renderer,
 *     read main-process state through `app.browserWindow(page)`.
 *
 * Each transition re-pushes its signal on every poll iteration. The renderer's
 * own `BackgroundThrottleReporter` seeds main once on install and then pushes
 * on true<->false unsynced-work edges, so a real edge during window warm-up
 * could otherwise land between this test's push and its read; re-pushing makes
 * the test's signal the last writer on each attempt rather than depending on
 * the window being quiescent.
 *
 * Skip gates (same as the rest of the cross-platform smoke suite):
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in.
 *   - an unsupported host platform — `backgroundThrottling` is a Chromium
 *     property, so the contract is the same wherever Electron runs.
 *   - `out/main/index.js` missing — `pnpm run build:desktop` must have run.
 */

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

/** Read the live Chromium property from main-process context. */
async function readBackgroundThrottling(app: ElectronApplication, page: Page): Promise<boolean> {
  const winHandle: JSHandle = await app.browserWindow(page);
  return winHandle.evaluate((win: unknown) => {
    // BrowserWindow types are not in scope inside evaluate's V8 context;
    // `webContents.backgroundThrottling` is a runtime property on the
    // BrowserWindow wrapper Playwright hands back. The cast is local here.
    const w = win as { webContents: { backgroundThrottling: boolean } };
    return w.webContents.backgroundThrottling;
  });
}

interface ThrottleSignal {
  hasPendingWork: boolean;
  enabled: boolean;
}

/** Push the signal through the real preload bridge from the renderer. */
async function pushSignal(page: Page, signal: ThrottleSignal): Promise<void> {
  await page.evaluate((s) => {
    window.okDesktop?.editor.notifyBackgroundThrottle(s);
  }, signal);
}

/**
 * Push `signal` and wait for Chromium's `backgroundThrottling` to settle on
 * `expected`. The push repeats per poll iteration (see the file docblock).
 */
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

    // Baseline: a window with no pending work sits at the OS default. The
    // renderer's reporter seeds `hasPendingWork: false` on install, and the
    // BrowserWindow is constructed with Electron's default throttling.
    await expect
      .poll(() => readBackgroundThrottling(app, editor), {
        timeout: 10_000,
        message: 'baseline: expected the OS default (backgroundThrottling === true)',
      })
      .toBe(true);

    // Unsynced work: main must keep the window's timers alive.
    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: true, enabled: true },
      false,
      'pending work',
    );

    // Clean again: the OS default comes back, so the Page Visibility API the
    // flush-on-hide and presence paths depend on keeps working.
    await pushAndExpectThrottling(
      app,
      editor,
      { hasPendingWork: false, enabled: true },
      true,
      'work drained',
    );

    // Re-arm, then prove the kill-switch is honored at the real boundary:
    // pending work with `enabled: false` returns to the OS default.
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
