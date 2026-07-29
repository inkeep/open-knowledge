/**
 * Runtime verification that the Windows/Linux window chrome is actually
 * applied by Electron — not merely computed correctly.
 *
 * `src/main/window-chrome.ts` had unit coverage only: `buildNonDarwinChromeOpts`
 * and `applyThemeToWindow` were exercised against a fake window object, which
 * proves the option OBJECT is shaped right and proves nothing about whether
 * Electron honors it. Every observable in that path — does the OS actually draw
 * the overlay controls, does the solid background take, does the native menu
 * bar stay hidden — is only reachable by launching the real app on a real
 * Windows or Linux host. That gap is what this spec closes.
 *
 * Three assertions, each reading a different half of `DEFAULT_WIN_OPTS`'s
 * non-darwin branch:
 *
 *   1. `getBackgroundColor()` matches the theme's `CHROME_BG` token. There is
 *      no vibrancy analog off-mac, so this solid base is what the renderer's
 *      alpha-tinted surfaces composite over; if it is wrong (or defaulted to
 *      white) the whole chrome reads broken during load.
 *   2. `navigator.windowControlsOverlay.visible` is true in the renderer. This
 *      is the load-bearing one: the Window Controls Overlay API only reports
 *      visible when Electron accepted `titleBarStyle: 'hidden'` +
 *      `titleBarOverlay` and reserved space for OS-drawn controls. It is the
 *      closest thing to "the overlay painted" that is assertable in-process.
 *   3. `isMenuBarAutoHide()` is true, so the native Menu (kept installed for
 *      its accelerators) does not render a second row above the custom
 *      titlebar.
 *
 * Darwin-inverted on purpose: macOS composes its own vibrancy/hiddenInset
 * stack in `index.ts` and never calls `buildNonDarwinChromeOpts`, so this spec
 * skips there rather than asserting a shape macOS was never given.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { CHROME_BG } from '../../src/main/window-chrome.ts';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const DARWIN = process.platform === 'darwin';

interface SeededHome {
  tmpHome: string;
  projectDir: string;
}

function seedHomeWithLastOpenedProject(): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ok-window-chrome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-window-chrome-project-'));
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
        { path: projectDir, name: 'Window Chrome Smoke', lastOpenedAt: new Date().toISOString() },
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
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const mode = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (mode === 'editor') return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: 'editor window did not appear within timeout' },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'editor') return page;
  }
  throw new Error('editor window vanished between poll resolution and read');
}

test.describe('Windows/Linux window chrome smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(DARWIN, 'macOS composes its own vibrancy/hiddenInset chrome, not this branch.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('editor window applies the non-darwin chrome: solid background, overlay controls, hidden menu bar', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject();
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    const winHandle: JSHandle = await app.browserWindow(editor);

    // Read the theme the main process resolved rather than assuming light:
    // the runner's OS theme decides which token was applied at construction.
    const isDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);

    const chrome = await winHandle.evaluate((win: unknown) => {
      // BrowserWindow's type isn't in scope inside evaluate's V8 context;
      // both members are runtime methods on the wrapper Playwright returns.
      const w = win as { getBackgroundColor: () => string; isMenuBarAutoHide: () => boolean };
      return { backgroundColor: w.getBackgroundColor(), menuBarAutoHide: w.isMenuBarAutoHide() };
    });

    expect(chrome.backgroundColor.toLowerCase()).toBe(isDark ? CHROME_BG.dark : CHROME_BG.light);
    expect(chrome.menuBarAutoHide).toBe(true);

    // The Window Controls Overlay API is only exposed to the renderer when
    // Electron accepted `titleBarStyle: 'hidden'` + `titleBarOverlay` — the
    // closest in-process proof that the OS reserved space for its own
    // min/max/close controls over our chrome row.
    const overlay = await editor.evaluate(() => {
      const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } })
        .windowControlsOverlay;
      return { supported: wco !== undefined, visible: wco?.visible ?? false };
    });
    // Logged on every platform so the Linux value is on the record (see below).
    console.log(`[window-chrome] windowControlsOverlay: ${JSON.stringify(overlay)}`);
    expect(overlay.supported).toBe(true);

    // `visible` is asserted on Windows only. Electron's Linux overlay is
    // creation-time-only (`setTitleBarOverlay` is Windows-only — see
    // window-chrome.ts), and the CI runner has no real window manager, so a
    // false reading there would not distinguish "we failed to opt in" from
    // "Xvfb draws no decorations".
    //
    // Observed on ubuntu-latest under `xvfb-run`: `{supported: true, visible:
    // true}` — so the Linux path does report it. Left un-asserted for now
    // because that is a single sample, and this spec runs in a job intended for
    // promotion to required; one flaky reading under a headless X server would
    // cost more than the assertion gains. Promote it to an unconditional
    // `expect` once several consecutive Linux runs have logged `visible: true`.
    if (process.platform === 'win32') {
      expect(overlay.visible).toBe(true);
    }
  });
});
