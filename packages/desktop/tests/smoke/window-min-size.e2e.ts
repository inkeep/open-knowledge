/**
 * Runtime verification that Electron actually applies the `minWidth` /
 * `minHeight` configured on the Editor and Navigator BrowserWindow
 * constructors. The Bun-native unit test in
 * `src/main/window-min-size.test.ts` pins the source-code wiring; this
 * smoke test proves Electron honors that wiring at runtime by reading
 * `BrowserWindow.getMinimumSize()` from main-process context.
 *
 * Pattern mirrors `navigator-return.e2e.ts`:
 *   - Seed a tmp HOME with `lastOpenedProject` so the Editor window opens
 *     first (Navigator stays closed).
 *   - Launch with `--user-data-dir=<tmpHome>/electron-userdata`.
 *   - Find Editor window, read its `getMinimumSize()`.
 *   - Trigger Navigator via `window.okDesktop?.navigator.open()` from the
 *     editor renderer.
 *   - Find Navigator window, read its `getMinimumSize()`.
 *
 * Skip gates (same as the rest of the smoke suite):
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in.
 *   - `process.platform !== 'darwin'` — darwin-only.
 *   - `out/main/index.js` missing — `bun run build:desktop` must have run.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { WINDOW_MIN_SIZE } from '../../src/main/window-min-size.ts';
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

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function seedHomeWithLastOpenedProject(prefix: string): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-window-min-${prefix}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ok-window-min-${prefix}-project-`));
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
          name: 'Window Min Smoke',
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

interface MinSizeProbe {
  minSize: [number, number];
  resizable: boolean;
}

async function readMinSizeFor(app: ElectronApplication, page: Page): Promise<MinSizeProbe> {
  const winHandle: JSHandle = await app.browserWindow(page);
  return winHandle.evaluate((win: unknown) => {
    // BrowserWindow types are not in scope inside evaluate's V8 context, but
    // getMinimumSize() / isResizable() are runtime methods on the BrowserWindow
    // wrapper Playwright hands back. The cast is local to this evaluate.
    const w = win as { getMinimumSize: () => [number, number]; isResizable: () => boolean };
    return { minSize: w.getMinimumSize(), resizable: w.isResizable() };
  });
}

test.describe('BrowserWindow min-size smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test(`Editor window enforces ${WINDOW_MIN_SIZE.EDITOR.width}x${WINDOW_MIN_SIZE.EDITOR.height} min; Navigator window enforces ${WINDOW_MIN_SIZE.NAVIGATOR.width}x${WINDOW_MIN_SIZE.NAVIGATOR.height} min`, async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject('happy');
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    // --- Editor ---
    const editor = await findWindow(app, 'editor');
    const editorProbe = await readMinSizeFor(app, editor);
    expect(editorProbe.resizable).toBe(true);
    expect(editorProbe.minSize).toEqual([
      WINDOW_MIN_SIZE.EDITOR.width,
      WINDOW_MIN_SIZE.EDITOR.height,
    ]);

    // --- Navigator ---
    // Trigger from the editor renderer; Navigator stays closed otherwise
    // because `lastOpenedProject` was seeded.
    await editor.evaluate(async () => {
      await window.okDesktop?.navigator.open();
    });
    const navigator = await findWindow(app, 'navigator');
    const navigatorProbe = await readMinSizeFor(app, navigator);
    expect(navigatorProbe.resizable).toBe(true);
    expect(navigatorProbe.minSize).toEqual([
      WINDOW_MIN_SIZE.NAVIGATOR.width,
      WINDOW_MIN_SIZE.NAVIGATOR.height,
    ]);
  });
});
