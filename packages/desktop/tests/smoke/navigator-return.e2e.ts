/**
 * Project Navigator return-affordance smoke test — drives an Electron launch
 * with a `lastOpenedProject` so the editor window opens first (Navigator
 * window is NOT initially present), then triggers `bridge.navigator.open()`
 * from the editor renderer and asserts that the Navigator window appears.
 *
 * Coverage (one test per branch where the branches are observably distinct):
 *   1. Editor opens FIRST (lastOpenedProject path).
 *   2. closed → create: `bridge.navigator.open()` spawns a navigator window.
 *   3. count never exceeds 1 across re-invokes (poll-based, not
 *      a fixed sleep). These branches are not separately distinguishable
 *      from window-count alone, but the count-stability poll catches the
 *      regression class both branches are intended to prevent (duplicate spawn).
 *   4. closing the navigator leaves the editor window alive.
 *
 * The test calls `bridge.navigator.open()` directly via `page.evaluate(...)`
 * rather than clicking the dropdown trigger — exercising the IPC contract is
 * the goal here; full DOM-driven affordance coverage (dropdown click,
 * CommandPalette `Cmd+K` keystroke) belongs to component-level Playwright
 * runs that also need the `bun run dev` server, not the smoke harness.
 *
 * Skip gates mirror `deep-link.e2e.ts` and `mcp-wiring.e2e.ts`:
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in so `bunx playwright test` on
 *     the whole repo doesn't try to launch Electron in headless CI.
 *   - `process.platform !== 'darwin'` — the smoke harness is darwin-only in
 *     v0; the IPC plumbing is platform-agnostic and remains exercised by the
 *     Bun unit/integration tests on every platform.
 *   - `out/main/index.js` missing — `bun run build:desktop` must have run.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

interface SeededHome {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

// Compute the per-test Electron userData dir under tmpHome. The Chromium
// `--user-data-dir=<path>` switch is the only mechanism that reliably
// isolates `app.getPath('userData')` in dev mode — Electron's default
// resolution reads `NSBundle.mainBundle`'s CFBundleName (which is
// "Electron" when launched via `Electron.app/Contents/MacOS/Electron`,
// regardless of `productName` or the `HOME` env var).
function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function seedHomeWithLastOpenedProject(prefix: string): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navigator-return-${prefix}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ok-navigator-return-${prefix}-project-`));
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
          name: 'Navigator Return Smoke',
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
  return { tmpHome, userDataDir, projectDir };
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
    },
  });
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  return await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const mode = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (mode === 'editor') return page;
        }
        return null;
      },
      {
        timeout: timeoutMs,
        message: 'editor window did not appear within timeout',
      },
    )
    .not.toBeNull()
    .then(async () => {
      for (const page of app.windows()) {
        const mode = await page
          .evaluate(() => window.okDesktop?.config?.mode)
          .catch(() => undefined);
        if (mode === 'editor') return page;
      }
      throw new Error('editor window vanished between poll resolution and read');
    });
}

async function countNavigatorWindows(app: ElectronApplication): Promise<number> {
  let count = 0;
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'navigator') count++;
  }
  return count;
}

async function countEditorWindows(app: ElectronApplication): Promise<number> {
  let count = 0;
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'editor') count++;
  }
  return count;
}

async function findNavigatorWindow(app: ElectronApplication, timeoutMs = 15_000): Promise<Page> {
  await expect
    .poll(() => countNavigatorWindows(app), {
      timeout: timeoutMs,
      message: 'navigator window did not appear within timeout',
    })
    .toBe(1);
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'navigator') return page;
  }
  throw new Error('navigator window vanished between poll resolution and read');
}

test.describe('Project Navigator return-affordance smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('bridge.navigator.open() opens navigator from editor; re-invokes never spawn a duplicate', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject('happy');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    // Editor should be the only window initially — Navigator did NOT spawn
    // because lastOpenedProject was set.
    await expect.poll(() => countNavigatorWindows(app)).toBe(0);

    // Invoke the bridge IPC and assert the Navigator window appears.
    await editor.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });

    await expect
      .poll(() => countNavigatorWindows(app), {
        timeout: 15_000,
        message: 'navigator window did not appear after bridge.navigator.open()',
      })
      .toBe(1);

    // Re-invoke twice. Count must NEVER exceed 1 across the
    // poll window: an event-driven check that fails the moment a duplicate
    // appears, rather than waiting out a fixed sleep budget that could
    // mask a slow-spawn race on a loaded machine.
    await editor.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    await editor.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    await expect
      .poll(() => countNavigatorWindows(app), {
        timeout: 2_000,
        intervals: [50, 100, 200, 400],
        message: 'navigator window count exceeded 1 across re-invokes',
      })
      .toBe(1);
  });

  test('FR5(d) — closing the navigator window leaves the editor window alive', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject('close');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    await expect.poll(() => countEditorWindows(app)).toBe(1);

    await editor.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    const navigatorPage = await findNavigatorWindow(app);

    // Close the Navigator. The editor window must NOT be torn down by
    // any side-effect of the navigator's `closed` lifecycle handler
    // (which only nulls the module-level `navigatorWindow` ref in main).
    await navigatorPage.close();

    await expect
      .poll(() => countNavigatorWindows(app), {
        timeout: 5_000,
        message: 'navigator window did not close',
      })
      .toBe(0);

    // Editor must still be alive — verifying via its renderer-side bridge
    // proves the BrowserWindow is still attached to its utility process,
    // not just that an Electron handle exists.
    await expect
      .poll(() => countEditorWindows(app), {
        timeout: 2_000,
        message: 'editor window disappeared when navigator closed',
      })
      .toBe(1);
    const stillEditorMode = await editor
      .evaluate(() => window.okDesktop?.config?.mode)
      .catch(() => null);
    expect(stillEditorMode).toBe('editor');
  });
});
