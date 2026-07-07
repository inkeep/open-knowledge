/**
 * Project Navigator close-on-open smoke test — drives an Electron launch
 * with or without `lastOpenedProject`, then triggers `bridge.project.open()`
 * via the appropriate renderer and asserts the Navigator window state
 * matches the spec on success, on the Switch-Project flow, and on failure.
 *
 * Coverage:
 *   1. Happy path — cold-boot Navigator → pick → editor appears → Navigator
 *      disappears → editor is the only window remaining.
 *   2. Switch-Project flow — Editor A boots from `lastOpenedProject` →
 *      `bridge.navigator.open()` summons Navigator → pick Project B →
 *      Editor B appears → Navigator closes → Editor A remains alive.
 *   3. Failure path — Navigator picks a non-existent directory;
 *      `createProjectWindow` rejects with `MissingOkConfigError`, the error
 *      dialog is replaced with a tracking mock that records calls and the
 *      title, the Navigator stays visible for recovery, and the mock
 *      confirms the user-facing failure signal fired with the expected
 *      title (regression guard against the close call leaking into the
 *      failure branch and against silent removal of the dialog).
 *
 * Skip gates mirror the rest of the smoke harness:
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in.
 *   - `process.platform !== 'darwin'` — darwin-only in v0.
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
  projectDir: string;
}

interface SeededHomeWithEditor {
  tmpHome: string;
  projectAPath: string;
  projectBPath: string;
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

function createProjectDir(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-project-`));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  return projectDir;
}

function seedHomeWithoutLastOpenedProject(prefix: string): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-`));
  const projectDir = createProjectDir(prefix);
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [],
      lastOpenedProject: null,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectDir };
}

function seedHomeWithLastOpenedProjectAndExtra(prefix: string): SeededHomeWithEditor {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navigator-close-${prefix}-`));
  const projectAPath = createProjectDir(`${prefix}-A`);
  const projectBPath = createProjectDir(`${prefix}-B`);
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        {
          path: projectAPath,
          name: 'Project A',
          lastOpenedAt: new Date().toISOString(),
        },
      ],
      lastOpenedProject: projectAPath,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, projectAPath, projectBPath };
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

async function countWindowsByMode(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
): Promise<number> {
  let count = 0;
  for (const page of app.windows()) {
    const observed = await page
      .evaluate(() => window.okDesktop?.config?.mode)
      .catch(() => undefined);
    if (observed === mode) count++;
  }
  return count;
}

async function findFirstWindowByMode(
  app: ElectronApplication,
  mode: 'editor' | 'navigator',
): Promise<Page> {
  for (const page of app.windows()) {
    const observed = await page
      .evaluate(() => window.okDesktop?.config?.mode)
      .catch(() => undefined);
    if (observed === mode) return page;
  }
  throw new Error(`${mode} window vanished between poll resolution and read`);
}

test.describe('Project Navigator close-on-project-open smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('Navigator boots first, closes once a project window resolves', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('happy');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    // Navigator must boot first because no `lastOpenedProject` is seeded.
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    // No editor window yet — pre-pick state.
    expect(await countWindowsByMode(app, 'editor')).toBe(0);

    // Trigger the project-open IPC from the Navigator renderer.
    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({ path, target: 'new-window', entryPoint: 'recents' });
    }, projectDir);

    // Editor window must appear.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'editor window did not appear after project.open()',
      })
      .toBe(1);

    // Navigator must close once the editor is real (close fires inside
    // `openProject` after `createProjectWindow` resolves).
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 10_000,
        message: 'navigator window did not close after project window resolved',
      })
      .toBe(0);

    // Final state: exactly one window, and it's the editor.
    expect(await countWindowsByMode(app, 'editor')).toBe(1);
    expect(await countWindowsByMode(app, 'navigator')).toBe(0);
  });

  test('Switch-Project flow: Editor A summons Navigator, picks Project B, both editors persist', async ({
    captureStderrFor,
  }) => {
    // Seeded state: Project A is `lastOpenedProject` so Editor A boots first
    // (no Navigator at cold launch). Project B exists on disk but is not in
    // recents — the pick exercises the same `bridge.project.open` IPC path
    // as recents click / Open Folder / Clone — one rule covers all four
    // pick surfaces.
    const { tmpHome, projectAPath, projectBPath } = seedHomeWithLastOpenedProjectAndExtra('switch');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectAPath, projectBPath] });

    // Editor A appears from `lastOpenedProject`; Navigator must NOT spawn.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'Editor A did not appear from lastOpenedProject',
      })
      .toBe(1);
    const editorA = await findFirstWindowByMode(app, 'editor');
    expect(await countWindowsByMode(app, 'navigator')).toBe(0);

    // Editor A summons Navigator via the bridge (sidebar pill / File menu /
    // Command Palette all route through the same IPC channel; this test
    // exercises the contract, not the affordance UI).
    await editorA.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 15_000,
        message: 'navigator window did not appear after bridge.navigator.open()',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    // Pick Project B from the now-summoned Navigator.
    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({ path, target: 'new-window', entryPoint: 'recents' });
    }, projectBPath);

    // Editor B must appear (total editor count climbs to 2).
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
        message: 'Editor B did not appear after Navigator picked Project B',
      })
      .toBe(2);

    // Navigator must close after Editor B is real — same `openProject`
    // close call that fires in the cold-boot happy path. The close logic
    // must not be conditional on how Navigator was spawned.
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 10_000,
        message: 'navigator window did not close after Project B opened',
      })
      .toBe(0);

    // Editor A must still be alive — the close must not leak into the
    // summoning editor. `isClosed()` is false when the BrowserWindow /
    // renderer is still attached.
    expect(editorA.isClosed()).toBe(false);
    expect(await countWindowsByMode(app, 'editor')).toBe(2);
  });

  test('Navigator stays visible when project open fails', async ({ captureStderrFor }) => {
    const { tmpHome, projectDir } = seedHomeWithoutLastOpenedProject('failure');
    // A nonexistent path reliably fails the admission funnel:
    // discoverProject's realpathSync throws ENOENT, returning
    // kind:'rejected'. The rejected branch in openProject fires
    // dialog.showErrorBox('Cannot open this folder', …) + openNavigator()
    // — the Navigator stays visible failure-UX path this test asserts on.
    // The consent-dialog branch (kind:'fresh') is NOT exercised here
    // because await requestUserConsent would block waiting on a renderer
    // confirm/cancel that the test doesn't simulate.
    const bogusProjectPath = join(tmpHome, 'does-not-exist');
    const app = await launchApp(tmpHome);
    // captureStderrFor subscribes to stdio BEFORE the first await on app
    // behavior so chrome-modernization show-gate / whenReady warns are
    // captured. Attaches as `main-process-stderr` artifact on test end —
    // see _helpers/smoke-test.ts (fixture).
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    // Navigator boots first because no `lastOpenedProject` is seeded.
    await expect
      .poll(() => countWindowsByMode(app, 'navigator'), {
        timeout: 20_000,
        message: 'navigator window did not appear at cold boot',
      })
      .toBe(1);
    const navigator = await findFirstWindowByMode(app, 'navigator');

    // Replace the modal error dialog with a tracking mock — the real
    // `dialog.showErrorBox` blocks the main process on macOS until the
    // user dismisses it, which would hang the IPC response. The mock
    // captures the title so the test can assert the user-facing error
    // surface, not just that some dialog fired. Without title-assertion,
    // a regression that swapped the dialog title to something misleading,
    // or that triggered `showErrorBox` from an unrelated code path, would
    // still pass.
    await app.evaluate(({ dialog }) => {
      const wrapped = dialog as unknown as {
        __showErrorBoxCalls?: number;
        __lastErrorTitle?: string;
        showErrorBox: (t: string, c: string) => void;
      };
      wrapped.__showErrorBoxCalls = 0;
      wrapped.__lastErrorTitle = undefined;
      wrapped.showErrorBox = (title) => {
        wrapped.__showErrorBoxCalls = (wrapped.__showErrorBoxCalls ?? 0) + 1;
        wrapped.__lastErrorTitle = title;
      };
    });

    // Trigger the bad-path open. discoverProject's realpathSync throws
    // ENOENT on the missing path; openProject's rejected branch fires
    // the (now-mocked) error dialog and re-opens Navigator (no-op
    // because it is already open). entryPoint can be any value — the
    // rejected branch fires before entry-point-specific dispatch, so
    // 'recents' is the most natural choice (Navigator-initiated open).
    await navigator.evaluate(async (path) => {
      await window.okDesktop?.project.open({
        path,
        target: 'new-window',
        entryPoint: 'recents',
      });
    }, bogusProjectPath);

    // Navigator must remain visible across the post-failure poll window.
    // Editor count must stay 0 — the close call must not leak into the
    // failure branch and the spawn must not have produced an editor. A
    // 10s window strengthens the negative assertion on a loaded CI runner.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 10_000,
        message: 'editor window appeared even though project.open() failed',
      })
      .toBe(0);
    expect(await countWindowsByMode(app, 'navigator')).toBe(1);

    // The error dialog must have fired with the expected user-facing
    // title — proves the failure signal reached the user and that the
    // dialog wasn't triggered from an unrelated code path.
    const dialogState = await app.evaluate(({ dialog }) => {
      const wrapped = dialog as unknown as {
        __showErrorBoxCalls?: number;
        __lastErrorTitle?: string;
      };
      return {
        calls: wrapped.__showErrorBoxCalls ?? 0,
        title: wrapped.__lastErrorTitle,
      };
    });
    expect(dialogState.calls).toBeGreaterThan(0);
    expect(dialogState.title).toBe('Cannot open this folder');
  });
});
