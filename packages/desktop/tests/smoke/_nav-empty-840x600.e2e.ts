
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
const SHOT_DIR = resolve(__dirname, '..', '..', 'tmp');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function seedEmptyHome(prefix: string): string {
  const tmpHome = mkdtempSync(join(tmpdir(), `ok-navempty-${prefix}-`));
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
  return tmpHome;
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
    timeout: 30_000,
    env: { ...process.env, HOME: tmpHome, OK_DESKTOP_E2E_SMOKE: '1' },
  });
}

async function findNavigator(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const m = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (m === 'navigator') return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: 'navigator window did not appear (cold launch)' },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === 'navigator') return page;
  }
  throw new Error('navigator window vanished');
}

function rmSafe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
  }
}

test.describe('Navigator empty-state screenshot (dev-only)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop".`);

  test('capture empty Navigator at 840x600', async ({ captureStderrFor }) => {
    test.setTimeout(90_000);
    mkdirSync(SHOT_DIR, { recursive: true });
    const tmpHome = seedEmptyHome('shot');
    try {
      const app = await launchApp(tmpHome);
      captureStderrFor(app);

      const nav = await findNavigator(app);
      const winHandle: JSHandle = await app.browserWindow(nav);
      await winHandle.evaluate((win: unknown) => {
        const b = win as {
          setBounds: (r: { width: number; height: number }) => void;
          center: () => void;
        };
        b.setBounds({ width: 840, height: 600 });
        b.center();
      });
      await nav.waitForTimeout(1000);
      const outPath = join(SHOT_DIR, 'nav-shot-empty-840x600.png');
      await nav.screenshot({ path: outPath });
      // eslint-disable-next-line no-console
      console.log(`captured empty 840x600 -> ${outPath}`);
    } finally {
      rmSafe(tmpHome);
    }
  });
});
